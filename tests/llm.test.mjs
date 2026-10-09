import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  guessThinkingFormat,
  normalizeThinkingFormat,
  parseThinkingSetting,
  THINKING_FORMATS,
  THINKING_OFF_FIELD,
} from "../dist/config.js";
import { createPageqaProvider } from "../dist/llm.js";

// 「默认关闭思考」有一个反直觉的前提，钉住它：
// pi-ai 只有在模型**声明自己是 reasoning 模型**时才会把关闭开关发出去
// （openai-completions.js 里 zai/qwen/deepseek 每个分支都带 `&& model.reasoning`）。
// 只配 thinkingFormat 而不开 reasoning，请求体里一个字段都不会有。
//
// 注：跑这些用例会往 stderr 打一行「模型思考：…」（createPageqaProvider 如实报告当前设置）。

describe("thinkingFormat 的取值解析", () => {
  test("不配 = auto（按模型 id 自动判断，也就是默认关闭思考）", () => {
    for (const empty of [undefined, "", "  "]) {
      assert.deepEqual(parseThinkingSetting(empty), { kind: "auto" });
    }
  });

  test("none/off/false 等表示「不要关」（请求里不带任何思考开关）", () => {
    for (const off of ["none", "off", "false", "NO", "disabled", "0"]) {
      assert.deepEqual(parseThinkingSetting(off), { kind: "off" }, off);
    }
  });

  test("显式格式原样通过；不认识的值单独报出来（退回自动，不猜）", () => {
    for (const f of THINKING_FORMATS) {
      assert.deepEqual(parseThinkingSetting(f), { kind: "format", format: f });
    }
    assert.deepEqual(parseThinkingSetting("openai-compat"), {
      kind: "invalid",
      value: "openai-compat",
    });
  });
});

describe("按模型 id 猜「该端点认哪个关闭字段」", () => {
  test("认得出的族各归各位", () => {
    assert.equal(guessThinkingFormat("qwen3-max"), "qwen");
    assert.equal(guessThinkingFormat("qwq-32b"), "qwen");
    assert.equal(guessThinkingFormat("deepseek-v4.1-flash"), "deepseek");
    assert.equal(guessThinkingFormat("hunyuan-2.0-instruct"), "deepseek");
    assert.equal(guessThinkingFormat("hy3"), "deepseek");
    assert.equal(guessThinkingFormat("glm-4.6"), "zai");
  });

  test("认不出就用最常见的那个（deepseek 的 thinking.type 约定）", () => {
    assert.equal(guessThinkingFormat("some-instruct-model"), "deepseek");
    assert.equal(
      guessThinkingFormat("m1", "https://api.example.com/v1"),
      "deepseek",
    );
    // baseUrl 也参与判断（有些网关把模型名放在路径里）
    assert.equal(guessThinkingFormat("m1", "https://x/qwen/v1"), "qwen");
  });

  test("每个取值都说明了它在「不请求思考」时发出的字段", () => {
    for (const f of THINKING_FORMATS) {
      assert.equal(typeof THINKING_OFF_FIELD[f], "string", `${f} 缺字段说明`);
    }
    // 这些只在「请求了思考档位」时才带字段，pageqa 配了也关不掉，表里必须标空，
    // 否则用户会以为配上就够了（启动时也会照实说「发不出关闭开关」）。
    for (const f of ["openai", "ant-ling", "baseten"]) {
      assert.equal(THINKING_OFF_FIELD[f], "", `${f} 发不出关闭开关`);
    }
    for (const f of [
      "deepseek",
      "zai",
      "qwen",
      "qwen-chat-template",
      "together",
      "openrouter",
      "string-thinking",
    ]) {
      assert.notEqual(THINKING_OFF_FIELD[f], "", `${f} 应当能关掉思考`);
    }
  });
});

describe("自定义端点：思考默认关闭，且必须同时把 reasoning 打开", () => {
  const base = {
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "k",
    modelProvider: "pageqa",
  };

  test("不配置也关（按模型 id 自动判断格式），字段才发得出去", async () => {
    const models = await createPageqaProvider({
      ...base,
      model: "deepseek-v4.1-flash",
    }).getModels();
    for (const m of models) {
      assert.equal(m.reasoning, true, `${m.id} 应声明为 reasoning 模型`);
      assert.equal(m.compat.thinkingFormat, "deepseek");
    }
  });

  test("显式 none 则不关：请求里不带任何思考开关", async () => {
    const models = await createPageqaProvider({
      ...base,
      model: "deepseek-v4.1-flash",
      thinkingFormat: "none",
    }).getModels();
    for (const m of models) {
      assert.equal(m.reasoning, false);
      assert.equal(m.compat.thinkingFormat, undefined);
    }
  });

  test("显式格式覆盖自动判断", async () => {
    const models = await createPageqaProvider({
      ...base,
      model: "deepseek-v4.1-flash",
      thinkingFormat: "qwen",
    }).getModels();
    for (const m of models) {
      assert.equal(m.reasoning, true);
      assert.equal(m.compat.thinkingFormat, "qwen");
    }
  });
});