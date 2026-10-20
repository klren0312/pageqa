/**
 * 自包含 HTML 测试报告：从 TestReport 渲染单文件页面（内联 CSS/JS，零依赖）。
 *
 * 只负责「数据 → HTML 字符串」；写盘见 writeHtmlReport。所有动态文本必须经
 * escapeHtml——场景名/断言证据来自用例与页面，不能让它们把标签结构打破。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getLocale, t } from "../shared/i18n.js";
import { formatUsd } from "./cost.js";
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

/**
 * 单张截图内联进 HTML 的字节上限。
 *
 * 报告是**自包含单文件**（内联 CSS/JS、零依赖），截图照此办理：base64 内联后图随文件走，
 * 不会因为「报告被挪到别处」而整片失效。但整页长图的 PNG 可能有几 MB，全塞进去会把报告
 * 撑到打不开——超过上限就退化成一行路径，人自己去开。
 */
const MAX_INLINE_SCREENSHOT_BYTES = 4 * 1024 * 1024;

/** 截图 → `data:` URL；读不到或超限返回 null（调用方退化成路径）。 */
function screenshotDataUrl(path: string): string | null {
  try {
    const bytes = readFileSync(path);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_INLINE_SCREENSHOT_BYTES) return null;
    return `data:image/png;base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

/** 截图区（没有截图时不渲染任何东西）。 */
function screenshotsSection(paths: string[] | undefined): string {
  if (!paths || paths.length === 0) return "";
  const items = paths
    .map((path) => {
      const url = screenshotDataUrl(path);
      const caption = escapeHtml(basename(path));
      if (!url) {
        return `<p class="muted">${escapeHtml(t("reportHtml.screenshotMissing", { path }))}</p>`;
      }
      return (
        `<figure><img src="${url}" alt="${caption}">` +
        `<figcaption>${caption}</figcaption></figure>`
      );
    })
    .join("");
  return (
    `<h3>${escapeHtml(t("reportHtml.screenshots"))}` +
    `（${paths.length}）</h3><div class="shots">${items}</div>`
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
  parts.push(screenshotsSection(sc.screenshots));
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
  parts.push(screenshotsSection(r.screenshots));
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
table { border-collapse: collapse; width: 100%; table-layout: fixed; font-size: 0.9rem; margin: 8px 0; }
th, td { border: 1px solid #d0d7de; padding: 6px 8px; text-align: left; vertical-align: top; overflow-wrap: anywhere; word-break: break-word; }
th { background: #f6f8fa; }
/* 固定列宽：期望列留出可读宽度，结论列不再换行，证据列吃掉剩余宽度并在长串（如上游 JSON）内断行 */
th:nth-child(1), td:nth-child(1) { width: 30%; }
th:nth-child(2), td:nth-child(2) { width: 72px; white-space: nowrap; }
ol.steps, ul.skipped { font-size: 0.9rem; padding-left: 1.4em; }
.shots { display: flex; flex-direction: column; gap: 12px; margin: 8px 0; }
.shots figure { margin: 0; }
.shots img { max-width: 100%; display: block; border: 1px solid #d0d7de; border-radius: 6px; }
.shots figcaption { color: #59636e; font-size: 0.8rem; margin-top: 4px; overflow-wrap: anywhere; }
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
 * 报告的完整名字：`<用例名>-测试报告`（如「钉钉推送日志用例-测试报告」）。
 *
 * 名字要一眼看出「这是哪条用例的报告」，所以用例名在前、报告种类在后，中间一个连字符——
 * 与文件名同源，用户从产物清单里看到的路径与打开后的抬头是同一个字符串。
 * 取不到用例名时返回空串，由渲染层退回通用标题。
 */
export function reportTitle(report: TestReport): string {
  const name = (report.caseName ?? "").trim();
  return name ? `${name}-${t("reportHtml.reportSuffix")}` : "";
}

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
  // 文档标题 = 用例名 + 报告种类（与文件名同一个字符串，页签里一眼认出是哪条用例的报告）。
  // 取不到用例名时退回通用标题（HTML 标题用专用键、无 === 装饰；文本报告的 report.title 留给 stdout）。
  const kind = isSuite ? t("reportHtml.pageTitleSuite") : t("reportHtml.pageTitle");
  const title = reportTitle(report) || kind;
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
    // 金额估算：单价解析不到就不渲染这张卡（而不是摆一个 $0.00 让人读成免费）。
    // 回放模式同理——它压根没调用模型，没有费用可言。
    report.mode === "replay"
      ? ""
      : report.cost
        ? `<div class="stat"><b>${escapeHtml(formatUsd(report.cost.total))}</b>${escapeHtml(t("reportHtml.costLabel"))}</div>`
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

/**
 * 从用例文件正文取「用例名」：第一个一级标题（`# 钉钉推送日志用例` → `钉钉推送日志用例`）。
 *
 * 为什么要读 H1 而不是文件名：用例文件常是 `dingtalk-log.md` 这类拼音/英文短名，
 * 而人认的是 `# 钉钉推送日志用例` 那行标题。报告产物要给人看，名字就该用人写的那一个。
 * 没有 H1（或 H1 是空的）时返回 undefined，由调用方退回文件名。
 */
export function caseNameFromText(text?: string | null): string | undefined {
  for (const line of (text ?? "").split(/\r?\n/)) {
    const m = line.match(/^#\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    const title = m[1].trim();
    // `#` 后面必须真有字：`#`、`# ` 这类空标题不算（否则报告名会变成一个孤零零的连字符）。
    if (title.length > 0) return title;
  }
  return undefined;
}

/**
 * 从用例/脚本路径取「用例名」：`…/plm-material-drawing-no.md` → `plm-material-drawing-no`。
 *
 * 回放脚本以 `.replay.json` 结尾，整段后缀一起去掉，否则会得到 `x.replay`。
 * 取不到（空串、只有扩展名）时返回 undefined，让文件名退回通用形式。
 */
export function caseNameFromPath(path?: string | null): string | undefined {
  const raw = (path ?? "").trim();
  if (!raw) return undefined;
  const base = basename(raw);
  const stem = base.replace(/\.replay\.json$/i, "").replace(/\.[^.]+$/, "");
  const trimmed = stem.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 从用例文件读「用例名」：先读文件里的 H1，读不到再用文件名。
 *
 * 给回放用：脚本只记了 `source.path`，报告要在零模型回放时也叫得出用例名。
 * 读不了（文件已删、无权限）不算错——退回文件名即可，报告本身照样写。
 */
export function caseNameFromFile(path?: string | null): string | undefined {
  const fallback = caseNameFromPath(path);
  if (!path) return fallback;
  try {
    return caseNameFromText(readFileSync(path, "utf8")) ?? fallback;
  } catch {
    return fallback;
  }
}

/** 文件名里不能出现的字符（Windows 最严，按它来就跨平台安全）。 */
const UNSAFE_FILE_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 用例名 → 文件名主干：去掉非法字符、压掉空白、限长（路径总长有上限）；没有就是空串。 */
function fileStem(caseName?: string): string {
  return (caseName ?? "")
    .replace(UNSAFE_FILE_CHARS, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[.\s]+$/g, "")
    .slice(0, 60)
    .trim();
}

/**
 * 报告文件路径：`<baseDir>/<用例名>-测试报告.html`（如 `钉钉推送日志用例-测试报告.html`）。
 *
 * 名字是**固定的**：同一条用例的报告永远落在同一个文件上，产物清单里那行路径可以直接收藏、
 * 也可以挂进 CI 归档。代价是后一次运行覆盖前一次——报告是「这次运行的样子」，要留历史就
 * 该用 `--out` 或另存，而不是靠文件名堆时间戳（堆出来的名字谁也认不出是哪条用例）。
 *
 * 不带用例名时只剩 `测试报告.html`：内联文本、无源会话没有「哪条用例」可言。
 */
export function htmlReportFilePath(baseDir?: string, caseName?: string): string {
  const suffix = t("reportHtml.reportSuffix");
  const stem = fileStem(caseName);
  const name = stem ? `${stem}-${suffix}.html` : `${suffix}.html`;
  return join(baseDir ?? "pageqa-report", name);
}

/** 渲染并写盘（自动创建目录）。失败抛给调用方：结果与提示由 side-outputs 统一交代。 */
export function writeHtmlReport(
  report: TestReport,
  baseDir?: string,
): { path: string } {
  const path = htmlReportFilePath(baseDir, report.caseName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderHtml(report), "utf8");
  return { path };
}
