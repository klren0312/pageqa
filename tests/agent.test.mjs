import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  continuePrompt,
  needsContinuation,
  toolResultText,
  turnUsage,
} from "../dist/agent.js";
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

// TUI 状态栏的 token 消耗靠这条流：每轮 LLM 调用后把「本次运行到目前为止」的累计推给界面。
// 钉死的是「只有 assistant 消息带 usage」——不过滤就会把 user/toolResult 也计一次调用，
// 得到「调用次数比真实多、合计又对不上」的假数字。
describe("运行中实时上报 token 用量", () => {
  test("取 assistant 消息的 usage", () => {
    assert.deepEqual(
      turnUsage({
        type: "turn_end",
        message: {
          role: "assistant",
          usage: { input: 10, output: 2, totalTokens: 12 },
        },
      }),
      { input: 10, output: 2, totalTokens: 12 },
    );
  });

  test("user / toolResult / 没有 usage 的 assistant 都不算一次调用", () => {
    assert.equal(turnUsage({ type: "turn_end", message: { role: "user" } }), null);
    assert.equal(
      turnUsage({ type: "turn_end", message: { role: "toolResult" } }),
      null,
    );
    assert.equal(
      turnUsage({ type: "turn_end", message: { role: "assistant" } }),
      null,
    );
  });

  test("其它事件不产生用量（只有 turn_end 代表一轮 LLM 调用结束）", () => {
    assert.equal(
      turnUsage({ type: "tool_execution_start", toolName: "navigate" }),
      null,
    );
    assert.equal(
      turnUsage({
        type: "message_update",
        message: { role: "assistant", usage: { input: 1 } },
      }),
      null,
    );
    assert.equal(turnUsage({ type: "turn_start" }), null);
  });
});

// 钉死的契约：**步骤**与**断言**是两条独立的完整性证据，任一不足都要续跑。
// 回归用例来自 examples/smoke-test.md 场景 1：agent 自报「步骤完成：5/5」（步骤确实做完了），
// 但只调了 2 次 assert_text —— 第 1 步那行「打开 … 并断言页面标题包含 冒烟测试页面」也是
// 用例声明的断言（共 3 条）。旧实现写成 `progress ? 步骤校验 : 断言校验`，被「5/5」短路，
// 缺口一路带到报告才判 FAIL，agent 连补一次断言的机会都没有。
describe("续跑判定：步骤与断言都要检查", () => {
  test("自报步骤已跑满、断言只记录了 2/3 → 仍要续跑", () => {
    assert.equal(needsContinuation({ done: 5, total: 5 }, 2, 3), true);
  });

  test("步骤未跑满 → 续跑（原本行为不变）", () => {
    assert.equal(needsContinuation({ done: 2, total: 5 }, 3, 3), true);
  });

  test("没有进度声明时按断言数判定（原本行为不变）", () => {
    assert.equal(needsContinuation(null, 1, 3), true);
    assert.equal(needsContinuation(null, 3, 3), false);
  });

  test("步骤跑满且断言齐了 → 收尾，不续跑", () => {
    assert.equal(needsContinuation({ done: 5, total: 5 }, 3, 3), false);
  });

  test("用例没声明断言时，断言维度不产生续跑", () => {
    assert.equal(needsContinuation({ done: 5, total: 5 }, 0, 0), false);
  });

  test("步骤跑满只缺断言时，续跑提示要求补断言调用而不是「从第 6 步继续」", () => {
    const p = continuePrompt({ done: 5, total: 5 }, 2, 3);
    assert.match(p, /断言/);
    assert.match(p, /assert_text/);
    assert.ok(!/第 6 步/.test(p), "步骤已跑满，不能再让模型从第 6 步继续");
  });

  test("步骤确实没跑满时，续跑提示仍从下一步开始", () => {
    const p = continuePrompt({ done: 3, total: 5 }, 1, 3);
    assert.match(p, /第 4 步/);
  });
});
