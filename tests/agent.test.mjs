import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toolResultText } from "../dist/agent.js";
import { extractTrace } from "../dist/report.js";

// 纯单元测试：不依赖浏览器与 LLM。
//
// 这里钉死的是一条曾经缺失的契约：**工具失败必须给出可读原因**。
// pi-agent-core 把 `error.message` 放进 tool_execution_end 事件的 result.content[0].text，
// 若不去读它，日志里只剩一句「失败，将重试或报告」——交互模式下盯着视口也分不清是
// 「本地服务没起」「URL 写错」还是「选择器匹配不上」，而这三者的处理方式完全不同。

describe("工具失败原因", () => {
  test("从 tool_execution_end 的 result 里取出错误文本", () => {
    const result = {
      content: [{ type: "text", text: "net::ERR_CONNECTION_REFUSED" }],
      details: {},
    };
    assert.equal(toolResultText(result), "net::ERR_CONNECTION_REFUSED");
  });

  test("多段文本按顺序拼接", () => {
    const result = {
      content: [
        { type: "text", text: "第一次尝试失败" },
        { type: "text", text: "第二次仍然失败" },
      ],
    };
    assert.equal(toolResultText(result), "第一次尝试失败 第二次仍然失败");
  });

  test("没有 content / 非数组 / undefined 都不抛错", () => {
    assert.equal(toolResultText(undefined), "");
    assert.equal(toolResultText(null), "");
    assert.equal(toolResultText({}), "");
    assert.equal(toolResultText({ content: "不是数组" }), "");
    assert.equal(toolResultText({ content: [{ type: "image" }] }), "");
  });

  test("记进执行轨迹后仍能被 extractTrace 识别为工具失败", () => {
    // 与 agent.ts 里 events.push 的写法一致：原因与工具名同一行。
    const line = "[tool-error] navigate：net::ERR_CONNECTION_REFUSED";
    const trace = extractTrace(line);
    assert.equal(trace.length, 1);
    assert.match(trace[0], /^\[tool-error\] navigate/);
    assert.match(trace[0], /ERR_CONNECTION_REFUSED/);
  });
});
