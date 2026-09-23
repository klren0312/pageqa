import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, formatDurationMs, renderHtml } from "../dist/report-html.js";

const base = (over = {}) => ({
  status: "pass",
  assertions: [{ expectation: "标题包含 pageqa", verdict: "pass", evidence: "页面中包含「pageqa」" }],
  transcript: "",
  summary: "全部断言成立",
  ...over,
});

describe("renderHtml", () => {
  test("单场景：状态徽章、断言、摘要、耗时", () => {
    // 计划用例漏了 trace：断言 `<details` 需要有轨迹才渲染折叠块，此处补最小轨迹。
    const html = renderHtml(base({ durationMs: 1234, trace: ["[tool] navigate"] }));
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.ok(html.includes("PASS"));
    assert.ok(html.includes("标题包含 pageqa"));
    assert.ok(html.includes("页面中包含「pageqa」"));
    assert.ok(html.includes("全部断言成立"));
    assert.ok(html.includes("1.2s"));
    assert.ok(html.includes("<details"));
  });

  test("套件：汇总计数与逐场景节", () => {
    const html = renderHtml(
      base({
        status: "fail",
        durationMs: 3000,
        scenarios: [
          { name: "A 登录", status: "pass", steps: ["打开页面"], trace: ["[tool] navigate"], assertions: [] },
          { name: "B 下单", status: "cancelled", steps: [], trace: [], assertions: [], cancelReason: undefined },
        ],
        assertions: [],
      }),
    );
    assert.ok(html.includes("A 登录"));
    assert.ok(html.includes("B 下单"));
    assert.ok(html.includes("FAIL"));
    assert.ok(html.includes("navigate"));
  });

  test("cancelled 徽章用 statusTag 中文口径", () => {
    const html = renderHtml(base({ status: "cancelled", cancelReason: "用户中止" }));
    assert.ok(html.includes("已取消"));
    assert.ok(html.includes("用户中止"));
  });

  test("场景名 HTML 转义，不产生可执行标签", () => {
    const html = renderHtml(
      base({
        scenarios: [
          { name: "<script>alert(1)</script>", status: "pass", steps: [], trace: [], assertions: [] },
        ],
      }),
    );
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.ok(html.includes("&lt;script&gt;"));
  });
});

describe("escapeHtml / formatDurationMs", () => {
  test("escapeHtml 转义五个危险字符", () => {
    assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });

  test("formatDurationMs 分钟与秒", () => {
    assert.equal(formatDurationMs(1234), "1.2s");
    assert.equal(formatDurationMs(900), "0.9s");
    assert.equal(formatDurationMs(65_000), "1m5s");
  });
});
