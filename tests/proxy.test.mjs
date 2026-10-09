/**
 * 模型请求的代理路由（src/config/proxy.ts）。
 *
 * 纯单元测试：不联网、不碰真实主目录。
 * config.ts / proxy.ts 在模块加载时按 homedir() 定位 ~/.pageqa，所以必须在**动态 import
 * 之前**把 HOME/USERPROFILE 指到临时目录——否则测试会往用户主目录里写 proxy.json。
 *
 * 规则匹配与配置解析是纯函数，直接断言；「走代理」那条路用一对本地 http 服务器验证
 * （假代理只回显、不转发，请求到达它就说明真的经过了 dispatcher）。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pageqa-home-"));
process.env.USERPROFILE = home;
process.env.HOME = home;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PAGEQA_PROXY_")) delete process.env[key];
}

const {
  DEFAULT_PROXY_CONFIG,
  createProxyFetch,
  ensureProxyConfigFile,
  installProxyRouting,
  isNetworkError,
  isProxyRoutingInstalled,
  loadProxyConfig,
  PROXY_CONFIG_PATH,
  proxyStatus,
  reloadProxyConfig,
  resetProxyStats,
  resolveProxyAction,
  saveProxyConfig,
  setProxyBypassed,
} = await import("../dist/config/proxy.js");

/** 本地一对服务器：目标（会被直连命中）与假代理（回显，证明请求经过了它）。 */
async function startServers() {
  const target = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("from-target");
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  let proxyHits = 0;
  const proxy = createServer((req, res) => {
    proxyHits++;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("from-proxy");
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  return {
    targetUrl: `http://127.0.0.1:${target.address().port}/v1/chat/completions`,
    proxyUrl: `http://127.0.0.1:${proxy.address().port}`,
    hits: () => proxyHits,
    close: async () => {
      await new Promise((r) => target.close(r));
      await new Promise((r) => proxy.close(r));
    },
  };
}

/** 造一个「像网络层不通」的 fetch 错误：TypeError 挂 cause，cause 上是错误码。 */
function networkFailure(code = "ECONNREFUSED") {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect failed"), { code }),
  });
}

/** 往（可能还不存在的）配置目录里写一份 proxy.json。 */
function writeProxyConfigFile(text) {
  mkdirSync(join(home, ".pageqa"), { recursive: true });
  writeFileSync(PROXY_CONFIG_PATH, text, "utf8");
}

describe("代理规则匹配", () => {
  const cfg = (rules, mode = "fallback") => ({
    proxy: "http://127.0.0.1:7890",
    enabled: true,
    mode,
    rules,
  });

  test("精确域名只匹配自己", () => {
    const c = cfg([{ match: "api.example.com", action: "proxy" }], "direct");
    assert.equal(resolveProxyAction("https://api.example.com/v1", c), "proxy");
    assert.equal(resolveProxyAction("https://other.example.com/v1", c), "direct");
  });

  test("*.example.com 覆盖裸域与任意层级子域", () => {
    const c = cfg([{ match: "*.example.com", action: "proxy" }], "direct");
    for (const host of [
      "example.com",
      "api.example.com",
      "a.b.example.com",
    ]) {
      assert.equal(resolveProxyAction(`https://${host}/v1`, c), "proxy", host);
    }
    assert.equal(resolveProxyAction("https://notexample.com/v1", c), "direct");
  });

  test("10.* 之类的前缀匹配 IP 段", () => {
    const c = cfg([{ match: "10.*,192.168.*", action: "direct" }], "proxy");
    assert.equal(resolveProxyAction("http://10.1.2.3:3000/v1", c), "direct");
    assert.equal(resolveProxyAction("http://192.168.0.9/v1", c), "direct");
    assert.equal(resolveProxyAction("http://11.0.0.1/v1", c), "proxy");
  });

  test("通配可以出现在模式中间（内网网段写作 172.2*）", () => {
    const c = cfg([{ match: "172.2*,192.168.*", action: "direct" }], "proxy");
    assert.equal(resolveProxyAction("http://172.20.0.1/v1", c), "direct");
    assert.equal(resolveProxyAction("http://172.29.0.1/v1", c), "direct");
    assert.equal(resolveProxyAction("http://192.168.1.1/v1", c), "direct");
    assert.equal(resolveProxyAction("http://172.32.0.1/v1", c), "proxy");
  });

  test("IPv6 回环：URL 里带方括号，规则里写 ::1", () => {
    const c = cfg([{ match: "::1,localhost", action: "direct" }], "proxy");
    assert.equal(resolveProxyAction("http://[::1]:3000/v1", c), "direct");
    assert.equal(resolveProxyAction("http://[2001:db8::1]:3000/v1", c), "proxy");
  });

  test("模式里的其它字符按字面量处理（不当作正则）", () => {
    const c = cfg([{ match: "a+b.com", action: "direct" }], "proxy");
    assert.equal(resolveProxyAction("https://a+b.com/x", c), "direct");
    assert.equal(resolveProxyAction("https://axb.com/x", c), "proxy");
  });

  test("逗号分隔多个模式；自上而下第一条命中者胜", () => {
    const c = cfg([
      { match: "a.com,b.com", action: "direct" },
      { match: "a.com", action: "proxy" },
    ]);
    assert.equal(resolveProxyAction("https://a.com/x", c), "direct");
    assert.equal(resolveProxyAction("https://b.com/x", c), "direct");
    assert.equal(resolveProxyAction("https://c.com/x", c), "fallback");
  });

  test("没有规则命中时用全局 mode；解析不了的 URL 直连", () => {
    assert.equal(
      resolveProxyAction("https://x.com/", cfg([{ match: "a.com", action: "proxy" }], "proxy")),
      "proxy",
    );
    assert.equal(resolveProxyAction("not a url", cfg([], "proxy")), "direct");
  });

  test("主机名大小写不影响匹配", () => {
    const c = cfg([{ match: "API.Example.com", action: "proxy" }], "direct");
    assert.equal(resolveProxyAction("https://api.example.com/v1", c), "proxy");
  });
});

describe("网络错误的识别", () => {
  test("认得挂在 cause 上的错误码（Node 的 fetch 只在 cause 里说真话）", () => {
    assert.equal(isNetworkError(networkFailure()), true);
    assert.equal(isNetworkError(new Error("boom")), false);
    assert.equal(
      isNetworkError(
        new TypeError("fetch failed", {
          cause: new AggregateError([networkFailure("ENOTFOUND")]),
        }),
      ),
      true,
    );
  });
});

describe("代理配置读取", () => {
  test("没有 proxy.json 时用内置默认：本机与内网直连、其余 fallback", () => {
    const cfg = loadProxyConfig();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.mode, "fallback");
    assert.equal(
      resolveProxyAction("http://127.0.0.1:3000/v1", cfg),
      "direct",
      "本机端点必须直连",
    );
    assert.equal(resolveProxyAction("https://api.deepseek.com/v1", cfg), "fallback");
  });

  test("proxy.json 覆盖默认；坏文件退回默认而不是让 pageqa 起不来", () => {
    writeProxyConfigFile(
      JSON.stringify({
        proxy: "http://127.0.0.1:1080",
        enabled: false,
        mode: "proxy",
        rules: [{ match: "only.com", action: "direct", comment: "唯一例外" }],
      }),
    );
    let cfg = loadProxyConfig();
    assert.equal(cfg.proxy, "http://127.0.0.1:1080");
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.mode, "proxy");
    assert.equal(resolveProxyAction("https://only.com/x", cfg), "direct");
    assert.equal(resolveProxyAction("https://other.com/x", cfg), "proxy");

    writeProxyConfigFile("{ 这不是 JSON");
    cfg = loadProxyConfig();
    assert.equal(cfg.proxy, DEFAULT_PROXY_CONFIG.proxy);
    assert.equal(cfg.rules.length, DEFAULT_PROXY_CONFIG.rules.length);
  });

  test("规则写错时不静默改道：退回默认规则，而不是变成「全部按 mode」", () => {
    writeProxyConfigFile(
      JSON.stringify({ rules: [{ match: "a.com", action: "PROXY" }] }),
    );
    const cfg = loadProxyConfig();
    assert.equal(
      resolveProxyAction("http://127.0.0.1:3000/v1", cfg),
      "direct",
      "拼错的规则不该让本机端点改走代理",
    );
  });

  test("环境变量优先级高于文件（CI 里临时换代理不必改文件）", () => {
    writeProxyConfigFile(
      JSON.stringify({ proxy: "http://127.0.0.1:1", enabled: true, mode: "direct" }),
    );
    process.env.PAGEQA_PROXY_URL = "http://127.0.0.1:7899";
    process.env.PAGEQA_PROXY_ENABLED = "false";
    process.env.PAGEQA_PROXY_MODE = "fallback";
    try {
      const cfg = loadProxyConfig();
      assert.equal(cfg.proxy, "http://127.0.0.1:7899");
      assert.equal(cfg.enabled, false);
      assert.equal(cfg.mode, "fallback");
    } finally {
      delete process.env.PAGEQA_PROXY_URL;
      delete process.env.PAGEQA_PROXY_ENABLED;
      delete process.env.PAGEQA_PROXY_MODE;
    }
  });

  test("写回只动给定字段（/proxy 面板的开关不会抹掉规则）", () => {
    writeProxyConfigFile(
      JSON.stringify({ proxy: "http://127.0.0.1:1080", enabled: true, rules: [{ match: "x.com", action: "direct" }] }),
    );
    const saved = saveProxyConfig({ enabled: false });
    assert.equal(saved.enabled, false);
    const onDisk = JSON.parse(readFileSync(PROXY_CONFIG_PATH, "utf8"));
    assert.equal(onDisk.proxy, "http://127.0.0.1:1080");
    assert.equal(onDisk.rules.length, 1);
  });

  test("--init-config 用的模板只在缺文件时创建", () => {
    rmSync(PROXY_CONFIG_PATH, { force: true });
    const first = ensureProxyConfigFile();
    assert.equal(first.created, true);
    assert.ok(existsSync(PROXY_CONFIG_PATH));
    const second = ensureProxyConfigFile();
    assert.equal(second.created, false);
  });
});

describe("带路由的 fetch", () => {
  let servers;
  before(async () => {
    servers = await startServers();
  });
  after(async () => {
    await servers.close();
  });

  /** 记下调用参数的假 fetch（直连路径用它，避免真的联网）。 */
  const recorder = () => {
    const calls = [];
    const fn = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response("ok");
    };
    fn.calls = calls;
    return fn;
  };

  test("direct 规则：原样直连，且不带 dispatcher", async () => {
    resetProxyStats();
    const base = recorder();
    const fetch2 = createProxyFetch(
      base,
      () => ({ proxy: servers.proxyUrl, enabled: true, mode: "fallback", rules: [{ match: "127.0.0.1", action: "direct" }] }),
      () => false,
    );
    const res = await fetch2(servers.targetUrl);
    assert.equal(await res.text(), "ok");
    assert.equal(base.calls.length, 1);
    assert.equal(base.calls[0].init?.dispatcher, undefined);
    assert.equal(proxyStatus().stats.direct, 1);
  });

  test("proxy 规则：请求确实经过代理服务器", async () => {
    const before = servers.hits();
    const fetch2 = createProxyFetch(
      recorder(),
      () => ({ proxy: servers.proxyUrl, enabled: true, mode: "proxy", rules: [] }),
      () => false,
    );
    const res = await fetch2(servers.targetUrl);
    assert.equal(await res.text(), "from-proxy");
    assert.equal(servers.hits(), before + 1);
  });

  test("fallback：直连失败后改走代理（成功）", async () => {
    const before = servers.hits();
    let attempts = 0;
    const base = async () => {
      attempts++;
      throw networkFailure();
    };
    const fetch2 = createProxyFetch(
      base,
      () => ({ proxy: servers.proxyUrl, enabled: true, mode: "fallback", rules: [] }),
      () => false,
    );
    const res = await fetch2(servers.targetUrl);
    assert.equal(await res.text(), "from-proxy");
    assert.equal(attempts, 1, "只直连一次");
    assert.equal(servers.hits(), before + 1);
  });

  test("fallback：非网络错误原样抛出，不拿代理再试一次", async () => {
    const before = servers.hits();
    const fetch2 = createProxyFetch(
      async () => {
        throw new Error("boom");
      },
      () => ({ proxy: servers.proxyUrl, enabled: true, mode: "fallback", rules: [] }),
      () => false,
    );
    await assert.rejects(() => fetch2(servers.targetUrl), /boom/);
    assert.equal(servers.hits(), before, "不该打代理");
  });

  test("总开关关闭 / 会话临时直连：一律直连", async () => {
    const before = servers.hits();
    const rules = [{ match: "*", action: "proxy" }];
    for (const scenario of [
      { enabled: false, off: false },
      { enabled: true, off: true },
    ]) {
      const base = recorder();
      const fetch2 = createProxyFetch(
        base,
        () => ({ proxy: servers.proxyUrl, enabled: scenario.enabled, mode: "proxy", rules }),
        () => scenario.off,
      );
      await fetch2(servers.targetUrl);
      assert.equal(base.calls.length, 1, JSON.stringify(scenario));
    }
    assert.equal(servers.hits(), before);
  });
});

describe("全局装配", () => {
  test("幂等：重复安装只换一次 fetch，还原后复原", () => {
    const original = globalThis.fetch;
    const restore = installProxyRouting();
    assert.equal(isProxyRoutingInstalled(), true);
    const patched = globalThis.fetch;
    assert.notEqual(patched, original);
    installProxyRouting();
    assert.equal(globalThis.fetch, patched, "第二次安装不应再包一层");
    restore();
    assert.equal(globalThis.fetch, original);
    assert.equal(isProxyRoutingInstalled(), false);
  });

  test("会话临时直连只改运行期状态，不写配置文件", () => {
    setProxyBypassed(true);
    assert.equal(proxyStatus().bypassed, true);
    assert.equal(proxyStatus().active, false);
    setProxyBypassed(false);
    assert.equal(proxyStatus().bypassed, false);
    const onDiskBefore = existsSync(PROXY_CONFIG_PATH)
      ? readFileSync(PROXY_CONFIG_PATH, "utf8")
      : null;
    reloadProxyConfig();
    assert.equal(
      existsSync(PROXY_CONFIG_PATH) ? readFileSync(PROXY_CONFIG_PATH, "utf8") : null,
      onDiskBefore,
    );
  });
});

/**
 * 端到端：pi-ai 的模型请求（OpenAI SDK）真的经过代理。
 *
 * 这一条守住的是整个方案的关键假设——「替换 `globalThis.fetch` 就能覆盖 SDK 客户端」。
 * pi-ai 在**每次请求时**才构造 SDK 客户端，客户端取的正是当时的 `globalThis.fetch`；
 * 哪天它改成缓存客户端（或 provider 换了别的 HTTP 实现），这个假设就会失灵，
 * 而症状是「代理配了没反应」这种极难定位的东西。
 *
 * 假代理冒充 OpenAI 兼容端点，用 SSE 回答：探活能返回 ok，说明流式响应也照常解析
 * （走代理的 undici fetch 与内置 fetch 是两套实现，流式是最容易出问题的地方）。
 */
describe("模型请求端到端走代理", () => {
  test("探活请求到达代理，而不是直连端点", async () => {
    const sse = [
      'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"e2e-model",' +
        '"choices":[{"index":0,"delta":{"role":"assistant","content":"pong"},"finish_reason":null}]}',
      'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"e2e-model",' +
        '"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");

    let targetHits = 0;
    const target = createServer((_req, res) => {
      targetHits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "should not be reached" }));
    });
    await new Promise((r) => target.listen(0, "127.0.0.1", r));

    let proxyHits = 0;
    const proxy = createServer((_req, res) => {
      proxyHits++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse);
    });
    await new Promise((r) => proxy.listen(0, "127.0.0.1", r));

    process.env.PAGEQA_LLM_BASE_URL = `http://127.0.0.1:${target.address().port}/v1`;
    process.env.PAGEQA_LLM_API_KEY = "e2e-key";
    process.env.PAGEQA_LLM_MODEL = "e2e-model";
    process.env.PAGEQA_PROXY_URL = `http://127.0.0.1:${proxy.address().port}`;
    process.env.PAGEQA_PROXY_MODE = "proxy";
    process.env.PAGEQA_PROXY_ENABLED = "true";
    // 默认规则让 127.0.0.1 直连（那正是它的本意）；这里清空规则以断言「全部走代理」。
    writeProxyConfigFile(JSON.stringify({ rules: [] }));
    reloadProxyConfig();
    resetProxyStats();

    const restore = installProxyRouting();
    try {
      const { createModelCatalog, probeModel } = await import("../dist/config/models.js");
      const catalog = await createModelCatalog();
      const model = catalog.models.getModel("pageqa", "e2e-model");
      const result = await probeModel(catalog, model);

      assert.deepEqual(result, { ok: true });
      assert.equal(proxyHits, 1, "请求应到达代理");
      assert.equal(targetHits, 0, "直连端点不该被访问");
      assert.equal(proxyStatus().stats.proxy, 1);
    } finally {
      restore();
      target.close();
      proxy.close();
      for (const key of [
        "PAGEQA_LLM_BASE_URL",
        "PAGEQA_LLM_API_KEY",
        "PAGEQA_LLM_MODEL",
        "PAGEQA_PROXY_URL",
        "PAGEQA_PROXY_MODE",
        "PAGEQA_PROXY_ENABLED",
      ]) {
        delete process.env[key];
      }
      reloadProxyConfig();
    }
  });
});
