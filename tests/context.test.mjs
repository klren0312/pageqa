import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  COMPACT_SYSTEM_PROMPT,
  MAX_CALIBRATION,
  OVERFLOW_CALIBRATION_FLOOR,
  buildStateNote,
  calibrateFromUsage,
  compactTools,
  contextOverflowError,
  countMessageChars,
  createCalibration,
  dropMiddleMessages,
  forceCalibrationFloor,
  noteEstimate,
  estimateMessageTokens,
  estimateTokens,
  guessSmallModel,
  needsTrim,
  outputTokenCeiling,
  resolveContextBudget,
  resolveWindow,
  shouldCompactPrefix,
  snapshotBudgetChars,
  trimPlan,
  trimToolResults,
  truncateToTokens,
  windowFromOverflowMessage,
} from "../dist/agent/context.js";
import { DEFAULT_SYSTEM_PROMPT } from "../dist/agent/agent.js";

// 纯单元测试：估算/预算/裁剪都是纯函数，不开浏览器也不调模型。
//
// 这一组钉住的是用户报的那个故障的根因（ADR-0014）：旧实现按**字符数**比较一个
// 写死的 40k 阈值，而中文 1 字符 ≈ 1 token，40k 字符早已越过 8k 窗口——
// 请求被端点拒成 `exceed_context_size_error`（请求 10185 tokens > 窗口 8192）。
// 因此这里的断言都围绕两件事：**度量衡按 token**、**预算跟着窗口缩放**。

/** 造一条消息（只填裁剪逻辑会看的字段）。 */
function msg(role, text) {
  return { role, content: [{ type: "text", text }] };
}

describe("token 估算：CJK 1/字符、其余 0.25/字符", () => {
  test("中文按 1 token/字符，英文按 0.25", () => {
    assert.equal(estimateTokens("中文四个字"), 5);
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens(""), 0);
    // 混排：4 个汉字 + 4 个字母 = 4 + 1
    assert.equal(estimateTokens("中文四个abcd"), 5);
  });

  test("同样的字符数，中文估算远高于英文（旧口径失准的根因）", () => {
    const cjk = "测".repeat(400);
    const ascii = "a".repeat(400);
    assert.equal(estimateTokens(cjk), 400);
    assert.equal(estimateTokens(ascii), 100);
  });

  test("消息文本与字符数各按自己的口径累计", () => {
    const messages = [msg("user", "中文中文"), msg("assistant", "abcdefgh")];
    assert.equal(estimateMessageTokens(messages), 4 + 2);
    assert.equal(countMessageChars(messages), 12);
  });
});

describe("truncateToTokens：按 token 截，而不是按字符一律砍", () => {
  test("未超上限时不改动", () => {
    assert.deepEqual(truncateToTokens("abcd", 10), { text: "abcd", cut: false });
  });

  test("超出时截到上限以内（并把中文与英文分开算）", () => {
    const { text, cut } = truncateToTokens("中".repeat(100), 10);
    assert.equal(cut, true);
    assert.equal(text, "中".repeat(10));
    // 英文内容在同样的 token 上限下能保留更多字符（0.25/字符）
    const ascii = truncateToTokens("a".repeat(100), 10);
    assert.equal(ascii.text.length, 40);
  });

  test("上限为 0 时返回空串（激进裁剪的边界）", () => {
    assert.deepEqual(truncateToTokens("中文", 0), { text: "", cut: true });
  });
});

describe("窗口解析：配置 > 模型元数据 > 保守兜底", () => {
  test("配置优先于模型元数据（用户声明的窗口比目录假设可信）", () => {
    assert.equal(resolveWindow({ configured: 8192, modelWindow: 128000 }), 8192);
  });

  test("没配就用模型元数据，都没有才兜底 32k", () => {
    assert.equal(resolveWindow({ modelWindow: 192000 }), 192000);
    assert.equal(resolveWindow({}), 32000);
  });

  test("坏值（0 / 负数 / 非数字）一律当没配，不拿它算预算", () => {
    assert.equal(resolveWindow({ configured: 0, modelWindow: 8192 }), 8192);
    assert.equal(resolveWindow({ configured: -5, modelWindow: 8192 }), 8192);
    assert.equal(resolveWindow({ configured: Number.NaN }), 32000);
  });
});

describe("上下文预算：输出预留不超过窗口的四分之一", () => {
  test("8k 窗口 + 荒谬的输出上限（64000）也不会算出负数预算", () => {
    const budget = resolveContextBudget(8192, { maxOutput: 64000 });
    assert.equal(budget.window, 8192);
    // 小窗口按 1/8 预留：本地引擎按 prompt + max_tokens <= n_ctx 记账，
    // 8k 下留 2048 等于把 2000 个 token 的输入空间白送给用不到的输出。
    assert.equal(budget.outputReserve, 1024);
    assert.ok(budget.input > 0 && budget.input < budget.window);
    // 小窗口 → 需要压缩固定前缀（默认前缀约 12.4k token，装不下）
    assert.equal(budget.small, true);
    // 安全边际随窗口缩放（8%）：估算必然有偏，紧贴上限的请求最先撞墙
    assert.ok(budget.input <= budget.window - budget.outputReserve - 512);
  });

  test("输出侧上限随窗口切换（小窗口 1/8、大窗口 1/4）", () => {
    assert.equal(outputTokenCeiling(8192), 1024);
    assert.equal(outputTokenCeiling(32000), 8000);
    assert.equal(outputTokenCeiling(128000), 32000);
    // 再小的窗口也留得下一次工具调用
    assert.equal(outputTokenCeiling(2048), 512);
  });

  test("32k 窗口的默认模型走常规档（不压缩前缀）", () => {
    const budget = resolveContextBudget(32000, { maxOutput: 8000 });
    assert.equal(budget.outputReserve, 8000);
    assert.ok(budget.input > 20000);
    assert.equal(budget.small, false);
  });

  test("输入预算一定小于窗口（否则第一轮就撞窗口）", () => {
    for (const window of [8192, 16384, 32000, 128000]) {
      const budget = resolveContextBudget(window, { maxOutput: 64000 });
      assert.ok(
        budget.input + budget.outputReserve < window,
        `${window} 窗口：预算 ${budget.input} + 预留 ${budget.outputReserve} 必须小于窗口`,
      );
    }
  });
});

describe("小模型识别：窗口够大也要认得出小模型", () => {
  // 真实会话（20261014-105627）：LM Studio 把 gemma-4-e4b 载入成 131072 窗口，
  // 于是「窗口小」这条规则不触发 → 每轮背 12.4k token 的完整前缀推理。
  // 用户看到的就是「小模型识别没生效」，所以判定必须同时看**模型本身**。
  test("参数标注 ≤9B 的写法都算小模型", () => {
    for (const id of [
      "google/gemma-4-e4b",
      "gemma-3-4b-it",
      "qwen2.5-7b-instruct",
      "llama-3.1-8b",
      "meta-llama/Llama-3.2-1B",
      "phi-3-mini",
    ]) {
      assert.equal(guessSmallModel(id), true, `${id} 应判为小模型`);
    }
  });

  test("大模型不误判（两位数参数、没有参数标注的都算大）", () => {
    for (const id of [
      "hunyuan-2.0-instruct",
      "deepseek-v4.1-flash",
      "hy3",
      "llama-3.3-70b-versatile",
      "gpt-oss-120b",
      "qwen3-235b-a22b",
      "claude-sonnet-4",
    ]) {
      assert.equal(guessSmallModel(id), false, `${id} 不该判为小模型`);
    }
  });

  test("名字里出现 mini / nano / tiny 这类厂商用词也算", () => {
    assert.equal(guessSmallModel("gpt-4o-mini"), true);
    assert.equal(guessSmallModel("qwen-tiny"), true);
  });

  test("空字符串不猜", () => {
    assert.equal(guessSmallModel(""), false);
  });
});

describe("前缀压缩决策：配置 > 窗口 > 模型名", () => {
  const big = resolveContextBudget(131072, { maxOutput: 8192 });
  const small = resolveContextBudget(8192, { maxOutput: 8192 });

  test("窗口装不下 → 压缩（理由 window）", () => {
    assert.deepEqual(shouldCompactPrefix({ budget: small, modelId: "hy3" }), {
      compact: true,
      reason: "window",
    });
  });

  test("窗口够大但模型名像小模型 → 压缩（理由 model）", () => {
    assert.deepEqual(
      shouldCompactPrefix({ budget: big, modelId: "google/gemma-4-e4b" }),
      { compact: true, reason: "model" },
    );
  });

  test("窗口够大、模型也不小 → 不压缩", () => {
    assert.deepEqual(
      shouldCompactPrefix({ budget: big, modelId: "hunyuan-2.0-instruct" }),
      { compact: false, reason: "none" },
    );
  });

  test("配置显式 true/false 推翻两条自动规则", () => {
    assert.deepEqual(
      shouldCompactPrefix({ budget: big, modelId: "hy3", configured: true }),
      { compact: true, reason: "config" },
    );
    assert.deepEqual(
      shouldCompactPrefix({
        budget: small,
        modelId: "google/gemma-4-e4b",
        configured: false,
      }),
      { compact: false, reason: "none" },
    );
  });
});

describe("裁剪档位：75% 常规、85% 激进", () => {
  const budget = resolveContextBudget(32000, { maxOutput: 8000 });

  test("占用未到 75% 不动上下文", () => {
    assert.equal(needsTrim(budget.input * 0.7, budget, false), false);
    assert.equal(trimPlan(budget.input * 0.7, budget, false).mode, "normal");
  });

  test("超过 75% 常规裁剪：最近 12 条保持完整", () => {
    assert.equal(needsTrim(budget.input * 0.8, budget, false), true);
    const plan = trimPlan(budget.input * 0.8, budget, false);
    assert.equal(plan.mode, "normal");
    assert.equal(plan.keepRecentMessages, 12);
    assert.equal(plan.maxRecentToolTokens, undefined);
  });

  test("超过 85% 激进裁剪：只留最近 2 条", () => {
    const plan = trimPlan(budget.input * 0.9, budget, false);
    assert.equal(plan.mode, "aggressive");
    assert.equal(plan.keepRecentMessages, 2);
  });

  test("溢出恢复轮次即使占用不高也走激进档", () => {
    const plan = trimPlan(budget.input * 0.1, budget, true);
    assert.equal(plan.mode, "aggressive");
  });
});

describe("裁剪只动工具结果：用例、步骤自述与断言永不丢", () => {
  const budget = resolveContextBudget(8192, { maxOutput: 2048 });
  const long = "中".repeat(5000);
  const messages = [
    msg("system", "系统提示"),
    msg("user", "用例原文"),
    msg("assistant", "第 1 步完成：已打开页面"),
    { role: "toolResult", content: [{ type: "text", text: long }] },
    msg("assistant", "断言成立"),
    { role: "toolResult", content: [{ type: "text", text: long }] },
  ];

  test("超出阈值时裁掉旧工具结果的长文本，并标注省略量", () => {
    const plan = trimPlan(budget.input * 0.9, budget, false);
    const trimmed = trimToolResults(messages, plan);
    const first = trimmed[3].content[0].text;
    assert.ok(first.length < long.length, "旧工具结果应被截短");
    assert.match(first, /较早的快照已省略/);
    assert.match(first, /字符/);
  });

  test("系统提示、用例原文、assistant 自述与断言原文一字不改", () => {
    const plan = trimPlan(budget.input * 0.9, budget, true);
    const trimmed = trimToolResults(messages, plan);
    assert.equal(trimmed[0].content[0].text, "系统提示");
    assert.equal(trimmed[1].content[0].text, "用例原文");
    assert.equal(trimmed[2].content[0].text, "第 1 步完成：已打开页面");
    assert.equal(trimmed[4].content[0].text, "断言成立");
  });

  test("消息条数不变：toolCall/toolResult 配对不可能被裁断", () => {
    const plan = trimPlan(budget.input, budget, true);
    const trimmed = trimToolResults(messages, plan);
    assert.equal(trimmed.length, messages.length);
  });

  test("返回新数组（流式期间原数组会被 pi-agent-core 原位改写）", () => {
    const plan = trimPlan(budget.input, budget, true);
    const trimmed = trimToolResults(messages, plan);
    assert.notEqual(trimmed, messages);
    assert.notEqual(trimmed[3], messages[3]);
  });

  test("激进档：最后一条工具结果保持完整（模型正要用的就是它携带的 @eN）", () => {
    const plan = trimPlan(budget.input, budget, true);
    const trimmed = trimToolResults(messages, plan);
    assert.equal(trimmed[5].content[0].text, long);
    assert.ok(trimmed[3].content[0].text.length < long.length);
  });

  test("已经被裁过的内容不重复追加标记", () => {
    const plan = trimPlan(budget.input, budget, true);
    const once = trimToolResults(messages, plan);
    const twice = trimToolResults(once, plan);
    assert.equal(twice[3].content[0].text, once[3].content[0].text);
  });
});

describe("估算必须算进 system 消息里的工具声明", () => {
  // pi-agent-core 把系统提示与工具声明装在同一条 system 消息里
  // （`createInitialSystemMessage(prompt, toolDeclarations)` → `toolsAdded`）。
  // 只数 `content` 会漏掉工具声明那一大块（默认 ≈6.8k token），估出来的用量
  // 比真实请求小得多——「以为还早、实际已经撞墙」就是这么来的。
  const system = {
    role: "system",
    content: "系统提示",
    toolsAdded: [
      { name: "snapshot", description: "读页面快照".repeat(50), parameters: { type: "object" } },
    ],
  };

  test("toolsAdded 计入 token 与字符", () => {
    const onlyContent = estimateTokens("系统提示");
    assert.ok(estimateMessageTokens([system]) > onlyContent + 100);
    assert.ok(
      countMessageChars([system]) > 260,
      "工具声明的字符数也要算进去，不能只数 content",
    );
  });

  test("工具入参（toolCalls）同样计入", () => {
    const assistant = {
      role: "assistant",
      content: "好",
      toolCalls: [{ name: "fill", arguments: { target: "@e1", value: "值".repeat(50) } }],
    };
    assert.ok(estimateMessageTokens([assistant]) > estimateTokens("好") + 10);
  });
});

describe("激进档：整组丢弃中间消息（截断给不出上界，丢弃才能）", () => {
  const t = (text) => ({ role: "toolResult", content: [{ type: "text", text }] });
  const a = (text) => ({ role: "assistant", content: text, toolCalls: [{ name: "snapshot" }] });

  test("头部（system + 用例原文）与尾部最近一轮保留，中间整段丢弃", () => {
    const messages = [
      { role: "system", content: "提示", toolsAdded: [{ name: "snapshot" }] },
      { role: "user", content: "用例原文" },
      a("第 1 步完成"),
      t("旧快照 1"),
      a("第 2 步完成"),
      t("旧快照 2"),
      a("第 3 步完成"),
      t("新快照"),
    ];
    const cut = dropMiddleMessages(messages, 2);
    assert.equal(cut.dropped, 4);
    assert.equal(cut.messages.length, 4);
    assert.equal(cut.messages[0].role, "system");
    assert.equal(cut.messages[1].content, "用例原文");
    assert.equal(cut.messages[2].content, "第 3 步完成");
    assert.equal(cut.messages[3].content[0].text, "新快照");
  });

  test("尾部起点不会落在 toolResult 上（否则 tool 消息失去它的 assistant）", () => {
    const messages = [
      { role: "system", content: "提示" },
      { role: "user", content: "用例原文" },
      a("第 1 步"),
      t("旧结果 1"),
      a("第 2 步"),
      t("结果 2-1"),
      t("结果 2-2"),
    ];
    // keepRecent=2 直接切会从「结果 2-1」开始 → 回退到产出它们的那条 assistant
    const cut = dropMiddleMessages(messages, 2);
    const tail = cut.messages.slice(cut.insertAt);
    assert.equal(tail.length, 3);
    // 尾部第一段工具结果的归属者必须是 assistant，而不是被丢掉的中间段
    const firstResult = tail.findIndex((m) => m.role === "toolResult");
    assert.ok(firstResult > 0);
    let owner = firstResult - 1;
    while (owner > 0 && tail[owner].role === "toolResult") owner -= 1;
    assert.equal(tail[owner].role, "assistant");
    assert.equal(tail[owner].content, "第 2 步");
  });

  test("短会话不动（没有可丢的中间段）", () => {
    const messages = [
      { role: "system", content: "提示" },
      { role: "user", content: "用例原文" },
      a("第 1 步"),
      t("结果"),
    ];
    const cut = dropMiddleMessages(messages, 2);
    assert.equal(cut.dropped, 0);
    assert.equal(cut.messages, messages);
  });
});

describe("压缩后的状态提示：给模型一份权威快照", () => {
  test("带上进度、断言成果与「重新 snapshot」的指引", () => {
    const note = buildStateNote({ done: 3, total: 8, assertions: 2, failed: 1 });
    const text = note.content[0].text;
    assert.equal(note.role, "user");
    assert.match(text, /已被压缩/);
    assert.match(text, /已完成 3\/8 步，请从第 4 步继续/);
    assert.match(text, /断言：已产出 2 条（其中不成立 1 条）/);
    assert.match(text, /重新 snapshot/);
  });

  test("没有进度声明时不编造步数，只指回用例原文", () => {
    const text = buildStateNote({ total: 5, assertions: 0, failed: 0 }).content[0].text;
    assert.match(text, /尚未输出进度声明/);
    assert.doesNotMatch(text, /第 \d+ 步继续/);
  });
});

describe("长流程在小窗口下的上界：丢弃 + 截断后仍装得进窗口", () => {
  test("30 轮快照后，估算用量仍低于输入预算", () => {
    const budget = resolveContextBudget(8192, { maxOutput: 2048 });
    const messages = [
      {
        role: "system",
        content: "压缩版提示".repeat(20),
        toolsAdded: [{ name: "snapshot", description: "说明".repeat(40) }],
      },
      { role: "user", content: "用例原文".repeat(20) },
    ];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: "assistant", content: `第 ${i + 1} 步完成`, toolCalls: [] });
      messages.push({
        role: "toolResult",
        content: [{ type: "text", text: "快照内容".repeat(400) }],
      });
    }
    const plan = trimPlan(budget.input * 2, budget, true);
    const cut = dropMiddleMessages(messages, plan.keepRecentMessages);
    const trimmed = trimToolResults(cut.messages, plan);
    assert.ok(cut.dropped >= 50, "长流程应丢掉大半历史");
    const used = estimateMessageTokens(trimmed);
    assert.ok(
      used <= budget.input,
      `丢弃后估算 ${used} 必须回到输入预算 ${budget.input} 以内`,
    );
  });
});

describe("上下文超限判定：认端点原话，不认普通报错", () => {
  test("llama.cpp / 本地引擎的 exceed_context_size_error 被认出", () => {
    const messages = [
      msg("assistant", "开始执行"),
      {
        role: "assistant",
        stopReason: "error",
        errorMessage:
          'Engine protocol predict request returned 400: {"error":{"message":"request (10185 tokens) exceeds the available context size (8192 tokens), try increasing it"',
      },
    ];
    assert.match(contextOverflowError(messages, 8192), /exceeds the available context size/);
  });

  test("普通报错（如限流）不算超限，交给原有的失败归因", () => {
    const messages = [
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "429 Too Many Requests: rate limit exceeded",
      },
    ];
    assert.equal(contextOverflowError(messages, 8192), null);
  });

  test("只看最后一条 assistant：已恢复过的旧溢出不会被重新翻出来", () => {
    const messages = [
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "prompt is too long: 10185 tokens > 8192 maximum",
      },
      msg("assistant", "第 2 步完成：筛选表单已展开"),
    ];
    assert.equal(contextOverflowError(messages, 8192), null);
  });

  test("静默溢出：端点接受了超窗请求，用 usage 也能判出来", () => {
    const messages = [
      {
        role: "assistant",
        stopReason: "stop",
        usage: { input: 9000, cacheRead: 0, output: 10 },
      },
    ];
    assert.notEqual(contextOverflowError(messages, 8192), null);
    assert.equal(contextOverflowError(messages, 128000), null);
  });
});

describe("溢出判定的本地引擎方言：认证过的真实报错", () => {
  // 真实故障：配好 contextWindow 后，LM Studio 在**流式**请求上回了
  // {"code":500,"message":"Context size has been exceeded.","type":"server_error"}。
  // pi-ai 的 isContextOverflow 认的是 LM Studio 另一句 "greater than the context length"，
  // 这句它认不出——判不出来的后果是「不走压缩重试、直接以泛泛的模型报错收场」。
  test("LM Studio 的 Context size has been exceeded 被认出", () => {
    const messages = [
      {
        role: "assistant",
        stopReason: "error",
        errorMessage:
          '[google/gemma-4-e4b] Engine protocol predict stream returned an error: {"code":500,"message":"Context size has been exceeded.","type":"server_error"}',
      },
    ];
    assert.match(
      contextOverflowError(messages, 8192),
      /Context size has been exceeded/,
    );
  });

  test("普通 500（与上下文无关）仍不算溢出", () => {
    const messages = [
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: '{"code":500,"message":"Model has crashed.","type":"server_error"}',
      },
    ];
    assert.equal(contextOverflowError(messages, 8192), null);
  });
});

describe("估算校准：用端点回报的真实用量修正比例估算", () => {
  test("真实比估算大 → 系数变大，后续按它收紧", () => {
    const calibration = createCalibration();
    noteEstimate(calibration, 4000);
    assert.equal(calibrateFromUsage(calibration, 6000), 1.5);
    assert.equal(calibration.scale, 1.5);
  });

  test("真实小于估算 → 只记下来、不放大预算（估低才有害）", () => {
    const calibration = createCalibration();
    noteEstimate(calibration, 4000);
    assert.equal(calibrateFromUsage(calibration, 3000), null);
    assert.equal(calibration.scale, 1);
  });

  test("只增不减：反复横跳会让裁剪档位来回切，行为无法解释", () => {
    const calibration = createCalibration();
    noteEstimate(calibration, 1000);
    calibrateFromUsage(calibration, 1600);
    noteEstimate(calibration, 2000);
    calibrateFromUsage(calibration, 1200); // 这一轮真实反而更小
    assert.equal(calibration.scale, 1.6);
  });

  test("单轮异常值被夹住，且不重复消费同一轮估算", () => {
    const calibration = createCalibration();
    noteEstimate(calibration, 100);
    assert.equal(calibrateFromUsage(calibration, 100000), MAX_CALIBRATION);
    // 没有新的估算就标定不了（pending 已被消费）
    assert.equal(calibrateFromUsage(calibration, 100000), null);
  });

  test("溢出恢复时抬高下限：这一轮必须真的更小", () => {
    const calibration = createCalibration();
    forceCalibrationFloor(calibration);
    assert.ok(calibration.scale >= OVERFLOW_CALIBRATION_FLOOR);
    // 已经有更大的系数时不降低
    const bigger = createCalibration();
    bigger.scale = 2;
    forceCalibrationFloor(bigger);
    assert.equal(bigger.scale, 2);
  });
});

describe("从端点报错里抠出真实窗口：把「猜错了」变成可执行指令", () => {
  test("本地引擎报告里的 n_ctx（用户报的那条原文）", () => {
    const raw =
      'Engine protocol predict request returned 400: {"error":{"code":400,"message":"request (10185 tokens) exceeds the available context size (8192 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":10185,"n_ctx":8192}}';
    assert.equal(windowFromOverflowMessage(raw), 8192);
  });

  test("各家写法的窗口都能抠出来", () => {
    assert.equal(
      windowFromOverflowMessage("prompt is too long: 213462 tokens > 200000 maximum"),
      undefined,
    );
    assert.equal(
      windowFromOverflowMessage("Input length (265330) exceeds model's maximum context length (262144)."),
      262144,
    );
    assert.equal(
      windowFromOverflowMessage("This model's maximum prompt length is 131072 but the request contains 537812 tokens"),
      131072,
    );
    assert.equal(
      windowFromOverflowMessage("Prompt has 9500 tokens, but the configured context size is 8192 tokens"),
      8192,
    );
  });

  test("抠不出数字时不猜（返回 undefined）", () => {
    assert.equal(windowFromOverflowMessage("429 Too Many Requests"), undefined);
    assert.equal(
      windowFromOverflowMessage("Please reduce the length of the messages or completion"),
      undefined,
    );
  });
});

describe("小窗口前缀压缩：默认前缀装不进 8k，压缩后才装得下", () => {
  test("压缩后的系统提示明显短于默认提示", () => {
    assert.ok(
      estimateTokens(COMPACT_SYSTEM_PROMPT) < estimateTokens(DEFAULT_SYSTEM_PROMPT) / 5,
      "压缩版应只有默认版的零头",
    );
  });

  test("压缩版仍保留「不写就会出错」的规则", () => {
    for (const rule of [
      "navigate",
      "snapshot",
      "wait_for",
      "assert_text",
      "@eN",
      "步骤完成",
      "select_option",
      "pick_date",
    ]) {
      assert.ok(COMPACT_SYSTEM_PROMPT.includes(rule), `压缩版缺了 ${rule}`);
    }
    // 「写进正文的工具调用不算执行」这类硬约束必须留下（默认提示里最主要的事故防线）
    assert.match(COMPACT_SYSTEM_PROMPT, /只有\*\*真正调用工具\*\*才算执行/);
  });

  test("工具声明压缩：说明变短、类型与枚举不变、execute 原样保留", () => {
    const tool = {
      name: "demo",
      label: "Demo",
      description: "描述".repeat(200),
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: ["a", "b"],
            description: "参数说明".repeat(50),
          },
        },
        required: ["target"],
      },
      execute: () => "ok",
    };
    const [compact] = compactTools([tool]);
    assert.ok(compact.description.length < tool.description.length);
    assert.equal(compact.parameters.properties.target.type, "string");
    assert.deepEqual(compact.parameters.properties.target.enum, ["a", "b"]);
    assert.deepEqual(compact.parameters.required, ["target"]);
    assert.ok(
      compact.parameters.properties.target.description.length <
        tool.parameters.properties.target.description.length,
    );
    assert.equal(compact.execute, tool.execute);
    // 原对象不被就地改写（工具声明在别处还要用）
    assert.equal(tool.parameters.properties.target.type, "string");
  });

  test("快照预算：大窗口不缩放（沿用既有默认），小窗口按「扣掉前缀后的余量」给", () => {
    const big = resolveContextBudget(32000, { maxOutput: 8000 });
    assert.equal(snapshotBudgetChars(big, 12000), undefined);

    const small = resolveContextBudget(8192, { maxOutput: 2048 });
    const chars = snapshotBudgetChars(small, 3600);
    assert.ok(chars > 0 && chars < 4000, `快照预算应明显小于 8k 窗口，实际 ${chars}`);
    // 「前缀 + 快照 + 输出预留」不得超过窗口——否则第一轮快照就会撞墙
    assert.ok(3600 + chars + small.outputReserve < small.window);
  });
});
