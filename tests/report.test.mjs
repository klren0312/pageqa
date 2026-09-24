import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  addUsage,
  buildReport,
  countAssertions,
  emptyUsage,
  extractTrace,
  formatUsage,
  mergeUsage,
  numberSteps,
  summarizeSuite,
} from "../dist/report.js";

// 纯单元测试：只依赖 dist/report.js，不需要 bsk / LLM。
describe("report 断言解析", () => {
  test("去掉 markdown 加粗，expectation 不带尾部冒号", () => {
    const r = buildReport("", "断言标题包含 pageqa：**成立**。证据：页面中包含「pageqa」。");
    assert.equal(r.assertions.length, 1);
    assert.equal(r.assertions[0].expectation, "标题包含 pageqa");
    assert.equal(r.assertions[0].verdict, "pass");
    assert.ok(r.assertions[0].evidence?.includes("证据"));
    assert.equal(r.status, "pass");
  });

  test("描述含中文引号的断言不再丢失", () => {
    const r = buildReport("", "断言星标按钮当前显示为「Starred」：**成立**");
    assert.equal(r.assertions.length, 1);
    assert.equal(r.assertions[0].expectation, "星标按钮当前显示为「Starred」");
    assert.equal(r.status, "pass");
  });

  test("清理首尾连接符与标点噪声", () => {
    const r = buildReport(
      "",
      "1. 断言星标按钮显示为「Starred」——成立（以「Unstar」文案为已加星证据）。",
    );
    assert.equal(r.assertions.length, 1);
    assert.equal(r.assertions[0].expectation, "星标按钮显示为「Starred」");
    assert.equal(r.assertions[0].evidence, "（以「Unstar」文案为已加星证据）");
  });

  test("不成立的断言使整体 fail", () => {
    const r = buildReport("", "断言页面包含 IANA：不成立。证据：未找到「IANA」。");
    assert.equal(r.assertions.length, 1);
    assert.equal(r.assertions[0].verdict, "fail");
    assert.equal(r.status, "fail");
  });

  test("换行输出的「成立」也能解析", () => {
    const r = buildReport("", "1. 断言页面包含 IANA：\n   成立");
    assert.equal(r.assertions.length, 1);
    assert.equal(r.assertions[0].expectation, "页面包含 IANA");
    assert.equal(r.status, "pass");
  });

  test("多场景 transcript 中的断言全部被收集", () => {
    const transcript = [
      "## G1 打开仓库页并校验内容",
      "测试结论：",
      "1. 断言标题包含 pageqa：**成立**，证据：页面中包含「pageqa」。",
      "2. 断言页面包含 klren0312/pageqa：**成立**，证据：页面中包含「klren0312/pageqa」。",
      "## G2 为仓库点 Star（幂等）",
      "测试结论：",
      "1. 断言星标按钮当前显示为「Starred」：**成立**。",
    ].join("\n");
    const r = buildReport("", transcript);
    assert.deepEqual(
      r.assertions.map((a) => a.expectation),
      ["标题包含 pageqa", "页面包含 klren0312/pageqa", "星标按钮当前显示为「Starred」"],
    );
    assert.equal(r.status, "pass");
  });

  test("无结构化断言时按关键字降级判定", () => {
    assert.equal(buildReport("", "页面正常打开。").status, "pass");
    assert.equal(buildReport("", "元素未找到，测试失败。").status, "fail");
  });
});

// 长流程最容易发生「只跑了几步就收尾」，这里锁定完整性校验行为。
// assert_text 工具返回的「期望值 + 成立/不成立 + 证据」是确定性事实，模型自述只是转述。
// 这里钉死「以工具结果为准」：据此计数与判定，不因模型措辞变化而误判。
describe("断言以 assert_text 工具结果为准", () => {
  const script = [
    "打开 http://localhost/smoke-test-page.html 并断言标题包含 冒烟测试页面",
    "点击「表单页面 1」链接",
    "断言页面中已出现表单内容",
    "点击「文件上传」链接",
    "断言页面中已出现文件上传相关内容",
  ].join("\n");

  test("模型只写「断言成立」时不再误报「断言全部执行（实际 0/3）」", () => {
    const tool = [
      { expectation: "冒烟测试页面", verdict: "pass", evidence: "页面中包含「冒烟测试页面」" },
      { expectation: "表单页面 1", verdict: "pass", evidence: "页面中包含「表单页面 1」" },
      { expectation: "文件上传", verdict: "pass", evidence: "页面中包含「文件上传」" },
    ];
    const narrative = [
      "第 1 步完成：页面成功打开，断言成立。",
      "第 3 步完成：页面中已出现表单内容，断言成立。",
      "第 5 步完成：页面中已出现文件上传相关内容，断言成立。",
      "步骤完成：5/5",
    ].join("\n");
    const r = buildReport(script, narrative, tool);
    assert.equal(r.assertions.length, 3);
    assert.deepEqual(
      r.assertions.map((a) => a.expectation),
      ["冒烟测试页面", "表单页面 1", "文件上传"],
    );
    assert.equal(r.status, "pass");
    assert.ok(
      !r.assertions.some((a) => a.expectation.includes("全部执行")),
      "不应追加「断言数不足」的失败项",
    );
  });

  test("模型自述「成立」但工具返回不成立 → 以工具为准，判 fail", () => {
    const r = buildReport(
      "断言页面中已出现成功消息",
      "第 1 步完成：页面中已出现成功消息，断言成立。",
      [{ expectation: "成功", verdict: "fail", evidence: "页面中未找到「成功」" }],
    );
    assert.equal(r.status, "fail");
    assert.equal(r.assertions.length, 1);
    assert.equal(r.assertions[0].expectation, "成功");
    assert.equal(r.assertions[0].verdict, "fail");
  });

  test("工具断言条数少于用例断言数时仍报「断言全部执行」失败", () => {
    const r = buildReport(script, "步骤完成：2/5", [
      { expectation: "冒烟测试页面", verdict: "pass", evidence: "x" },
    ]);
    assert.equal(r.status, "fail");
    assert.ok(r.assertions.some((a) => a.expectation.includes("1/3")));
  });

  test("没有工具结果时退回解析结论文本（旧行为不变）", () => {
    const r = buildReport(script, "断言「冒烟测试页面」：成立。页面中包含「冒烟测试页面」");
    assert.equal(r.assertions[0].expectation, "「冒烟测试页面」");
    // 只解析到 1 条（用例里有 3 条）→ 仍旧追加「断言全部执行」失败项
    assert.ok(r.assertions.some((a) => a.expectation.includes("全部执行")));
  });
});

describe("执行完整性校验", () => {
  const script = [
    "### 1 第一步",
    "打开 https://a.com",
    "断言页面包含 A",
    "### 2 第二步",
    "断言页面包含 B",
  ].join("\n");

  test("用例中的断言数被统计", () => {
    assert.equal(countAssertions(script), 2);
  });

  test("叙述性「断言」不计入断言数", () => {
    // 以下「断言」都是被讨论的对象，而非真正的断言行
    for (const s of [
      "断言失败时记录日志",
      "这个断言失败了",
      "断言未通过",
      "这里讨论断言的写法",
      "请检查断言结果",
      "断言的类型有两种",
    ]) {
      assert.equal(countAssertions(s), 0, `不应计入：${s}`);
    }
  });

  test("标题行与说明行不计入断言数（注释不是用例内容）", () => {
    const s = [
      "# 用例标题",
      "> 说明：下载的判定口径是「捕获到且文件名符合期望即断言成立」。",
      "打开页面",
      "断言表格有数据",
      "> 另一个说明：断言不成立时保留文件；这里出现两次断言也不算数",
    ].join("\n");
    assert.equal(countAssertions(s), 1);
  });

  // 回归：说明行里的触发词曾把期望断言数顶高一条，收尾报「断言未全部执行」假失败
  test("说明行里的触发词不再造成「断言未全部执行」假失败", () => {
    const s = ["# 用例", "> 捕获到即断言成立", "打开页面", "断言标题包含 Example"].join("\n");
    assert.equal(countAssertions(s), 1);
    const r = buildReport(s, "断言「标题包含 Example」：成立。证据：标题是 Example");
    assert.equal(r.status, "pass");
    assert.ok(!r.assertions.some((a) => a.expectation.includes("全部执行")));
  });

  test("带引号/冒号的断言行仍被计入", () => {
    assert.equal(countAssertions("断言「用户名」：成立"), 1);
    assert.equal(countAssertions("断言页面包含 A：成立"), 1);
  });

  // 回归：用例里含叙述性「断言」时，早期实现会把期望断言数算多，
  // 导致实际已全部通过的用例被误判为「断言未全部执行」→ 假失败。
  test("叙述性「断言」不会造成假失败", () => {
    const s = ["打开页面", "断言失败时记录日志", "断言标题包含 Example"].join("\n");
    assert.equal(countAssertions(s), 1, "只应统计 1 条真断言");
    const r = buildReport(s, "断言「标题包含 Example」：成立。证据：标题是 Example");
    assert.equal(r.status, "pass", "正常用例不应被判 fail");
    assert.ok(
      !r.assertions.some((a) => a.expectation.includes("全部执行")),
      "不应追加「断言数不足」的失败项",
    );
  });

  test("断言数不足 → fail", () => {
    const r = buildReport(script, "1. 断言页面包含 A：成立");
    assert.equal(r.status, "fail");
    assert.ok(
      r.assertions.some((a) => a.verdict === "fail" && a.expectation.includes("1/2")),
      "应追加一条断言数不足的失败项",
    );
  });

  test("断言齐且全部成立 → pass", () => {
    const r = buildReport(script, "1. 断言页面包含 A：成立\n2. 断言页面包含 B：成立");
    assert.equal(r.status, "pass");
  });

  test("agent 自报步骤未跑满 → fail", () => {
    const r = buildReport(
      script,
      "1. 断言页面包含 A：成立\n2. 断言页面包含 B：成立\n步骤完成：1/2",
    );
    assert.equal(r.status, "fail");
    assert.ok(r.assertions.some((a) => a.expectation.includes("全部步骤执行完成")));
  });

  test("agent 自报步骤跑满 → 不影响判定", () => {
    const r = buildReport(
      script,
      "1. 断言页面包含 A：成立\n2. 断言页面包含 B：成立\n步骤完成：2/2",
    );
    assert.equal(r.status, "pass");
  });
});

// 失败定位：把 agent 自报的「第 k 步」映射回用例原文，报告才能指出卡点。
describe("步骤编号与卡点定位", () => {
  test("按非空行编号，并忽略标题/引用说明行", () => {
    const { numbered, steps } = numberSteps(
      ["# 标题", "> 说明", "", "打开 A", "断言 A"].join("\n"),
    );
    assert.deepEqual(steps, ["打开 A", "断言 A"]);
    assert.ok(numbered.includes("### 步骤 1：打开 A"));
    assert.ok(numbered.includes("### 步骤 2：断言 A"));
  });

  test("抽取执行轨迹：工具调用 + agent 步骤自述", () => {
    const trace = extractTrace(
      [
        "[tool] navigate",
        "第 1 步完成：页面已打开",
        "[tool-ok] snapshot",
        "[tool-error] click",
        "步骤完成：2/4",
      ].join("\n"),
    );
    assert.ok(trace.includes("[tool] navigate"));
    assert.ok(trace.includes("[tool-error] click"));
    assert.ok(trace.some((l) => l.includes("第 1 步完成")));
    assert.ok(trace.some((l) => l.includes("步骤完成：2/4")));
  });

  test("步骤未跑满时，evidence 指出下一步的用例原文", () => {
    const script = ["打开 A", "断言 A", "点击 B", "断言 B"].join("\n");
    const r = buildReport(
      script,
      ["[tool] navigate", "第 1 步完成：打开 A", "步骤完成：1/4"].join("\n"),
    );
    assert.equal(r.status, "fail");
    const a = r.assertions.find((x) => x.expectation.includes("全部步骤执行完成"));
    assert.ok(a, "应有步骤未跑满的失败断言");
    assert.ok(a.evidence.includes("第 2/4 步"), "evidence 应指出下一步编号");
    assert.ok(a.evidence.includes("断言 A"), "evidence 应带上下一步的用例原文");
    assert.ok(a.evidence.includes("第 1 步完成"), "evidence 应带上最后进展");
    assert.deepEqual(r.steps, ["打开 A", "断言 A", "点击 B", "断言 B"]);
    assert.ok(Array.isArray(r.trace) && r.trace.length > 0);
  });

  test("步骤编号与自报总数不一致时，不硬套用例原文", () => {
    const r = buildReport(
      ["打开 A", "断言 A"].join("\n"),
      "步骤完成：1/9",
    );
    const a = r.assertions.find((x) => x.expectation.includes("全部步骤执行完成"));
    assert.ok(a);
    assert.ok(!a.evidence.includes("未执行到的步骤"));
  });
});

// 报告末尾的 token 消耗：累加规则与渲染文案。
describe("Token 用量统计", () => {
  test("累加多次 LLM 调用的用量", () => {
    let u = emptyUsage();
    u = addUsage(u, { input: 100, output: 20, totalTokens: 120 });
    u = addUsage(u, { input: 50, output: 10, cacheRead: 30, totalTokens: 90 });
    assert.equal(u.input, 150);
    assert.equal(u.output, 30);
    assert.equal(u.cacheRead, 30);
    assert.equal(u.total, 210);
    assert.equal(u.calls, 2);
  });

  test("端点未给 totalTokens 时按分项求和", () => {
    const u = addUsage(emptyUsage(), {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 3,
    });
    assert.equal(u.total, 20);
  });

  test("合并两份用量用于套件汇总", () => {
    const a = addUsage(emptyUsage(), { input: 1, output: 2, totalTokens: 3 });
    const b = addUsage(emptyUsage(), { input: 4, output: 5, totalTokens: 9 });
    const m = mergeUsage(a, b);
    assert.equal(m.total, 12);
    assert.equal(m.calls, 2);
  });

  test("渲染成一行文本", () => {
    const line = formatUsage(
      addUsage(emptyUsage(), { input: 100, output: 20, totalTokens: 120 }),
    );
    assert.ok(line.includes("输入 100"));
    assert.ok(line.includes("合计 120"));
    assert.ok(line.includes("LLM 调用 1 次"));
    assert.ok(!line.includes("未返回 usage"));
  });

  test("有调用但 total 为 0 时标注端点未返回 usage", () => {
    assert.ok(formatUsage(addUsage(emptyUsage(), {})).includes("端点未返回 usage"));
  });

  test("无用量数据时给出不可用提示", () => {
    assert.ok(formatUsage(undefined).includes("不可用"));
  });
});

describe("report durationMs", () => {
  test("summarizeSuite 逐场景带 durationMs，整体为各场景之和", () => {
    const mk = (status, durationMs) => ({
      name: "s-" + status,
      report: {
        status,
        assertions: [],
        transcript: "",
        ...(durationMs === undefined ? {} : { durationMs }),
      },
      usage: emptyUsage(),
    });
    const summary = summarizeSuite([
      mk("pass", 1000),
      mk("fail", 2500),
      mk("cancelled", undefined),
    ]);
    assert.equal(summary.scenarios.length, 3);
    assert.equal(summary.scenarios[0].durationMs, 1000);
    assert.equal(summary.scenarios[1].durationMs, 2500);
    assert.equal(summary.scenarios[2].durationMs, undefined);
    assert.equal(summary.durationMs, 3500);
    // 无任何场景带耗时时整体不写字段（JSON 向后兼容）
    const bare = summarizeSuite([mk("pass", undefined)]);
    assert.equal(bare.durationMs, undefined);
    assert.ok(!("durationMs" in bare.scenarios[0]));
  });
});

describe("summarizeSuite 明细 summary/skipped", () => {
  const mk = (over = {}) => ({
    name: "s",
    report: {
      status: "pass",
      assertions: [],
      transcript: "",
      ...over,
    },
    usage: emptyUsage(),
  });

  test("成员带 summary/skipped 时复制进 ScenarioDetail", () => {
    const summary = summarizeSuite([
      mk({
        summary: "回放 5 步，执行 4 步",
        skipped: ["第 3 步：点击弹窗关闭按钮"],
      }),
    ]);
    const sc = summary.scenarios[0];
    assert.equal(sc.summary, "回放 5 步，执行 4 步");
    assert.deepEqual(sc.skipped, ["第 3 步：点击弹窗关闭按钮"]);
  });

  test("成员未带 summary/skipped 时键不出现（JSON 向后兼容）", () => {
    const summary = summarizeSuite([mk()]);
    assert.ok(!("summary" in summary.scenarios[0]));
    assert.ok(!("skipped" in summary.scenarios[0]));
    const parsed = JSON.parse(JSON.stringify(summary.scenarios[0]));
    assert.ok(!("summary" in parsed));
    assert.ok(!("skipped" in parsed));
  });
});
