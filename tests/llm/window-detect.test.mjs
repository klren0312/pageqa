import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  engineRootOf,
  windowFromLlamaCpp,
  windowFromLmStudio,
} from "../../dist/llm/window-detect.js";

// 纯单元测试：只解析响应体，不发任何请求。
//
// 这一组钉住的是「本地小模型开箱即用」那条路：自配端点没有窗口元数据，
// 而引擎自己知道答案（LM Studio 的加载设置 / llama.cpp 的 n_ctx）。
// 解析错方向的代价很具体：把 `max_context_length`（模型上限 131072）当成
// 实际窗口，就会给一个只载入了 8192 的引擎发 12k tokens 的请求。

describe("引擎根地址：管理接口挂在根上，不在 /v1 下", () => {
  test("剥掉 /v1 与尾部斜杠", () => {
    assert.equal(engineRootOf("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234");
    assert.equal(engineRootOf("http://127.0.0.1:1234/v1/"), "http://127.0.0.1:1234");
    assert.equal(engineRootOf("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  });

  test("大小写不敏感，且不动路径中间的 /v1", () => {
    assert.equal(engineRootOf("http://localhost:1234/V1"), "http://localhost:1234");
    assert.equal(engineRootOf("http://host/v1/proxy"), "http://host/v1/proxy");
  });
});

describe("LM Studio：优先「当前载入的窗口」", () => {
  const body = {
    data: [
      { id: "qwen3-4b", state: "not-loaded", max_context_length: 32768 },
      {
        id: "google/gemma-4-e4b",
        state: "loaded",
        max_context_length: 131072,
        loaded_context_length: 8192,
      },
    ],
  };

  test("按模型 id 命中，取 loaded_context_length（真正生效的那个）", () => {
    assert.equal(windowFromLmStudio(body, "google/gemma-4-e4b"), 8192);
  });

  test("模型 id 对不上时退回「已载入」的那一项", () => {
    assert.equal(windowFromLmStudio(body, "unknown/model"), 8192);
  });

  test("没有 loaded 值就用模型上限；没有 data 就返回 undefined", () => {
    assert.equal(
      windowFromLmStudio(
        { data: [{ id: "x", max_context_length: 4096 }] },
        "x",
      ),
      4096,
    );
    assert.equal(windowFromLmStudio({}, "x"), undefined);
    assert.equal(windowFromLmStudio(null, "x"), undefined);
  });

  test("不合理的值不认（0 / 字符串 / 负数）", () => {
    assert.equal(
      windowFromLmStudio(
        { data: [{ id: "x", loaded_context_length: 0, max_context_length: "8192" }] },
        "x",
      ),
      undefined,
    );
  });
});

describe("llama.cpp：读 /props 的 n_ctx", () => {
  test("取 default_generation_settings.n_ctx", () => {
    assert.equal(
      windowFromLlamaCpp({ default_generation_settings: { n_ctx: 4096 } }),
      4096,
    );
  });

  test("结构不对时返回 undefined（不猜）", () => {
    assert.equal(windowFromLlamaCpp({}), undefined);
    assert.equal(windowFromLlamaCpp(null), undefined);
    assert.equal(
      windowFromLlamaCpp({ default_generation_settings: { n_ctx: -1 } }),
      undefined,
    );
  });
});
