# HTML 测试报告 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每次 pageqa 运行结束后，在 `./pageqa-report/report-YYYYMMDD-HHmmss.html` 自动生成一份自包含 HTML 测试报告（汇总 + 逐场景明细 + 可折叠 trace），且不改变 stdout 契约。

**Architecture:** 新增纯函数渲染模块 `src/report-html.ts`（从 `TestReport` 渲染内联 CSS/JS 的单文件 HTML）；`TestReport`/`ScenarioDetail` 新增可选 `durationMs`；在 `src/index.ts` 的批处理、回放、交互三条出口的 stdout 打印之后统一调用 `writeHtmlReportSafe()` 写盘，路径与失败只走 stderr（`log.info`）。

**Tech Stack:** TypeScript（ESM，Node ≥22.19）、`node:test` 单测、零新依赖。规格见 `docs/superpowers/specs/2026-09-23-html-report-design.md`。

## Global Constraints

- 不改 stdout 契约（ADR-0002）：HTML 路径/失败信息只经 `info()`（stderr sink），绝不 `process.stdout.write`。
- HTML 写盘失败不得改变退出码：写盘包在 try/catch 里，仅打 warning。
- `durationMs` 为**可选**字段：未测得时不写入该 key（JSON 与历史逐字兼容，不出现 `durationMs: undefined` 之外的噪声字段）。
- 所有动态文本写入 HTML 前必须经 `escapeHtml`（场景名、断言、证据、trace、summary、origin、script、steps、cancelReason、usage 行）。
- 文案：共享标签复用 `report.*`，HTML 专属标签新增 `reportHtml.*`、落盘日志新增 `log.htmlReport*`，zh/en 双份（`src/i18n.ts`）。
- 输出目录固定 `pageqa-report/`（相对 cwd），文件名 `report-YYYYMMDD-HHmmss.html`；`.gitignore` 增加 `pageqa-report/`。
- 零新 dependencies；HTML 自包含（内联 `<style>`/`<script>`，无 CDN）。
- 测试命令：`npm run test:unit`（含 `pretest`/内联 `npm run build`）；提交信息沿用仓库既有风格（`feat:`/`fix:`/`docs:`）。

---

### Task 1: `durationMs` 字段与装配

**Files:**
- Modify: `src/report.ts`（`TestReport`、`ScenarioDetail`、`summarizeSuite`）
- Modify: `src/agent.ts`（`finalizeResult`、`runSuite`）
- Modify: `src/replay.ts`（`replayScenario`）
- Test: `tests/report.test.mjs`

**Interfaces:**
- Consumes: 现有 `buildReport`/`summarizeSuite`/`TestReport`（`src/report.ts`）；`AgentSession.startedAt`（`src/agent.ts:298`）。
- Produces:
  - `TestReport.durationMs?: number` — 单场景运行墙钟毫秒；套件为整体跨度（`runSuite`）或各场景之和（`summarizeSuite` 默认）。
  - `ScenarioDetail.durationMs?: number` — 场景明细耗时。
  - 后续任务的 HTML 渲染与 JSON 文档都依赖这两个可选字段。

- [ ] **Step 1: 写失败测试（report 字段与汇总）**

在 `tests/report.test.mjs` 顶部 import 中补上 `summarizeSuite`（现有 import 列表见文件头 3-12 行），并在文件末尾追加：

```js
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:unit`
Expected: FAIL — `summarizeSuite is not defined`（或 `summary.scenarios[0].durationMs` 为 undefined 断言失败）。build 可能先过（字段尚不存在，测试仍因 undefined 失败）。

- [ ] **Step 3: 实现 `report.ts` 字段与汇总**

`src/report.ts` — `TestReport` 接口（第 47 行 `scenarios?: ScenarioDetail[];` 之前）加：

```ts
  /** 本次运行耗时（毫秒）：单场景为墙钟时间；套件为整体跨度或各场景之和。未采集时不写。 */
  durationMs?: number;
```

`ScenarioDetail` 接口（第 58 行 `origin?: string;` 之后）加：

```ts
  /** 该场景耗时（毫秒）；成员报告未采集时不写。 */
  durationMs?: number;
```

`summarizeSuite` 返回对象中，`scenarios: members.map(...)` 内在 `...(m.origin ? { origin: m.origin } : {})` **之前**加一行：

```ts
      ...(typeof m.report.durationMs === "number"
        ? { durationMs: m.report.durationMs }
        : {}),
```

并在 `return {` 之后、`status: overall,` 之前加整体耗时（仅在至少一个成员有值时写）：

```ts
  const durations = members
    .map((m) => m.report.durationMs)
    .filter((d): d is number => typeof d === "number");
  const durationMs = durations.length > 0
    ? durations.reduce((a, b) => a + b, 0)
    : undefined;
```

return 对象里加：

```ts
    ...(durationMs === undefined ? {} : { durationMs }),
```

- [ ] **Step 4: 运行 report 单测确认通过**

Run: `npm run build && node --test tests/report.test.mjs`
Expected: PASS（全部既有 + 新 `report durationMs` 用例）

- [ ] **Step 5: `finalizeResult` 写入单场景耗时**

`src/agent.ts` `finalizeResult`：在 `const report = buildReport(...)`（约 736 行）之后、`if (opts.scriptPath)` 之前加：

```ts
  report.durationMs = Date.now() - startedAt;
```

- [ ] **Step 6: `runSuite` 写入整体墙钟跨度**

`src/agent.ts` `runSuite`：在 `info(t("log.suiteStart", ...))` 之前加 `const suiteStartedAt = Date.now();`；在 `const summary = summarizeSuite(...)` 之后加：

```ts
  summary.durationMs = Date.now() - suiteStartedAt;
```

（`summarizeSuite` 给出的「和」在此被整体墙钟覆盖；逐场景 `ScenarioDetail.durationMs` 不受影响。）

- [ ] **Step 7: 回放场景写入耗时**

`src/replay.ts` `replayScenario`：在 `const now = opts.now ?? new Date();` 之后加 `const startedAt = Date.now();`；在构造 `report` 字面量时在 `usage: emptyUsage(),` 后加：

```ts
    durationMs: Date.now() - startedAt,
```

多场景回放走 `summarizeSuite` 默认「和」，无需额外代码。

- [ ] **Step 8: 跑全部单测**

Run: `npm run test:unit`
Expected: PASS（report/replay/agent/tui 等全绿）

- [ ] **Step 9: Commit**

```bash
git add src/report.ts src/agent.ts src/replay.ts tests/report.test.mjs
git commit -m "feat: 报告增加 durationMs 耗时字段"
```

---

### Task 2: HTML 渲染器 `renderHtml`

**Files:**
- Create: `src/report-html.ts`
- Modify: `src/i18n.ts`（zh `report.suiteSummaryCancelled` 之后约 317 行；en 对应键之后约 801 行）
- Test: `tests/report-html.test.mjs`
- Modify: `package.json`（`scripts.test:unit` 追加 `tests/report-html.test.mjs`）

**Interfaces:**
- Consumes: `TestReport`/`ScenarioDetail`/`statusTag`/`formatUsage`/`TRACE_TAIL_LINES`（`src/report.ts`）；`t()`（`src/i18n.ts`）；Task 1 的 `durationMs`。
- Produces:
  - `escapeHtml(text: string): string`
  - `formatDurationMs(ms: number): string`
  - `renderHtml(report: TestReport): string` — 完整 HTML 文档字符串（本任务不写盘）。
  - i18n keys `reportHtml.*`（zh/en）。

- [ ] **Step 1: 写失败测试**

创建 `tests/report-html.test.mjs`：

```js
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
    const html = renderHtml(base({ durationMs: 1234 }));
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run build && node --test tests/report-html.test.mjs`
Expected: FAIL — Cannot find module `../dist/report-html.js`

- [ ] **Step 3: 增加 i18n 键（zh）**

`src/i18n.ts` zh 段，`"report.suiteSummaryCancelled"` 行之后插入：

```ts
    // ── HTML 报告（src/report-html.ts）──
    "reportHtml.generatedAt": "生成时间: {time}",
    "reportHtml.duration": "耗时: {dur}",
    "reportHtml.durationLabel": "耗时",
    "reportHtml.total": "总场景",
    "reportHtml.countPass": "通过",
    "reportHtml.countFail": "失败",
    "reportHtml.countCancelled": "已取消",
    "reportHtml.scenario": "场景",
    "reportHtml.steps": "用例步骤",
    "reportHtml.expectation": "期望",
    "reportHtml.verdict": "结论",
    "reportHtml.evidence": "证据",
    "reportHtml.trace": "执行轨迹",
    "reportHtml.expandAll": "全部展开",
    "reportHtml.collapseAll": "全部收起",
    "reportHtml.noAssertions": "无断言记录",
```

- [ ] **Step 4: 增加 i18n 键（en）**

`src/i18n.ts` en 段，`"report.suiteSummaryCancelled"` 对应行之后插入：

```ts
    "reportHtml.generatedAt": "generated at: {time}",
    "reportHtml.duration": "duration: {dur}",
    "reportHtml.durationLabel": "duration",
    "reportHtml.total": "total",
    "reportHtml.countPass": "pass",
    "reportHtml.countFail": "fail",
    "reportHtml.countCancelled": "cancelled",
    "reportHtml.scenario": "scenario",
    "reportHtml.steps": "case steps",
    "reportHtml.expectation": "expectation",
    "reportHtml.verdict": "verdict",
    "reportHtml.evidence": "evidence",
    "reportHtml.trace": "execution trace",
    "reportHtml.expandAll": "expand all",
    "reportHtml.collapseAll": "collapse all",
    "reportHtml.noAssertions": "no assertions recorded",
```

（若 en 键名与 zh 不对齐导致 `t()` 缺键，以 zh 键名为准补齐 en。）

- [ ] **Step 5: 实现 `src/report-html.ts` 渲染部分**

创建 `src/report-html.ts`：

```ts
/**
 * 自包含 HTML 测试报告：从 TestReport 渲染单文件页面（内联 CSS/JS，零依赖）。
 *
 * 只负责「数据 → HTML 字符串」；写盘见 writeHtmlReport。所有动态文本必须经
 * escapeHtml——场景名/断言证据来自用例与页面，不能让它们把标签结构打破。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { t } from "./i18n.js";
import {
  formatUsage,
  statusTag,
  type AssertionResult,
  type ScenarioDetail,
  type TestReport,
} from "./report.js";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 毫秒 → 人类可读：`1.2s` / `1m5s`。 */
export function formatDurationMs(ms: number): string {
  if (ms < 60_000) return (ms / 1000).toFixed(1) + "s";
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

function badge(status: "pass" | "fail" | "cancelled"): string {
  return `<span class="badge b-${status}">${escapeHtml(statusTag(status))}</span>`;
}

function assertionsTable(list: AssertionResult[]): string {
  if (list.length === 0) return `<p class="muted">${escapeHtml(t("reportHtml.noAssertions"))}</p>`;
  const rows = list
    .map(
      (a) =>
        `<tr><td>${escapeHtml(a.expectation)}</td>` +
        `<td>${badge(a.verdict)}</td>` +
        `<td>${escapeHtml(a.evidence ?? "")}</td></tr>`,
    )
    .join("");
  return (
    `<table><thead><tr>` +
    `<th>${escapeHtml(t("reportHtml.expectation"))}</th>` +
    `<th>${escapeHtml(t("reportHtml.verdict"))}</th>` +
    `<th>${escapeHtml(t("reportHtml.evidence"))}</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>`
  );
}

function stepsList(steps: string[] | undefined): string {
  if (!steps || steps.length === 0) return "";
  const items = steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("");
  return (
    `<h3>${escapeHtml(t("reportHtml.steps"))}</h3><ol class="steps">${items}</ol>`
  );
}

function traceDetails(trace: string[] | undefined): string {
  if (!trace || trace.length === 0) return "";
  const body = trace.map((line) => escapeHtml(line)).join("\n");
  return (
    `<details class="trace"><summary>${escapeHtml(t("reportHtml.trace"))}（${trace.length}）</summary>` +
    `<pre>${body}</pre></details>`
  );
}

/** 逐场景明细节（套件）；无 scenarios 时由调用方退回单场景视图。 */
function scenarioSection(sc: ScenarioDetail, index: number, total: number): string {
  const parts: string[] = [];
  parts.push(
    `<section class="scenario"><h2>` +
      `${escapeHtml(t("reportHtml.scenario"))} ${index + 1}/${total}: ` +
      `${escapeHtml(sc.name)} ${badge(sc.status)}` +
      (typeof sc.durationMs === "number"
        ? ` <span class="muted">${escapeHtml(
            t("reportHtml.duration", { dur: formatDurationMs(sc.durationMs) }),
          )}</span>`
        : "") +
      (sc.origin
        ? ` <span class="muted">${escapeHtml(t("report.scenarioOrigin", { origin: sc.origin }))}</span>`
        : "") +
      `</h2>`,
  );
  parts.push(stepsList(sc.steps));
  parts.push(assertionsTable(sc.assertions));
  parts.push(traceDetails(sc.trace));
  parts.push(`</section>`);
  return parts.join("\n");
}

/** 单场景视图：直接渲染报告自身的断言/步骤/轨迹/摘要。 */
function singleSection(r: TestReport): string {
  const parts: string[] = [];
  parts.push(
    `<section class="scenario"><h2>${escapeHtml(
      typeof r.durationMs === "number"
        ? t("reportHtml.duration", { dur: formatDurationMs(r.durationMs) })
        : t("report.title"),
    )} ${badge(r.status)}</h2>`,
  );
  if (r.cancelReason) {
    parts.push(`<p>${escapeHtml(t("report.cancelled", { reason: r.cancelReason }))}</p>`);
  }
  parts.push(stepsList(r.steps));
  parts.push(assertionsTable(r.assertions));
  if (r.skipped?.length) {
    const items = r.skipped.map((s) => `<li>${escapeHtml(s)}</li>`).join("");
    parts.push(
      `<h3>${escapeHtml(t("report.skipped", { n: r.skipped.length }))}</h3>` +
        `<ul class="skipped">${items}</ul>`,
    );
  }
  if (r.summary) {
    parts.push(
      `<p class="summary">${escapeHtml(t("report.summary", { text: r.summary }))}</p>`,
    );
  }
  if (r.script) {
    parts.push(`<p>${escapeHtml(t("report.script", { path: r.script }))}</p>`);
  }
  parts.push(traceDetails(r.trace));
  parts.push(`</section>`);
  return parts.join("\n");
}

function countUp(list: { status: TestReport["status"] }[]): {
  total: number;
  pass: number;
  fail: number;
  cancelled: number;
} {
  return {
    total: list.length,
    pass: list.filter((s) => s.status === "pass").length,
    fail: list.filter((s) => s.status === "fail").length,
    cancelled: list.filter((s) => s.status === "cancelled").length,
  };
}

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { font-family: system-ui, "Segoe UI", sans-serif; margin: 0; background: #f6f7f9; color: #1f2328; }
main { max-width: 960px; margin: 0 auto; padding: 24px 16px 48px; }
header.card, section.scenario { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 16px 20px; margin-bottom: 16px; }
h1 { font-size: 1.4rem; margin: 0 0 8px; }
h2 { font-size: 1.1rem; margin: 0 0 12px; }
h3 { font-size: 0.95rem; margin: 16px 0 8px; }
.badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 0.8rem; font-weight: 600; }
.b-pass { background: #dafbe1; color: #116329; }
.b-fail { background: #ffebe9; color: #cf222e; }
.b-cancelled { background: #fff8c5; color: #7d4e00; }
.stats { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 8px; font-size: 0.9rem; }
.stats b { font-size: 1.2rem; display: block; }
.muted { color: #59636e; font-weight: 400; font-size: 0.85rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; margin: 8px 0; }
th, td { border: 1px solid #d0d7de; padding: 6px 8px; text-align: left; vertical-align: top; }
th { background: #f6f8fa; }
ol.steps, ul.skipped { font-size: 0.9rem; padding-left: 1.4em; }
ol.steps li, ul.skipped li { margin: 4px 0; }
details.trace { margin-top: 12px; }
details.trace summary { cursor: pointer; font-weight: 600; font-size: 0.9rem; }
details.trace pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 10px; overflow-x: auto; font-size: 0.8rem; white-space: pre-wrap; word-break: break-all; }
.summary { background: #f6f8fa; border-left: 3px solid #0969da; padding: 8px 12px; font-size: 0.9rem; }
.actions { margin: 0 0 12px; }
.actions button { font: inherit; font-size: 0.85rem; padding: 4px 10px; margin-right: 8px; cursor: pointer; }
footer { color: #59636e; font-size: 0.8rem; text-align: center; }
`.trim();

const JS = `
function setPageDetails(open) {
  document.querySelectorAll("details.trace").forEach(function (d) { d.open = open; });
}
`.trim();

/**
 * 渲染完整 HTML 文档。
 * 套件（有 scenarios）显示汇总计数 + 逐场景节；单场景显示徽章/耗时/断言/轨迹。
 */
export function renderHtml(report: TestReport): string {
  const scenarios = report.scenarios ?? [];
  const isSuite = scenarios.length > 0;
  const counts = isSuite
    ? countUp(scenarios)
    : countUp([report]);
  const title = isSuite ? t("report.titleSuite") : t("report.title");
  const generatedAt = new Date().toLocaleString();
  const usageLine = formatUsage(report.usage, report.mode);

  const stats = [
    `<div class="stat"><b>${counts.total}</b>${escapeHtml(t("reportHtml.total"))}</div>`,
    `<div class="stat"><b>${counts.pass}</b>${escapeHtml(t("reportHtml.countPass"))}</div>`,
    `<div class="stat"><b>${counts.fail}</b>${escapeHtml(t("reportHtml.countFail"))}</div>`,
    `<div class="stat"><b>${counts.cancelled}</b>${escapeHtml(t("reportHtml.countCancelled"))}</div>`,
    typeof report.durationMs === "number"
      ? `<div class="stat"><b>${escapeHtml(formatDurationMs(report.durationMs))}</b>${escapeHtml(t("reportHtml.durationLabel"))}</div>`
      : "",
  ].join("");

  const body = isSuite
    ? scenarios.map((sc, i) => scenarioSection(sc, i, scenarios.length)).join("\n")
    : singleSection(report);

  const summaryBlock = isSuite && report.summary
    ? `<p class="summary">${escapeHtml(t("report.summaryLine", { text: report.summary }))}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${CSS}
</style>
</head>
<body>
<main>
<header class="card">
  <h1>${escapeHtml(title)} ${badge(report.status)}</h1>
  <p class="muted">${escapeHtml(t("reportHtml.generatedAt", { time: generatedAt }))}${
    report.mode === "replay" ? " · " + escapeHtml(t("report.modeReplay")) : ""
  }</p>
  <div class="stats">${stats}</div>
  <p>${escapeHtml(usageLine)}</p>
  ${report.script ? `<p>${escapeHtml(t("report.script", { path: report.script }))}</p>` : ""}
  <div class="actions">
    <button type="button" onclick="setPageDetails(true)">${escapeHtml(t("reportHtml.expandAll"))}</button>
    <button type="button" onclick="setPageDetails(false)">${escapeHtml(t("reportHtml.collapseAll"))}</button>
  </div>
  ${summaryBlock}
</header>
${body}
<footer>pageqa</footer>
</main>
<script>
${JS}
</script>
</body>
</html>
`;
}
```



- [ ] **Step 6: 跑 HTML 单测确认通过**

Run: `npm run build && node --test tests/report-html.test.mjs`
Expected: PASS

若 en 缺 `reportHtml.*` 键导致输出回落成 key 字符串，回 Step 4 补齐后重跑。

- [ ] **Step 7: 注册进 test:unit 并跑全量**

`package.json` `scripts.test:unit` 在 `tests/report.test.mjs` 之后加入 `tests/report-html.test.mjs`：

```json
"test:unit": "npm run build && node --test tests/report.test.mjs tests/report-html.test.mjs tests/replay.test.mjs tests/snapshot.test.mjs tests/tui.test.mjs tests/agent.test.mjs tests/navigate-diagnosis.test.mjs tests/credentials.test.mjs tests/model-catalog.test.mjs",
```

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/report-html.ts src/i18n.ts tests/report-html.test.mjs package.json
git commit -m "feat: 新增 HTML 报告渲染器 renderHtml"
```

---

### Task 3: `writeHtmlReport` 写盘与安全封装

**Files:**
- Modify: `src/report-html.ts`（文件末尾追加）
- Modify: `src/i18n.ts`（zh `log.*` 区与 en 对应区，建议插在 zh `"report.suiteSummaryCancelled"` 后的 reportHtml 块之后、nav 块之前；en 同理）
- Modify: `.gitignore`
- Test: `tests/report-html.test.mjs`

**Interfaces:**
- Consumes: `renderHtml`（Task 2）；`info()`（`src/log.ts:58`）。
- Produces:
  - `htmlReportFilePath(baseDir?: string, now?: Date): string` — 如 `pageqa-report/report-20260923-153001.html`。
  - `writeHtmlReport(report: TestReport, baseDir?: string, now?: Date): { path: string }` — 建目录并写 UTF-8 文件。
  - `writeHtmlReportSafe(report: TestReport): void` — try/catch + `info` 日志；永不抛错。
  - i18n keys `log.htmlReportWritten` / `log.htmlReportFailed`（zh/en）。

- [ ] **Step 1: 写失败测试**

`tests/report-html.test.mjs` 末尾追加（用 `node:fs`/`node:os`/`node:path`；文件顶部补 import）：

```js
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  htmlReportFilePath,
  writeHtmlReport,
  writeHtmlReportSafe,
} from "../dist/report-html.js";

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
```

`writeHtmlReportSafe` 签名：

```ts
export function writeHtmlReportSafe(
  report: TestReport,
  baseDir?: string,
  now?: Date,
): void
```

（调用方不传 baseDir 即默认 `pageqa-report`；返回值恒为 `undefined`，测试用它确认未抛错。）

- [ ] **Step 2: 运行确认失败**

Run: `npm run build && node --test tests/report-html.test.mjs`
Expected: FAIL — `htmlReportFilePath is not defined` / export 不存在

- [ ] **Step 3: i18n 落盘日志键**

zh（`reportHtml` 块末尾，`reportHtml.noAssertions` 之后）：

```ts
    "log.htmlReportWritten": "HTML 报告已生成: {path}",
    "log.htmlReportFailed": "HTML 报告生成失败: {msg}",
```

en（对应位置）：

```ts
    "log.htmlReportWritten": "HTML report written: {path}",
    "log.htmlReportFailed": "HTML report write failed: {msg}",
```

- [ ] **Step 4: 实现写盘函数**

`src/report-html.ts` 顶部 import 改为：

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { t } from "./i18n.js";
import { info } from "./log.js";
import {
  formatUsage,
  statusTag,
  type AssertionResult,
  type ScenarioDetail,
  type TestReport,
} from "./report.js";
```

文件末尾追加：

```ts
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 报告文件路径：`<baseDir>/report-YYYYMMDD-HHmmss.html`（时间戳防覆盖）。 */
export function htmlReportFilePath(baseDir?: string, now?: Date): string {
  const d = now ?? new Date();
  const name =
    `report-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.html`;
  return join(baseDir ?? "pageqa-report", name);
}

/** 渲染并写盘（自动创建目录）。失败抛给调用方（safe 版负责兜底）。 */
export function writeHtmlReport(
  report: TestReport,
  baseDir?: string,
  now?: Date,
): { path: string } {
  const path = htmlReportFilePath(baseDir, now);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderHtml(report), "utf8");
  return { path };
}

/**
 * 写 HTML 报告且永不抛错：路径经 info() 打到 stderr（TUI 下进视口）。
 * 失败只 warning——HTML 是旁路产物，绝不能改退出码或顶掉 stdout 报告。
 */
export function writeHtmlReportSafe(
  report: TestReport,
  baseDir?: string,
  now?: Date,
): void {
  try {
    const { path } = writeHtmlReport(report, baseDir, now);
    info(t("log.htmlReportWritten", { path }));
  } catch (err) {
    info(
      t("log.htmlReportFailed", {
        msg: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
```

- [ ] **Step 5: `.gitignore` 忽略报告目录**

`.gitignore` 末尾加一行：

```
pageqa-report/
```

- [ ] **Step 6: 跑单测确认通过**

Run: `npm run build && node --test tests/report-html.test.mjs`
Expected: PASS

- [ ] **Step 7: 全量单测**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/report-html.ts src/i18n.ts tests/report-html.test.mjs .gitignore
git commit -m "feat: HTML 报告写盘 pageqa-report/ 并忽略该目录"
```

---

### Task 4: 三条出口接线（批处理 / 回放 / 交互）

**Files:**
- Modify: `src/index.ts`（import；`interactiveMode` ~397-404；`replayMode` ~455-457；批处理 `main` ~612-617）
- Test: `tests/smoke.test.mjs`（只读确认，不改 stdout 断言；若 smoke 以子进程跑 pageqa，确认其 cwd 下生成 `pageqa-report/` 不影响断言）

**Interfaces:**
- Consumes: `writeHtmlReportSafe(report)`（Task 3）；`AgentRunResult.report` / `ReplayRunResult.report` / `InteractiveResult.report`。
- Produces: 每次成功产出报告的运行都会在 cwd 的 `pageqa-report/` 落一份 HTML；stdout 字节序列不变。

- [ ] **Step 1: import**

`src/index.ts` 顶部 import 区（`TestReport` type import 附近，约 12 行）加：

```ts
import { writeHtmlReportSafe } from "./report-html.js";
```

- [ ] **Step 2: 批处理出口（runAgent / runSuite）**

`main()` 中 `process.stdout.write(out + "\n");`（约 616 行）之后、`return exitCodeFor(result.report);` 之前加：

```ts
    writeHtmlReportSafe(result.report);
```

- [ ] **Step 3: 回放出口**

`replayMode()` 中 `process.stdout.write(out + "\n");`（约 457 行）之后、`return result.report.status === "pass" ? 0 : 1;` 之前加：

```ts
    writeHtmlReportSafe(result.report);
```

- [ ] **Step 4: 交互退出出口**

`interactiveMode()` 中 `process.stdout.write(out + "\n");`（约 399 行）之后、`if (scriptError)` 之前加：

```ts
  writeHtmlReportSafe(result.report);
```

（此时 `runInteractive` 已返回、日志 sink 已复位到 stderr，路径行不会撕 TUI。scriptError 分支仍保留：先落 HTML 再按脚本错误改退出码。）

- [ ] **Step 5: 构建 + 全量单测**

Run: `npm run test:unit`
Expected: PASS

Run: `npm test`（smoke）
Expected: PASS — smoke 的 stdout 断言不受 HTML 旁路影响；若 smoke 在仓库根目录执行，会在 `pageqa-report/` 留下报告（已被 gitignore）。

- [ ] **Step 6: 手工验证（批处理路径的最小确认）**

Run: `node -e "const { writeHtmlReportSafe } = await import('./dist/report-html.js'); writeHtmlReportSafe({ status:'pass', assertions:[{expectation:'x',verdict:'pass'}], transcript:'' });"`
Expected: stderr 出现 `HTML 报告已生成: pageqa-report/report-....html`；文件可打开且含 PASS 徽章。

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat: 运行结束自动生成 HTML 测试报告"
```

---

### Task 5: 文档同步

**Files:**
- Modify: `README.md`（报告示例区约 250-280 行、字段/`--out`/退出码区约 405-422 行）
- Modify: `README.zh-CN.md`（对应报告章节）
- Modify: `CONTEXT.md`（批处理模式条目）
- Modify: `package.json`（`description` 可选提一句 HTML 报告）

**Interfaces:**
- Consumes: Task 1-4 的行为与路径约定。
- Produces: 用户可见文档与规格一致。

- [ ] **Step 1: README 双语补 HTML 报告**

在两份 README 的报告说明区（文本/JSON/`--out` 附近）各加一小节，zh 版示例：

```markdown
### HTML 报告

每次运行结束（批处理、回放、交互退出）都会在当前目录生成一份可直接用浏览器打开的
自包含 HTML 报告，路径与生成时间打印在 stderr：

```text
pageqa-report/report-20260923-153001.html
```

- 文件名带时间戳，多次运行互不覆盖；`pageqa-report/` 已在 `.gitignore` 中忽略。
- 内容：整体汇总（场景数/通过/失败/已取消/耗时/token）、逐场景状态与断言、可折叠执行轨迹。
- HTML 是旁路产物：**不影响** stdout 报告契约与退出码；写盘失败仅 stderr 警告。
- JSON 报告（`--json`/`--out`）新增可选字段 `durationMs`（毫秒），旧报告无此字段。
```

en 版对应翻译（标题 `### HTML report`，路径与行为描述一致）。

- [ ] **Step 2: CONTEXT.md 批处理模式补一句**

`CONTEXT.md`「批处理模式（Batch Mode）」条目中「stdout 只放最终报告」后追加：

```markdown
；HTML 报告旁路写入 `pageqa-report/`（不算 stdout 输出）
```

- [ ] **Step 3: 确认 durationMs 字段表**

README 字段说明处（JSON trace 字段列表附近）加一行：

```markdown
- `durationMs`（可选，毫秒）：本场景/套件耗时；套件逐场景明细 `scenarios[].durationMs` 同义。
```

- [ ] **Step 4: 构建无回归**

Run: `npm run test:unit && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add README.md README.zh-CN.md CONTEXT.md
git commit -m "docs: 补充 HTML 测试报告与 durationMs 字段说明"
```

---

## Self-Review 结果（已内联修正）

- **Spec 覆盖**：形态/时机/位置（Task 3-4）、内容汇总+明细+折叠 trace（Task 2）、耗时入报告（Task 1）、stdout 不变+失败不改退出码（Task 3-4 Global Constraints）、i18n reportHtml.*/log.htmlReport*（Task 2-3）、转义（Task 2）、.gitignore（Task 3）、测试（各任务）、README/CONTEXT/JSON durationMs（Task 5）。截图/HTML i18n 独立切换为非目标，无任务。
- **占位符**：无 TBD/TODO；所有代码步骤含完整代码或精确修改点。
- **类型一致性**：`durationMs`（`TestReport`+`ScenarioDetail`）、`renderHtml(report)`、`writeHtmlReport(report, baseDir?, now?)`、`writeHtmlReportSafe(report, baseDir?, now?)`、`htmlReportFilePath(baseDir?, now?)`、i18n 键名 zh/en 对齐（含 `reportHtml.durationLabel`）；Task 3 测试依赖 Task 2 的 `base()` helper，同文件内定义。
