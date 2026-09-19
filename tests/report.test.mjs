import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildReport, countAssertions } from "../dist/report.js";

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
