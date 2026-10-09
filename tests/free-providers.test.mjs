import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 纯单元测试：不联网、不登录、不碰真实主目录。
//
// 免费网关的目录刷新会打各网关的 `/v1/models`，这里把 globalThis.fetch 换成打桩——
// 一是让断言可复现，二是守住「失败就回落快照」这条路径（真实网关时好时坏）。
const home = mkdtempSync(join(tmpdir(), "pageqa-home-"));
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.PAGEQA_LLM_PROVIDER = "pageqa";
process.env.PAGEQA_LLM_MODEL = "unit-test-model";
process.env.PAGEQA_LLM_BASE_URL = "http://127.0.0.1:9/v1";
process.env.PAGEQA_LLM_API_KEY = "unit-test-key";
process.env.PAGEQA_LOCALE = "zh";
// 清掉可能从父进程继承的网关 key，避免「需key 的网关意外可见」这条断言被环境干扰。
for (const key of ["CLINE_API_KEY", "LLM7_API_KEY", "FASTROUTER_API_KEY"]) {
  delete process.env[key];
}

const {
  createModelCatalog,
  listLoginOptions,
  listModelOptions,
  loadBuiltinProviders,
  refreshFreeProviders,
  resolveModel,
  PAGEQA_PROVIDER_ID,
} = await import("../dist/models.js");
const {
  FREE_PROVIDER_IDS,
  isFreeProvider,
  createFreeProviders,
  createOpencodeFreeGateTools,
} = await import("../dist/free-providers.js");

/** 不配任何凭据就该出现在 /model 的网关。 */
const VISIBLE_WITHOUT_CREDENTIALS = ["cline", "fastrouter", "llm7", "opencode-free"];
/** 必须配 key 才出现的网关。 */
const KEY_REQUIRED = ["kilo", "orcarouter", "xkiro"];
/** 走浏览器登录（OAuth）的网关。 */
const OAUTH = ["cline", "kilo"];
/** Zen 免费层的工具指纹：请求里必须同时带上这五个小写工具名。 */
const GATE_TOOLS = ["bash", "edit", "glob", "grep", "read"];

/** 与 model-catalog.test.mjs 同款：pi-ai 的 CredentialStore 只有 4 个方法。 */
function memoryCredentials() {
  const data = new Map();
  return {
    async read(providerId) {
      return data.get(providerId);
    },
    async list() {
      return [...data.entries()].map(([providerId, c]) => ({
        providerId,
        type: c.type,
      }));
    },
    async modify(providerId, fn) {
      const next = await fn(data.get(providerId));
      if (next === undefined) return data.get(providerId);
      data.set(providerId, next);
      return next;
    },
    async delete(providerId) {
      data.delete(providerId);
    },
  };
}

/** 同款替身，但预置一条已登录的 OAuth 凭据。 */
function oauthCredentials(providerId) {
  const store = memoryCredentials();
  return {
    ...store,
    async read(id) {
      return id === providerId
        ? {
            type: "oauth",
            access: "oauth-access-token",
            refresh: "oauth-refresh-token",
            expires: Date.now() + 3600_000,
          }
        : undefined;
    },
  };
}

/** 构造一个注册好免费网关的目录（等价于交互模式打开 /model 之前的那一步）。 */
async function catalogWithFreeProviders() {
  const catalog = await createModelCatalog({ credentials: memoryCredentials() });
  await loadBuiltinProviders(catalog);
  return catalog;
}

/**
 * 打桩 fetch：按 `<baseUrl>/models` 返回给定的目录，其它一律 404。
 *
 * 值的形态：模型 id 数组 → OpenAI 风格的 `{data:[{id}]}`；
 * `{ __raw: [条目…] }` → 原样条目（带 `isFree` 这类额外字段）；
 * `{ __strings: [id…] }` → 裸字符串数组（OpenCode Zen 的目录就是这样）。
 * 返回值记录每个被请求的 URL，供「刷新只打 /models」这类断言使用。
 */
function stubCatalogs(map) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    calls.push(href);
    const value = map[href];
    if (!value) {
      return new Response("not found", { status: 404 });
    }
    const data = Array.isArray(value)
      ? value.map((id) => ({ id }))
      : (value.__raw ?? value.__strings);
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/**
 * 打桩 fetch，但把回环地址（127.0.0.1）交回真实实现——Cline 的登录回调要真的打通。
 *
 * handler 收到的 `href` 是去掉查询串的 URL：授权请求带一串查询参数，按整串比对很容易写错。
 */
function stubWithLoopbackPassthrough(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const href = String(input);
    if (href.startsWith("http://127.0.0.1:")) return await original(input, init);
    const url = new URL(href);
    return await handler(url.origin + url.pathname, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

/** 轮询到有服务在监听为止，再把授权码送到它的回环回调。 */
async function deliverClineCallback(query, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    for (let port = 48801; port <= 48811; port++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/auth?${query}`);
        if (res.status === 200) return { port, html: await res.text() };
      } catch {
        // 该端口没人监听：继续试下一个。
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("回环回调端口一直没起来");
}

/** 造一个 pi-ai 的登录交互替身：记录事件、拒绝任何提问。 */
function fakeInteraction(events) {
  return {
    signal: new AbortController().signal,
    prompt: async () => {
      throw new Error("这两个流程都不该提问");
    },
    notify: (event) => events.push(event),
  };
}

after(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("免费网关目录", () => {
  test("FREE_PROVIDER_IDS 就是这批网关，且 isFreeProvider 与之一致", () => {
    assert.deepEqual(
      [...FREE_PROVIDER_IDS].sort(),
      ["cline", "fastrouter", "kilo", "llm7", "opencode-free", "orcarouter", "xkiro"],
    );
    assert.equal(isFreeProvider("cline"), true);
    assert.equal(isFreeProvider(PAGEQA_PROVIDER_ID), false);
    assert.equal(isFreeProvider("anthropic"), false);
  });

  test("每个网关都带baseUrl、OpenAI 兼容 api 与快照模型", () => {
    const providers = createFreeProviders();
    const byId = new Map(providers.map((p) => [p.id, p]));
    assert.equal(providers.length, FREE_PROVIDER_IDS.size);
    assert.equal(byId.get("cline").baseUrl, "https://api.cline.bot/api/v1");
    assert.equal(byId.get("llm7").baseUrl, "https://api.llm7.io/v1");
    assert.equal(byId.get("fastrouter").baseUrl, "https://api.fastrouter.ai/api/v1");
    assert.equal(byId.get("orcarouter").baseUrl, "https://api.orcarouter.ai/v1");
    assert.equal(byId.get("xkiro").baseUrl, "https://api.xkiro.com/v1");
    assert.equal(byId.get("kilo").baseUrl, "https://api.kilo.ai/api/gateway");

    // 快照是断网时的兜底，因此每个网关都必须非空。
    for (const provider of providers) {
      assert.ok(provider.getModels().length > 0, provider.id + " 快照为空");
    }
    // llm7 只认两个精选 selector：不能把命名带 :free 的付费路由放进来。
    assert.deepEqual(
      byId.get("llm7").getModels().map((m) => m.id).sort(),
      ["default", "fast"],
    );
  });

  test("Kilo 关掉流式用量，并如实报自己的归因头（不冒充客户端）", () => {
    const kilo = createFreeProviders().find((p) => p.id === "kilo");
    const [model] = kilo.getModels();
    // 网关不发 stream_options，照默认设置发过去会 400。
    assert.equal(model.compat.supportsUsageInStreaming, false);
    assert.equal(model.headers["X-KILOCODE-EDITORNAME"], "pageqa");
    assert.equal(model.headers["User-Agent"], undefined);
  });

  test("Cline 的模型带身份头（网关按客户端身份放行，缺头会 403）", () => {
    const cline = createFreeProviders().find((p) => p.id === "cline");
    const [model] = cline.getModels();
    assert.equal(model.headers["User-Agent"], "Cline/4.1.10");
    assert.equal(model.headers["X-Task-ID"].length, 26);
    assert.equal(model.headers["X-CLIENT-TYPE"], "VSCode Extension");
    // 非 Cline 网关不该背这套头。
    const llm7 = createFreeProviders().find((p) => p.id === "llm7");
    assert.equal(llm7.getModels()[0].headers, undefined);
  });

  test("网关模型的窗口/输出上限是声明值，不是各家的真实上限", () => {
    const model = createFreeProviders()
      .find((p) => p.id === "xkiro")
      .getModels()[0];
    assert.equal(model.contextWindow, 128000);
    assert.equal(model.maxTokens, 32000);
    assert.equal(model.api, "openai-completions");
    assert.equal(model.baseUrl, "https://api.xkiro.com/v1");
  });
});

describe("免费网关在 /model 里的可见性", () => {
  test("免登录的网关无凭据也列出，需 key 的网关不列出", async () => {
    const catalog = await catalogWithFreeProviders();
    const options = await listModelOptions(catalog);
    const providers = new Set(options.map((o) => o.provider));
    // 目录公开、聊天免密：藏起来等于没人知道它们存在（与 pi-free 同一口径）。
    for (const id of VISIBLE_WITHOUT_CREDENTIALS) {
      assert.ok(providers.has(id), id + " 未配凭据也该出现在 /model");
    }
    // 没有凭据就发不出请求，因此按内置 provider 的同一规则过滤掉。
    for (const id of KEY_REQUIRED) {
      assert.equal(providers.has(id), false, id + " 无凭据时不该出现");
    }
  });

  test("配了 key 之后需 key 的网关出现在 /model", async () => {
    process.env.ORCAROUTER_API_KEY = "orcarouter-test-key";
    process.env.XKIRO_API_KEY = "xkiro-test-key";
    process.env.KILO_API_KEY = "kilo-test-key";
    try {
      const catalog = await catalogWithFreeProviders();
      const options = await listModelOptions(catalog);
      const providers = new Set(options.map((o) => o.provider));
      for (const id of KEY_REQUIRED) {
        assert.ok(providers.has(id), id + " 配了 key 就该出现");
      }
      assert.ok(resolveModel(catalog, { provider: "xkiro", model: "qwen/qwen3.5-397b-a17b:free" }));
    } finally {
      delete process.env.ORCAROUTER_API_KEY;
      delete process.env.XKIRO_API_KEY;
      delete process.env.KILO_API_KEY;
    }
  });

  test("OAuth 凭据同样算「已配置」，不需要再配环境变量", async () => {
    // 存的是 oauth 类型凭据，走 oauth.toAuth 那条路，与 apiKey 那条互不相干。
    const catalog = await createModelCatalog({ credentials: oauthCredentials("kilo") });
    await loadBuiltinProviders(catalog);
    assert.ok(await catalog.models.checkAuth("kilo"));
    const oauthed = await listModelOptions(catalog);
    assert.ok(oauthed.some((o) => o.provider === "kilo"));
    // 没有 key 也没有 OAuth 凭据的网关仍然不出现——OAuth 不是万能钥匙。
    assert.ok(!oauthed.some((o) => o.provider === "xkiro"));
  });

  test("免费标记只打在免费网关上", async () => {
    const catalog = await catalogWithFreeProviders();
    const options = await listModelOptions(catalog);
    const free = options.filter((o) => o.free).map((o) => o.provider);
    assert.deepEqual([...new Set(free)].sort(), VISIBLE_WITHOUT_CREDENTIALS);
    assert.equal(options.find((o) => o.provider === PAGEQA_PROVIDER_ID).free, false);
  });

  test("/login 列出可登录的方式：cline/kilo 有 OAuth；opencode-free 不出现（无凭据可配）", async () => {
    const catalog = await catalogWithFreeProviders();
    const options = await listLoginOptions(catalog);
    for (const id of FREE_PROVIDER_IDS) {
      const types = options.filter((o) => o.provider === id).map((o) => o.type).sort();
      // opencode-free 走固定匿名 bearer，没有「需要你提供凭据」的那一步。
      const expected = id === "opencode-free"
        ? []
        : OAUTH.includes(id)
          ? ["api_key", "oauth"]
          : ["api_key"];
      assert.deepEqual(types, expected, id + " 的登录方式不对");
    }
    // 匿名/固定 bearer 的网关 resolve 得出来，因此显示「已登录」——
    // 这与它们免 key 也能用是同一件事，不该让用户以为还得配什么。
    for (const id of VISIBLE_WITHOUT_CREDENTIALS.filter((x) => x !== "opencode-free")) {
      assert.ok(
        options.filter((o) => o.provider === id).every((o) => o.configured),
        id + " 应视为已配置",
      );
    }
    for (const id of KEY_REQUIRED) {
      assert.ok(
        options.filter((o) => o.provider === id).every((o) => !o.configured),
        id + " 没凭据时应显示未配置",
      );
    }
  });
});

describe("免费网关的动态目录", () => {
  test("刷新补入新出现的免费模型，并滤掉付费模型", async () => {
    const stub = stubCatalogs({
      "https://api.orcarouter.ai/v1/models": [
        "deepseek/deepseek-v4-flash-free",
        "deepseek/deepseek-v4-flash",
        "tencent/hy3-free",
        "z-ai/glm-5.3-flash-free",
        "vendor/paid-model",
      ],
      "https://api.xkiro.com/v1/models": [
        "deepseek/deepseek-v4.1-flash:free",
        "vendor/paid-model",
      ],
    });
    process.env.ORCAROUTER_API_KEY = "orcarouter-test-key";
    process.env.XKIRO_API_KEY = "xkiro-test-key";
    try {
      const catalog = await catalogWithFreeProviders();
      const errors = await refreshFreeProviders(catalog);
      // 打桩里只给了 orcarouter / xkiro，因此只有它们必须一次成功。
      assert.equal(errors.has("orcarouter"), false);
      assert.equal(errors.has("xkiro"), false);

      const orca = catalog.models.getModels("orcarouter").map((m) => m.id);
      assert.ok(orca.includes("vendor/paid-model") === false);
      // 快照里的三条都还在（动态目录是叠加，不是替换）。
      assert.ok(orca.includes("orcarouter/free"));
      assert.ok(orca.includes("deepseek/deepseek-v4-flash-free"));

      const xkiro = catalog.models.getModels("xkiro").map((m) => m.id);
      assert.ok(xkiro.includes("vendor/paid-model") === false);
      assert.ok(xkiro.includes("deepseek/deepseek-v4.1-flash:free"));

      // 只打 /models：不接受 key 的网关（cline/llm7/fastrouter）也在刷新之列——
      // 它们的目录公开，正是「不配key 也能看到新模型」的关键。
      assert.ok(stub.calls.includes("https://api.cline.bot/api/v1/models"));
    } finally {
      stub.restore();
      delete process.env.ORCAROUTER_API_KEY;
      delete process.env.XKIRO_API_KEY;
    }
  });

  test("llm7 的动态目录只认 selector，不按命名规律放行", async () => {
    const stub = stubCatalogs({
      "https://api.llm7.io/v1/models": ["default", "fast", "some-vendor/model:free"],
    });
    try {
      const catalog = await catalogWithFreeProviders();
      await refreshFreeProviders(catalog);
      const ids = catalog.models.getModels("llm7").map((m) => m.id);
      assert.deepEqual(ids.sort(), ["default", "fast"]);
    } finally {
      stub.restore();
    }
  });

  test("刷新失败不抛错，目录回落快照", async () => {
    // 空打桩 = 所有网关都404，正是「断网/被墙/网关改了目录」的等价情形。
    const stub = stubCatalogs({});
    try {
      const catalog = await catalogWithFreeProviders();
      const errors = await refreshFreeProviders(catalog);
      // 失败被收进 errors 而不是抛出：调用方据此不阻断运行。
      assert.ok(errors.size > 0);
      const options = await listModelOptions(catalog);
      assert.ok(options.some((o) => o.provider === "cline"));
      assert.ok(options.some((o) => o.provider === "llm7"));
    } finally {
      stub.restore();
    }
  });

  test("非 2xx 响应视为刷新失败（目录结构不对时也不会把空列表写进去）", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("<html>maintenance</html>", { status: 503 });
    try {
      const catalog = await catalogWithFreeProviders();
      const errors = await refreshFreeProviders(catalog);
      assert.ok(errors.has("cline"));
      assert.ok(catalog.models.getModels("cline").length > 0);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("opencode-free 的目录是裸字符串数组，且整条车道都算免费", async () => {
    const stub = stubCatalogs({
      "https://opencode.ai/zen/v1/models": {
        // Zen 的目录端点刻意只回 id，且那些 id 大多不带 `free` 字样。
        __strings: ["mimo-v2.6-flash-free", "brand-new-model-no-suffix"],
      },
    });
    try {
      const catalog = await catalogWithFreeProviders();
      const errors = await refreshFreeProviders(catalog);
      assert.equal(errors.has("opencode-free"), false);
      const ids = catalog.models.getModels("opencode-free").map((m) => m.id);
      assert.ok(ids.includes("brand-new-model-no-suffix"), "免费车道上的模型全收");
      assert.ok(ids.includes("mimo-v2.6-flash-free"));
    } finally {
      stub.restore();
    }
  });

  test("Kilo 采信网关自己的 isFree 标记：标了免费但名字不像的模型也收", async () => {
    const stub = stubCatalogs({
      "https://api.kilo.ai/api/gateway/models": {
        __raw: [
          { id: "some-vendor/some-model", isFree: true },
          { id: "vendor/paid-model" },
          { id: "vendor/flagged-false", isFree: false },
        ],
      },
    });
    process.env.KILO_API_KEY = "kilo-test-key";
    try {
      const catalog = await catalogWithFreeProviders();
      await refreshFreeProviders(catalog);
      const ids = catalog.models.getModels("kilo").map((m) => m.id);
      assert.ok(ids.includes("some-vendor/some-model"), "isFree:true 应当收");
      assert.ok(!ids.includes("vendor/paid-model"));
      // 标记为 false 时不额外排除，但也不靠命名规律放行——这里它两个来源都不沾。
      assert.ok(!ids.includes("vendor/flagged-false"));
    } finally {
      stub.restore();
      delete process.env.KILO_API_KEY;
    }
  });
});

describe("浏览器登录（OAuth）", () => {
  test("Cline：回环回调打通 → 换令牌 → 存成 OAuth 凭据", async () => {
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const seen = [];
    const restore = stubWithLoopbackPassthrough(async (href, init) => {
      seen.push(href);
      if (href === "https://api.cline.bot/auth/authorize") {
        // 必须走 302 + Location：授权链接不是 baseUrl 拼得出来的。
        return new Response(null, {
          status: 302,
          headers: { Location: "https://app.cline.bot/authorize?state=xyz" },
        });
      }
      if (href === "https://api.cline.bot/auth/token") {
        const body = JSON.parse(init.body);
        // provider 由回调带回来，必须原样回传。
        assert.equal(body.grant_type, "authorization_code");
        assert.equal(body.provider, "google");
        assert.equal(body.code, "auth-code-1");
        assert.match(body.redirect_uri, /^http:\/\/127\.0\.0\.1:488\d\d\/auth$/);
        return new Response(
          JSON.stringify({
            success: true,
            data: { accessToken: "access-1", refreshToken: "refresh-1", expiresAt },
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    try {
      const cline = createFreeProviders().find((p) => p.id === "cline");
      const events = [];
      const loginPromise = cline.auth.oauth.login(fakeInteraction(events), undefined);
      const delivered = await deliverClineCallback("code=auth-code-1&provider=google");
      assert.match(delivered.html, /登录完成/);
      const credential = await loginPromise;

      assert.equal(credential.type, "oauth");
      assert.equal(credential.access, "access-1");
      assert.equal(credential.refresh, "refresh-1");
      assert.ok(credential.expires > Date.now(), "到期时间应在未来");
      // 过期时间只减 60s 余量：pi-ai 自己在剩余不足 5 分钟时就刷新，
      // 若这里再减 5 分钟就会变成「每次请求都刷新一次」。
      assert.ok(
        credential.expires > Date.now() + 3000_000,
        "不应把有效期削到 5 分钟以内",
      );
      // 授权链接确实回显给用户了（否则用户无从授权）。
      const authUrl = events.find((e) => e.type === "auth_url");
      assert.equal(authUrl.url, "https://app.cline.bot/authorize?state=xyz");
      assert.ok(seen.includes("https://api.cline.bot/auth/authorize"));
    } finally {
      restore();
    }
  });

  test("Cline：回环回调没到达时报出可操作的超时原因", async () => {
    const restore = stubWithLoopbackPassthrough(async (href) => {
      if (href === "https://api.cline.bot/auth/authorize") {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://app.cline.bot/authorize?state=xyz" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    // 不缩短真实超时（那是 5 分钟），而是替掉定时器：只证明「等不到」这条路走得通。
    const realTimeout = globalThis.AbortSignal.timeout;
    globalThis.AbortSignal.timeout = (ms) =>
      ms === 5 * 60 * 1000 ? realTimeout(60) : realTimeout(ms);
    try {
      const cline = createFreeProviders().find((p) => p.id === "cline");
      await assert.rejects(
        () => cline.auth.oauth.login(fakeInteraction([]), undefined),
        /没有收到浏览器回调/,
      );
    } finally {
      globalThis.AbortSignal.timeout = realTimeout;
      restore();
    }
  });

  test("Kilo：设备码 → 轮询到批准 → 存成一年有效期的 OAuth 凭据", async () => {
    let polls = 0;
    const restore = stubWithLoopbackPassthrough(async (href) => {
      if (href === "https://api.kilo.ai/api/device-auth/codes") {
        return new Response(
          JSON.stringify({
            code: "ABCD-1234",
            verificationUrl: "https://kilo.ai/device",
            expiresIn: 900,
          }),
          { status: 200 },
        );
      }
      if (href === "https://api.kilo.ai/api/device-auth/codes/ABCD-1234") {
        polls += 1;
        // 未决在 HTTP 状态上（202），不靠响应体。
        if (polls < 2) return new Response(null, { status: 202 });
        return new Response(
          JSON.stringify({ status: "approved", token: "kilo-token-1" }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    try {
      const kilo = createFreeProviders().find((p) => p.id === "kilo");
      const events = [];
      const credential = await kilo.auth.oauth.login(fakeInteraction(events), undefined);
      assert.equal(credential.type, "oauth");
      assert.equal(credential.access, "kilo-token-1");
      assert.ok(credential.expires > Date.now() + 300 * 24 * 3600_000);
      // 设备码与地址都回显了，用户才知道要去哪输入。
      const device = events.find((e) => e.type === "device_code");
      assert.equal(device.userCode, "ABCD-1234");
      assert.equal(device.verificationUri, "https://kilo.ai/device");
      assert.equal(polls, 2);
    } finally {
      restore();
    }
  });

  test("Kilo：申请设备码被限流时把「稍后再试」说出来", async () => {
    const restore = stubWithLoopbackPassthrough(
      async () => new Response("too many", { status: 429 }),
    );
    try {
      const kilo = createFreeProviders().find((p) => p.id === "kilo");
      await assert.rejects(
        () => kilo.auth.oauth.login(fakeInteraction([]), undefined),
        /待授权请求过多/,
      );
    } finally {
      restore();
    }
  });

  test("Kilo：令牌过期只能重新登录（网关没有续期接口）", async () => {
    const kilo = createFreeProviders().find((p) => p.id === "kilo");
    const expired = {
      type: "oauth",
      access: "old",
      refresh: "old",
      expires: Date.now() - 1000,
    };
    await assert.rejects(() => kilo.auth.oauth.refresh(expired, undefined), /已过期/);
    // 未过期时原样返回：pi-ai 只在需要时才调它。
    const valid = { ...expired, expires: Date.now() + 3600_000 };
    assert.equal(await kilo.auth.oauth.refresh(valid, undefined), valid);
  });

  test("opencode-free 用固定 bearer `public`，账号 key 压不过它", async () => {
    const provider = createFreeProviders().find((p) => p.id === "opencode-free");
    const env = async () => undefined;
    const ctx = { env, fileExists: async () => false };
    // Zen 的免费层只认字面量 public：带上账号 key 会被上游拒（403 Model access is disabled），
    // 因此存储凭据与环境变量都必须让位。
    const stored = await provider.auth.apiKey.resolve({
      ctx,
      credential: { type: "api_key", key: "account-key" },
      signal: new AbortController().signal,
    });
    assert.equal(stored.auth.apiKey, "public");
    process.env.OPENCODE_API_KEY = "env-key";
    try {
      const ambient = await provider.auth.apiKey.resolve({
        ctx: { env: async (name) => process.env[name], fileExists: async () => false },
        credential: undefined,
        signal: new AbortController().signal,
      });
      assert.equal(ambient.auth.apiKey, "public");
    } finally {
      delete process.env.OPENCODE_API_KEY;
    }
    // 没有可配置的凭据，因此不该进 /login；但恒成立，所以 /model 里一直在。
    assert.equal(provider.auth.apiKey.login, undefined);
    assert.equal(provider.auth.oauth, undefined);
  });

  test("opencode-free 的工具桩：五个门禁名齐全，且真被调用时明说不可用", async () => {
    const stubs = createOpencodeFreeGateTools();
    assert.deepEqual(stubs.map((t) => t.name).sort(), [...GATE_TOOLS].sort());
    for (const tool of stubs) {
      // 描述里必须点明它是占位，否则模型会当成真工具去用。
      assert.match(tool.description, /占位/);
      const result = await tool.execute("id", {}, undefined);
      assert.match(result.content[0].text, /未实现/);
      assert.match(result.content[0].text, /navigate/);
    }
  });

  test("Kilo 与 opencode-free 都关掉流式用量（网关不发 stream_options）", () => {
    for (const id of ["kilo", "opencode-free"]) {
      const provider = createFreeProviders().find((p) => p.id === id);
      assert.equal(provider.getModels()[0].compat.supportsUsageInStreaming, false, id);
    }
    // opencode-free 的客户端标识头（冒充 OpenCode CLI，与 pi-free 同一防线）。
    const zen = createFreeProviders().find((p) => p.id === "opencode-free");
    assert.equal(zen.baseUrl, "https://opencode.ai/zen/v1");
    assert.equal(zen.getModels()[0].headers["x-opencode-client"], "cli");
  });

  test("OAuth 凭据被换成请求用的 bearer 令牌", async () => {
    for (const id of OAUTH) {
      const provider = createFreeProviders().find((p) => p.id === id);
      const auth = await provider.auth.oauth.toAuth({
        type: "oauth",
        access: "token-" + id,
        refresh: "r",
        expires: Date.now() + 1000,
      });
      assert.equal(auth.apiKey, "token-" + id);
    }
  });
});