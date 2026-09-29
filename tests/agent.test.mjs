import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  continuePrompt,
  DEFAULT_SYSTEM_PROMPT,
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

/**
 * 提示词里这几条规则是用真实事故换来的：被删掉时**不会报错、也不会让别的测试失败**，
 * 只会让模型悄悄退回旧行为（例如「navigate 完立刻去点筛选表单」——回放时页面还没渲染，
 * 那一步与它后面几步连带失败）。所以这里钉住它们的**存在**，不钉具体措辞。
 */
describe("默认系统提示里的关键规则", () => {
  const prompt = DEFAULT_SYSTEM_PROMPT;

  test("navigate 后先 snapshot 看清页面，再在首次操作前 wait_for 地标", () => {
    // 为什么是这个顺序：模型在 snapshot 之前并不知道该等什么文本（实测把「先 wait_for 再
    // snapshot」写进提示词时它干脆不写 wait_for）；而地标又必须取自「接下来要操作的那个区域」。
    assert.match(
      prompt,
      /navigate 之后先 snapshot\(\) 看清页面；\*\*在开始逐步交互之前，先 wait_for 一个地标\*\*/,
    );
  });

  test("有「等待与页面就绪」一节，覆盖进新页面 / 展开面板 / 提交后 / 遮罩消失", () => {
    assert.match(prompt, /等待与页面就绪（关键）：/);
    assert.match(prompt, /进入新页面后的第一次操作之前必须有 wait_for/);
    for (const when of ["进入新页面", "弹窗", "提交", "loading"]) {
      assert.ok(prompt.includes(when), `缺少「${when}」这类等待时机`);
    }
    // 地标必须只在该状态出现、且属于接下来要操作的区域（菜单/导航/标题里的字到处都是）
    assert.match(prompt, /只在该状态出现/);
    assert.match(prompt, /属于你接下来要操作的那个区域/);
  });

  test("地标必须是页面可见文本：aria-label / placeholder 不算（实测会等到超时）", () => {
    assert.match(prompt, /地标必须是\*\*页面上真的印出来的文字\*\*/);
    assert.match(prompt, /aria-label \/ placeholder/);
  });

  test("wait(ms) 只留给页面之外的事情，并写明回放会把秒数当事实照付", () => {
    assert.match(prompt, /wait\(ms\) 只留给页面之外的事情/);
    assert.match(prompt, /照付/);
  });

  test("wait_for 未达成时不得当作步骤完成", () => {
    assert.match(prompt, /未达成」说明页面确实没到那个状态/);
  });

  test("工具清单里 wait_for 是页面内等待的首选，wait 被明确收窄", () => {
    assert.match(prompt, /- wait\(ms\): 固定等待。只用于\*\*页面之外\*\*的事情/);
    assert.match(prompt, /- wait_for\(text \| selector \| gone, timeoutMs\?\)/);
  });

  // 模型会把提示词里的示例数字当成事实：单步用例照抄成「步骤完成：1/7」，
  // 续跑于是追着要根本不存在的第 2~7 步（实测它反问「请补充第 2 步至第 7 步」后罢工）。
  test("进度声明的总数以用例条数为准，不留可照抄的示例总数", () => {
    assert.match(prompt, /总步骤数 = 用例里 `### 步骤` 的条数/);
    assert.ok(
      !/步骤完成：\d+\/\d+/.test(prompt),
      "提示词里不该出现带具体分母的进度示例，模型会照抄",
    );
  });

  // 实测的另一种跑偏：模型把 navigate/assert_text 写成正文里的伪代码，
  // 再「假设快照返回了 Example Domain」——整轮零工具调用却给出通过结论。
  test("写进正文的工具调用不算执行，证据必须来自工具真实返回", () => {
    assert.match(prompt, /只有\*\*真正发起工具调用\*\*才会动浏览器/);
    assert.match(prompt, /严禁「假设快照返回了 X」/);
  });

  // examples/smoke.md 的 A3：用例写「断言页面不包含 X」。没有方向参数时，模型只能把
  // X 当正向期望传进去，一条本该通过的断言必然返回「不成立」（现场就是这么判成 FAIL 的）。
  test("反向断言必须走 assert_text 的 absent 参数，而不是把「不包含」写进期望文本", () => {
    assert.match(prompt, /- assert_text\(expectation, absent\?\)/);
    assert.match(prompt, /absent=true/);
    assert.match(prompt, /不要把「不包含」这类否定字眼写进文本/);
  });
});

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
