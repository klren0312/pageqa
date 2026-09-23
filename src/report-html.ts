/**
 * 自包含 HTML 测试报告：从 TestReport 渲染单文件页面（内联 CSS/JS，零依赖）。
 *
 * 只负责「数据 → HTML 字符串」；写盘见 writeHtmlReport。所有动态文本必须经
 * escapeHtml——场景名/断言证据来自用例与页面，不能让它们把标签结构打破。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getLocale, t } from "./i18n.js";
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
  if (sc.skipped?.length) {
    const items = sc.skipped.map((s) => `<li>${escapeHtml(s)}</li>`).join("");
    parts.push(
      `<h3>${escapeHtml(t("report.skipped", { n: sc.skipped.length }))}</h3>` +
        `<ul class="skipped">${items}</ul>`,
    );
  }
  if (sc.summary) {
    parts.push(
      `<p class="summary">${escapeHtml(t("report.summary", { text: sc.summary }))}</p>`,
    );
  }
  parts.push(traceDetails(sc.trace));
  parts.push(`</section>`);
  return parts.join("\n");
}

/** 单场景视图：直接渲染报告自身的断言/步骤/轨迹/摘要。 */
function singleSection(r: TestReport): string {
  const parts: string[] = [];
  // 标题固定「用例明细」，耗时只作附注——避免 duration 挤掉标题或复用文本报告的 === 装饰。
  parts.push(
    `<section class="scenario"><h2>${escapeHtml(t("reportHtml.detail"))}` +
      (typeof r.durationMs === "number"
        ? ` <span class="muted">${escapeHtml(
            t("reportHtml.duration", { dur: formatDurationMs(r.durationMs) }),
          )}</span>`
        : "") +
      ` ${badge(r.status)}</h2>`,
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
  // 空数组仍是套件视图（交互退出可能一个场景都没跑）：不能退回单场景的 total=1/pass=1。
  const isSuite = report.scenarios !== undefined;
  const counts = isSuite
    ? countUp(scenarios)
    : countUp([report]);
  // HTML 文档标题用专用键（无 === 装饰）；文本报告的 report.title 保留给 stdout。
  const title = isSuite ? t("reportHtml.pageTitleSuite") : t("reportHtml.pageTitle");
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
<html lang="${escapeHtml(getLocale())}">
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

/** 渲染并写盘（自动创建目录）。失败抛给调用方：结果与提示由 side-outputs 统一交代。 */
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
