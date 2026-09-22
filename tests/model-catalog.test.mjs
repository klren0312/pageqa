import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 纯单元测试：不联网、不登录、不碰真实主目录。
//
// config.ts 在模块加载时按 homedir() 定位 ~/.pageqa，所以必须在**动态 import 之前**
// 把 HOME/USERPROFILE 指到临时目录——否则测试会往用户主目录里写 config.json。
const home = mkdtempSync(join(tmpdir(), "pageqa-home-"));
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.PAGEQA_LLM_PROVIDER = "pageqa";
process.env.PAGEQA_LLM_MODEL = "unit-test-model";
process.env.PAGEQA_LLM_BASE_URL = "http://127.0.0.1:9/v1";
process.env.PAGEQA_LLM_API_KEY = "unit-test-key";
process.env.PAGEQA_LOCALE = "zh";

const {
  createModelCatalog,
  hasProvider,
  listLoginOptions,
  listLogoutOptions,
  listModelOptions,
  probeModel,
  resolveModel,
  PAGEQA_PROVIDER_ID,
} = await import("../dist/models.js");
const { ModelUnreachableError } = await import("../dist/agent.js");

/**
 * 测试替身：pi-ai 的 CredentialStore 只有 4 个方法，自持一份内存实现即可，
 * 免得测试反过来依赖 pi-ai 的导出（也就少一层版本耦合）。
 */
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

after(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("模型目录（自定义端点 + 内置 provider）", () => {
  test("默认选择来自配置，且自定义端点 provider 总是已注册", async () => {
    const catalog = await createModelCatalog({
      credentials: memoryCredentials(),
    });
    assert.deepEqual(catalog.defaultChoice, {
      provider: PAGEQA_PROVIDER_ID,
      model: "unit-test-model",
    });
    assert.equal(hasProvider(catalog, PAGEQA_PROVIDER_ID), true);
    assert.ok(resolveModel(catalog, catalog.defaultChoice));
  });

  test("未注册的 provider 解析为 undefined（调用方据此给出可读报错，而不是静默走错端点）", async () => {
    const catalog = await createModelCatalog({
      credentials: memoryCredentials(),
    });
    // 内置 provider 尚未加载，因此这个概念上存在的 provider 此时也不可用。
    assert.equal(
      resolveModel(catalog, { provider: "anthropic", model: "claude-x" }),
      undefined,
    );
    assert.equal(hasProvider(catalog, "anthropic"), false);
  });

  test("未加载内置 provider 时，/model 列表只含自定义端点（启动开销不被内置目录拖累）", async () => {
    const catalog = await createModelCatalog({
      credentials: memoryCredentials(),
    });
    const options = await listModelOptions(catalog);
    assert.ok(options.length >= 1);
    assert.ok(options.every((o) => o.provider === PAGEQA_PROVIDER_ID));
    assert.ok(options.some((o) => o.model === "unit-test-model"));
    // 预设模型同样可选：换模型不必改配置文件。
    assert.ok(options.some((o) => o.model === "hunyuan-2.0-instruct"));
    assert.ok(options.some((o) => o.model === "deepseek-v4.1-flash"));
  });

  test("自定义端点不提供交互式登录（它靠 config.json 的 baseUrl/apiKey 配置）", async () => {
    const catalog = await createModelCatalog({
      credentials: memoryCredentials(),
    });
    assert.deepEqual(await listLoginOptions(catalog), []);
  });

  test("/logout 只列本地已存凭据，未注册的 provider 名回退为 id", async () => {
    const store = memoryCredentials();
    await store.modify("anthropic", async () => ({
      type: "api_key",
      key: "sk-test",
    }));
    const catalog = await createModelCatalog({ credentials: store });
    assert.deepEqual(await listLogoutOptions(catalog), [
      { provider: "anthropic", providerName: "anthropic", type: "api_key" },
    ]);
  });
});

/**
 * 探活是「跑用例前的闸门」：不通就不执行用例。
 *
 * 这里钉死两条容易踩空的事实：
 * 1. pi-ai 请求失败时**不抛异常**，而是 resolve 一条 `stopReason: "error"` 的消息
 *    （见其 `api/lazy.ts`），只看有没有 throw 会把「连不上」当成「通了」；
 * 2. 「端点挂死」要翻成人话（超时），而**用户按 Esc** 的中止不能被算成「模型不可达」。
 */
describe("模型探活（跑用例前的连通性检查）", () => {
  const model = {
    id: "unit-test-model",
    provider: PAGEQA_PROVIDER_ID,
    api: "openai-completions",
  };
  /** probeModel 只用到 catalog.models.completeSimple，因此给一个最小替身。 */
  const catalogWith = (completeSimple) => ({ models: { completeSimple } });

  test("端点正常回话 → 判定可达", async () => {
    const probe = await probeModel(
      catalogWith(async () => ({ stopReason: "stop", content: [] })),
      model,
    );
    assert.deepEqual(probe, { ok: true });
  });

  test("解析出 stopReason=error 的消息也算不可达（pi-ai 失败不抛异常）", async () => {
    const probe = await probeModel(
      catalogWith(async () => ({
        stopReason: "error",
        errorMessage: "Connection error.",
      })),
      model,
    );
    assert.equal(probe.ok, false);
    assert.equal(probe.reason, "Connection error.");
  });

  test("端点没给出原因时不空着，给一句可读兜底", async () => {
    const probe = await probeModel(
      catalogWith(async () => ({ stopReason: "error" })),
      model,
    );
    assert.equal(probe.ok, false);
    assert.ok(probe.reason.length > 0);
  });

  test("探活请求带中止信号与极小输出上限（不通就快速失败、也不费钱）", async () => {
    let seen;
    await probeModel(
      catalogWith(async (_m, _ctx, opts) => {
        seen = opts;
        return { stopReason: "stop" };
      }),
      model,
      { timeoutMs: 1234 },
    );
    assert.ok(seen.signal instanceof AbortSignal);
    assert.equal(seen.timeoutMs, 1234);
    assert.ok(seen.maxTokens > 0 && seen.maxTokens <= 32);
  });

  test("端点挂死不回话 → 超时说人话，而不是把 Node 的 aborted 原文抛给用户", async () => {
    const hanging = (_m, _ctx, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () =>
          reject(new Error("The operation was aborted due to timeout")),
        );
      });
    const probe = await probeModel(catalogWith(hanging), model, {
      timeoutMs: 20,
    });
    assert.equal(probe.ok, false);
    assert.match(probe.reason, /20/);
    assert.doesNotMatch(probe.reason, /aborted/i);
  });

  test("用户按 Esc 的中止不算「模型不可达」（那是「我不想再等这个了」）", async () => {
    const controller = new AbortController();
    const hanging = (_m, _ctx, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () =>
          reject(new Error("Aborted")),
        );
      });
    const pending = probeModel(catalogWith(hanging), model, {
      signal: controller.signal,
      timeoutMs: 5000,
    });
    controller.abort();
    const probe = await pending;
    assert.equal(probe.ok, false);
    assert.equal(probe.reason, "Aborted");
  });

  test("ModelUnreachableError 的报错可读且可被类型区分（批处理与交互模式据此分支）", () => {
    const err = new ModelUnreachableError(
      PAGEQA_PROVIDER_ID,
      "unit-test-model",
      "Connection error.",
    );
    assert.ok(err instanceof Error);
    assert.equal(err.name, "ModelUnreachableError");
    assert.match(err.message, /unit-test-model/);
    assert.match(err.message, /Connection error\./);
    assert.equal(err.reason, "Connection error.");
  });
});
