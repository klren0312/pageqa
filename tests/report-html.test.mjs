import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  escapeHtml,
  formatDurationMs,
  renderHtml,
  htmlReportFilePath,
  writeHtmlReport,
  writeHtmlReportSafe,
} from "../dist/report-html.js";
import { getLocale, setLocale } from "../dist/i18n.js";

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

  test("空 scenarios 仍是套件视图：零计数 + 套件标题 + 汇总行", () => {
    const html = renderHtml(
      base({
        status: "pass",
        scenarios: [],
        assertions: [],
        summary: "共 0 个场景，通过 0 个",
      }),
    );
    assert.ok(html.includes("页面测试套件报告"));
    assert.ok(html.includes("汇总: 共 0 个场景，通过 0 个"));
    assert.ok(html.includes("<b>0</b>总场景"));
    assert.ok(!html.includes("<b>1</b>总场景"));
    assert.ok(html.includes("<b>0</b>通过"));
  });

  test("套件场景节渲染 summary 与 skipped", () => {
    const html = renderHtml(
      base({
        status: "pass",
        assertions: [],
        scenarios: [
          {
            name: "A 回放",
            status: "pass",
            steps: [],
            trace: [],
            assertions: [],
            summary: "回放 5 步，执行 4 步",
            skipped: ["第 3 步：<b>关闭</b>弹窗"],
          },
        ],
      }),
    );
    assert.ok(html.includes("摘要: 回放 5 步，执行 4 步"));
    assert.ok(html.includes("跳过 1 步"));
    assert.ok(html.includes("第 3 步：&lt;b&gt;关闭&lt;/b&gt;弹窗"));
    assert.ok(!html.includes("<b>关闭</b>弹窗"));
  });

  test("套件场景节未带 summary/skipped 时不渲染对应块", () => {
    const html = renderHtml(
      base({
        status: "pass",
        assertions: [],
        summary: "共 1 个场景，通过 1 个",
        scenarios: [
          { name: "A", status: "pass", steps: [], trace: [], assertions: [] },
        ],
      }),
    );
    assert.ok(!html.includes("跳过 0 步"));
    assert.ok(!html.includes("摘要: 回放"));
  });

  test("lang 跟随当前语种", () => {
    const prev = getLocale();
    try {
      setLocale("zh");
      assert.ok(renderHtml(base()).includes('<html lang="zh">'));
      setLocale("en");
      assert.ok(renderHtml(base()).includes('<html lang="en">'));
    } finally {
      setLocale(prev);
    }
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

describe("htmlReportFilePath", () => {
  test("默认在 pageqa-report 下，时间戳格式固定", () => {
    const p = htmlReportFilePath(undefined, new Date("2026-09-23T08:09:10"));
    assert.equal(
      p.replace(/\\/g, "/"),
      "pageqa-report/report-20260923-080910.html",
    );
  });
});

describe("writeHtmlReport", () => {
  test("自动建目录，内容为 renderHtml 输出", () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-html-"));
    try {
      const report = base({ durationMs: 500 });
      const { path } = writeHtmlReport(report, dir, new Date("2026-09-23T15:30:01"));
      assert.equal(path, htmlReportFilePath(dir, new Date("2026-09-23T15:30:01")));
      assert.ok(path.includes("report-20260923-153001.html"));
      assert.ok(existsSync(path));
      const html = readFileSync(path, "utf8");
      assert.ok(html.includes("PASS"));
      assert.ok(html.includes("标题包含 pageqa"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeHtmlReportSafe 写失败时吞掉异常、不抛出", () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-html-safe-"));
    try {
      const blocker = join(dir, "blocker");
      writeFileSync(blocker, "not a dir");
      // baseDir 指向一个文件（不是目录）→ mkdir 必失败 → safe 吞掉
      assert.equal(writeHtmlReportSafe(base(), blocker), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
