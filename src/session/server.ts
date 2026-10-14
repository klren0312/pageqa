/**
 * session 查询服务：`pageqa sessions` 起的一个本地 HTTP 服务，用来回看历史运行。
 *
 * 它回答的是调试时最先冒出来的那几个问题：
 * - 这次到底把什么交给了模型？（系统提示、模型、工具 schema、编号后的用例）
 * - 模型每一步看到了什么？（每轮实际发出的上下文，含上下文裁剪的结果）
 * - 模型点了什么、工具返回了什么？（入参、结果、耗时、成败）
 *
 * 刻意只用 `node:http`、零依赖、只监听回环地址：
 * - 它是排查工具，不该要求用户先装点什么；
 * - 存档里含系统提示、用例文本与页面快照，不该暴露到局域网（`127.0.0.1` 而非 `0.0.0.0`）。
 *
 * 页面全部由服务端渲染（不引前端框架/构建），动态文本一律经 escapeHtml。
 */
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { escapeHtml, formatDurationMs } from "../report/report-html.js";
import { getLocale, t } from "../shared/i18n.js";
import { info } from "../shared/log.js";
import {
  clearArchives,
  databasePath,
  deleteArchive,
  isForeignContainer,
  isSafeId,
  listArchives,
  readArchive,
  SESSIONS_DIR,
  type SessionArchive,
  type SessionContextInfo,
  type SessionSummary,
} from "./archive.js";

/** 默认端口：换一个不常被占用的号，少一点「起服务先撞端口」的摩擦。 */
export const DEFAULT_SESSIONS_PORT = 7331;

/** 端口被占用时向上试多少个（0 = 不重试）。 */
const PORT_TRIES = 20;

export interface SessionServerOptions {
  port?: number;
  dir?: string;
  /** 起服务后是否尝试打开浏览器（best-effort，失败无妨）。 */
  open?: boolean;
  /**
   * 就绪回调：拿到**实际**监听的端口与地址。
   *
   * 端口被占用会自动向上顺延，调用方（与测试）只有通过它才能知道服务最终落在哪。
   */
  onReady?: (info: { port: number; url: string }) => void;
}

const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 0 0 48px; font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  background: #f6f7f9; color: #1f2328; }
header { padding: 20px 28px; background: #fff; border-bottom: 1px solid #e5e7eb; }
header .hrow { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
header h1 { margin: 0; font-size: 18px; }
header .sub { margin: 4px 0 0; color: #6b7280; font-size: 12px; }
header .count { margin: 12px 0 0; color: #6b7280; font-size: 12px; }
main { padding: 20px 28px; max-width: 1280px; }
button { font: inherit; font-size: 12px; padding: 4px 10px; border: 1px solid #d0d7de;
  border-radius: 6px; background: #fff; color: #1f2328; cursor: pointer; white-space: nowrap; }
button:hover { background: #f3f4f6; }
button.danger { color: #cf222e; border-color: #f0c2c0; }
button.danger:hover { background: #ffebe9; }
td.ops, th.ops { width: 1%; white-space: nowrap; text-align: right; }
a { color: #2563eb; text-decoration: none; }
a:hover { text-decoration: underline; }
table { width: 100%; border-collapse: collapse; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.05); }
th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #eef0f2; vertical-align: top; }
th { background: #fafbfc; font-weight: 600; font-size: 12px; color: #57606a; }
tbody tr:hover { background: #f6f8fa; }
tbody tr { cursor: pointer; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; font-weight: 600; }
.b-pass { background: #dafbe1; color: #1a7f37; }
.b-fail { background: #ffebe9; color: #cf222e; }
.b-cancelled { background: #f0f0f3; color: #57606a; }
.b-unknown { background: #eef0f2; color: #6b7280; }
.muted { color: #6b7280; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre { margin: 0; padding: 10px 12px; background: #fff; border: 1px solid #e5e7eb; border-radius: 6px;
  overflow: auto; max-height: 420px; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
section { margin: 0 0 22px; }
section > h2 { font-size: 14px; margin: 0 0 10px; padding-bottom: 6px; border-bottom: 1px solid #e5e7eb; }
details { background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; margin-bottom: 8px; }
details > summary { cursor: pointer; padding: 8px 12px; font-size: 13px; }
details[open] > summary { border-bottom: 1px solid #eef0f2; }
details .body { padding: 10px 12px; }
.meta { display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 0 0 20px; font-size: 13px; }
.meta b { color: #57606a; font-weight: 600; }
.empty { padding: 40px; text-align: center; color: #6b7280; background: #fff; border-radius: 6px; }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; font-size: 13px; }
.label { font-weight: 600; margin: 8px 0 4px; }
.trunc { color: #9a6700; font-size: 11px; margin-left: 6px; }
`;

/** 页面的公共外壳（head + 样式 + 头部）。 */
function shell(title: string, heading: string, sub: string, body: string): string {
  return shellWith(title, heading, sub, body, {});
}

/**
 * 带页面级操作的外壳：`actions` 是头部右侧的按钮区，`script` 是行内脚本。
 *
 * 页面全部服务端渲染（没有前端框架、也没有构建步骤），所以删除/清空这两件事就靠这一段
 * 行内脚本 + `DELETE /api/sessions…` 完成，不引任何依赖。
 */
function shellWith(
  title: string,
  heading: string,
  sub: string,
  body: string,
  extra: { actions?: string; script?: string; count?: string },
): string {
  const actions = extra.actions
    ? `<div class="actions">${extra.actions}</div>`
    : "";
  return `<!doctype html>
<html lang="${getLocale()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<header>
<div class="hrow">
<div>
<h1>${escapeHtml(heading)}</h1>
<p class="sub">${escapeHtml(sub)}</p>
${extra.count ? `<p class="count">${escapeHtml(extra.count)}</p>` : ""}
</div>
${actions}
</div>
</header>
<main>${body}</main>
${extra.script ?? ""}
</body>
</html>`;
}

/**
 * 嵌进行内脚本的字面量（单引号形式）。
 *
 * 与 `escapeHtml` 的区别是这里**不能**用 HTML 实体：`<script>` 里的内容不会被实体解码，
 * `&quot;` 会原样留在字符串里。真正的风险只有一个——字面量里出现结束脚本标签就能提前收尾，
 * 所以把每一个小于号都写成 JS 的 unicode 转义（同一个字符，浏览器认）。
 *
 * 刻意用单引号而不是 `JSON.stringify`：后者给内层引号加的反斜杠能活过 `escapeHtml`，
 * 到了浏览器里就成了 `\"` ——`&quot;` 解码回 `"` 之后它把字符串的收尾引号也转义掉了，
 * 脚本直接是坏的。
 */
function jsString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/</g, "\\u003c");
  return `'${escaped}'`;
}

/**
 * 同上，但用在 `onclick="…"` 的**参数位**（形如 `pageqaRemove('id')`）。
 *
 * 属性值里的 HTML 实体会在解析时解码回原字符，所以这里可以放心再过一遍 `escapeHtml`：
 * 不加它，生成的引号会直接把这个属性提前结束掉。
 */
function attrJsString(value: string): string {
  return escapeHtml(jsString(value));
}

/** 删除/清空按钮的公共脚本：确认 → DELETE → 回列表。失败时如实弹出来，而不是刷新后记录还在。 */
function actionsScript(): string {
  // `{msg}` / `{n}` 在这里**故意**不填：留到浏览器里由响应文本与条数补上（`t` 不认识的名字原样留下）。
  const deleteFailed = t("sessions.deleteFailed", { msg: "{msg}" });
  const clearFailed = t("sessions.clearFailed", { msg: "{msg}" });
  const confirmClear = t("sessions.confirmClear", { n: "{n}" });
  return `<script>
async function pageqaRemove(id) {
  if (!confirm(${jsString(t("sessions.confirmDelete"))})) return;
  const res = await fetch('/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' });
  if (!res.ok) {
    alert(${jsString(deleteFailed)} + (await res.text()).trim());
    return;
  }
  location.href = '/';
}
async function pageqaClearAll(total) {
  if (!confirm(${jsString(confirmClear)}.replace('{n}', total))) return;
  const res = await fetch('/api/sessions', { method: 'DELETE' });
  if (!res.ok) {
    alert(${jsString(clearFailed)} + (await res.text()).trim());
    return;
  }
  location.reload();
}
</script>`;
}

function statusBadge(status: string | undefined): string {
  const kind = status ?? "unknown";
  const label =
    status === "pass"
      ? t("common.pass")
      : status === "fail"
        ? t("common.fail")
        : status === "cancelled"
          ? t("common.cancelled")
          : "—";
  return `<span class="badge b-${escapeHtml(kind)}">${escapeHtml(label)}</span>`;
}

/** ISO 时间 → 本地 `MM-DD HH:mm:ss`（列表里够用，也短）。 */
function shortTime(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 带小标题的文本块（工具调用的「入参 / 结果」用）。 */
function labeled(label: string, body: string): string {
  return `<div class="label">${escapeHtml(label)}</div>${body}`;
}

/** `pre` 块（含截断提示）。 */
function pre(text: string, truncated?: boolean, chars?: number): string {
  const note =
    truncated && chars !== undefined
      ? `<span class="trunc">${escapeHtml(t("sessions.detailTruncated", { chars }))}</span>`
      : "";
  return `<pre class="mono">${escapeHtml(text)}</pre>${note}`;
}

/**
 * 整行点击进详情的 `onclick` 语句（已自带引号，调用方只需 `escapeHtml` 收进属性里）。
 *
 * 存档 id 是从容器里读出来的，因此不把它拼成一段「信任它不会带引号」的代码。
 */
function rowNav(id: string): string {
  return `location.href=${jsString("/s/" + encodeURIComponent(id))}`;
}

/** 列表页。 */
export function renderIndexPage(sessions: readonly SessionSummary[]): string {
  const body =
    sessions.length === 0
      ? `<div class="empty">${escapeHtml(t("sessions.empty"))}</div>`
      : `<table><thead><tr>` +
        `<th>${escapeHtml(t("sessions.colTime"))}</th>` +
        `<th>${escapeHtml(t("sessions.colCase"))}</th>` +
        `<th>${escapeHtml(t("sessions.colScenario"))}</th>` +
        `<th>${escapeHtml(t("sessions.colModel"))}</th>` +
        `<th>${escapeHtml(t("sessions.colStatus"))}</th>` +
        `<th>${escapeHtml(t("sessions.colSteps"))}</th>` +
        `<th>${escapeHtml(t("sessions.colTools"))}</th>` +
        `<th>${escapeHtml(t("sessions.colTurns"))}</th>` +
        `<th class="ops">${escapeHtml(t("sessions.colActions"))}</th>` +
        `</tr></thead><tbody>` +
        sessions
          .map(
            (s) =>
              `<tr onclick="${escapeHtml(rowNav(s.id))}">` +
              `<td class="mono">${escapeHtml(shortTime(s.startedAt))}</td>` +
              `<td>${escapeHtml(s.casePreview)}</td>` +
              `<td>${escapeHtml(s.scenarioName ?? "—")}</td>` +
              `<td class="mono">${escapeHtml(s.model)}</td>` +
              `<td>${statusBadge(s.status)}</td>` +
              `<td>${s.steps}</td><td>${s.toolCalls}</td><td>${s.turns}</td>` +
              // 整行可点进详情，所以按钮要先 `stopPropagation`——否则删记录会变成「点开详情」。
              `<td class="ops"><button type="button" class="danger" ` +
              `onclick="event.stopPropagation();pageqaRemove(${attrJsString(s.id)})">` +
              `${escapeHtml(t("sessions.delete"))}</button></td>` +
              `</tr>`,
          )
          .join("") +
        `</tbody></table>`;
  // 列表为空时没有「清空全部」可点：按钮只在真有东西要清时出现。
  const actions =
    sessions.length === 0
      ? undefined
      : `<button type="button" class="danger" onclick="pageqaClearAll(${sessions.length})">` +
        `${escapeHtml(t("sessions.clearAll"))}</button>`;
  return shellWith(
    t("sessions.pageTitle"),
    t("sessions.heading"),
    t("sessions.subtitle"),
    body,
    {
      ...(actions ? { actions } : {}),
      // 一条都没有时连脚本都不给：没有可删的东西，就不该往页面里塞两段没人会点的代码。
      ...(sessions.length > 0
        ? { count: t("sessions.count", { n: sessions.length }), script: actionsScript() }
        : {}),
    },
  );
}

/** 「传给 agent 的参数」区块。 */
function paramsSection(a: SessionArchive): string {
  const p = a.params;
  const tools = p.tools
    .map(
      (tool) =>
        `<details><summary class="mono">${escapeHtml(tool.name)}${
          tool.description ? " — " + escapeHtml(tool.description) : ""
        }</summary><div class="body">${pre(
          JSON.stringify(tool.parameters ?? {}, null, 2),
        )}</div></details>`,
    )
    .join("");
  const vars =
    p.vars.length === 0
      ? `<p class="muted">—</p>`
      : `<div class="kv">` +
        p.vars
          .map(
            (v) =>
              `<span class="mono">${escapeHtml(v.name)}</span>` +
              `<span class="mono">${escapeHtml(v.value)}</span>`,
          )
          .join("") +
        `</div>`;
  return (
    `<section><h2>${escapeHtml(t("sessions.detailParams"))}</h2>` +
    `<details><summary>${escapeHtml(t("sessions.detailSystemPrompt"))}</summary>` +
    `<div class="body">${pre(p.systemPrompt)}</div></details>` +
    `<details><summary>${escapeHtml(t("sessions.detailCase"))}</summary>` +
    `<div class="body">${pre(p.caseText)}</div></details>` +
    `<details><summary>${escapeHtml(t("sessions.detailPrompt"))}</summary>` +
    `<div class="body">${pre(p.prompt)}</div></details>` +
    `<details><summary>${escapeHtml(
      t("sessions.detailTools", { n: p.tools.length }),
    )}</summary><div class="body">${tools}</div></details>` +
    `<details><summary>${escapeHtml(t("sessions.detailVars"))}</summary>` +
    `<div class="body">${vars}</div></details>` +
    `</section>`
  );
}

/** 「LLM 轮次」区块：每轮一行，展开看该轮实际发出的上下文。 */
function turnsSection(a: SessionArchive): string {
  if (a.turns.length === 0) {
    return `<section><h2>${escapeHtml(t("sessions.detailTurns"))}</h2><p class="muted">—</p></section>`;
  }
  const items = a.turns
    .map((turn) => {
      const usage = turn.usage
        ? ` · in ${turn.usage.input ?? 0} / out ${turn.usage.output ?? 0}`
        : "";
      const head =
        `${escapeHtml(t("sessions.turn", { n: turn.index }))}` +
        ` · ${formatDurationMs(turn.durationMs)}${usage}` +
        ` · ${escapeHtml(
          t("sessions.detailContextCount", { n: turn.context.length }),
        )}`;
      const msgs = turn.context
        .map(
          (m) =>
            `<details><summary class="mono">${escapeHtml(m.role)}${
              m.toolName ? " · " + escapeHtml(m.toolName) : ""
            } · ${m.chars}</summary><div class="body">${pre(
              m.text,
              m.truncated,
              m.chars,
            )}</div></details>`,
        )
        .join("");
      return (
        `<details><summary>${head}</summary><div class="body">${msgs}</div></details>`
      );
    })
    .join("");
  return `<section><h2>${escapeHtml(t("sessions.detailTurns"))}</h2>${items}</section>`;
}

/** 「工具调用」区块：入参、结果、耗时、成败。 */
function toolsSection(a: SessionArchive): string {
  if (a.toolCalls.length === 0) {
    return `<section><h2>${escapeHtml(t("sessions.detailToolCalls"))}</h2><p class="muted">—</p></section>`;
  }
  const rows = a.toolCalls
    .map(
      (c) =>
        `<details><summary>` +
        `<span class="mono">#${c.index} ${escapeHtml(c.name)}</span>` +
        ` ${statusBadge(c.ok ? "pass" : "fail")}` +
        `<span class="muted"> · ${formatDurationMs(c.durationMs)}</span>` +
        `</summary><div class="body">` +
        labeled(
          t("sessions.detailArgs"),
          pre(JSON.stringify(c.args ?? {}, null, 2)),
        ) +
        labeled(
          t("sessions.detailResult"),
          pre(c.result ?? "", c.resultTruncated, c.resultChars),
        ) +
        `</div></details>`,
    )
    .join("");
  return `<section><h2>${escapeHtml(t("sessions.detailToolCalls"))}</h2>${rows}</section>`;
}

/**
 * 上下文决策的一行摘要：窗口多大、从哪来的、前缀压没压、为什么压。
 *
 * 放在详情页顶部是有原因的：「我的小模型为什么没被当小模型对待」这个问题，
 * 光看下面的系统提示词与工具声明（只有结果、没有依据）答不出来。
 */
function contextLine(c: SessionContextInfo): string {
  const source = t(`sessions.windowSource.${c.windowSource}`);
  const prefix = c.compact
    ? t("sessions.compactOn", {
        reason: t(`sessions.compactReason.${c.compactReason}`),
      })
    : t("sessions.compactOff");
  return t("sessions.contextLine", {
    window: c.window,
    source,
    input: c.inputBudget,
    output: c.outputReserve,
    prefix,
  });
}

/** 详情页。 */
export function renderDetailPage(a: SessionArchive): string {
  const usage = a.usage
    ? `${a.usage.calls} · in ${a.usage.input} / out ${a.usage.output} / total ${a.usage.total}`
    : "—";
  const meta =
    `<div class="meta">` +
    `<span><b>${escapeHtml(t("sessions.detailTime"))}</b> ${escapeHtml(shortTime(a.startedAt))} → ${escapeHtml(shortTime(a.endedAt))}</span>` +
    `<span><b>${escapeHtml(t("common.status"))}</b> ${statusBadge(a.status)}</span>` +
    `<span><b>${escapeHtml(t("sessions.detailModel"))}</b> <span class="mono">${escapeHtml(a.params.model.provider + "/" + a.params.model.id)}</span></span>` +
    `<span><b>${escapeHtml(t("sessions.detailBskSession"))}</b> <span class="mono">${escapeHtml(a.params.bskSession ?? "—")}</span></span>` +
    `<span><b>${escapeHtml(t("sessions.detailScenario"))}</b> ${escapeHtml(a.params.scenarioName ?? "—")}</span>` +
    `<span><b>${escapeHtml(t("sessions.detailUsage"))}</b> <span class="mono">${escapeHtml(usage)}</span></span>` +
    (a.params.context
      ? `<span><b>${escapeHtml(t("sessions.detailContext"))}</b> <span class="mono">${escapeHtml(contextLine(a.params.context))}</span></span>`
      : "") +
    (a.note ? `<span><b>${escapeHtml(t("sessions.detailNote"))}</b> ${escapeHtml(a.note)}</span>` : "") +
    `<span><a href="/api/sessions/${encodeURIComponent(a.id)}">${escapeHtml(t("sessions.raw"))}</a></span>` +
    `</div>`;
  // 详情页也给一条删除：直接从地址栏/收藏进来看记录的人，不该先回列表才删得掉。
  const actions =
    `<button type="button" class="danger" onclick="pageqaRemove(${attrJsString(a.id)})">` +
    `${escapeHtml(t("sessions.detailDelete"))}</button>`;
  return shellWith(
    t("sessions.pageTitle"),
    a.params.caseText.replace(/\s+/g, " ").trim().slice(0, 80) || a.id,
    t("sessions.detailSubtitle", { id: a.id }),
    meta + paramsSection(a) + turnsSection(a) + toolsSection(a),
    { actions, script: actionsScript() },
  );
}

/** 纯文本响应。 */
function sendText(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  sendText(res, status, JSON.stringify(value, null, 2), "application/json; charset=utf-8");
}

/** 把任意抛出的东西变成一句能直接弹给人看的消息。 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 处理一次请求；返回 false 表示路由没命中（由调用方给 404）。 */
async function route(
  req: IncomingMessage,
  res: ServerResponse,
  dir: string,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (path === "/" || path === "/index.html") {
    sendText(
      res,
      200,
      renderIndexPage(await listArchives(dir)),
      "text/html; charset=utf-8",
    );
    return true;
  }
  if (path === "/api/sessions") {
    // 「清空全部」= 整个索引归零：与单条删除同一个提交口径，列表与详情同时消失。
    if (method === "DELETE") {
      try {
        sendJson(res, 200, { deleted: await clearArchives(dir) });
      } catch (err) {
        // 容器是旧格式之类时读不出来，刷新页面记录会一条不少——必须让页面知道没删成。
        sendJson(res, 500, { error: errMessage(err) });
      }
      return true;
    }
    sendJson(res, 200, await listArchives(dir));
    return true;
  }
  const api = path.match(/^\/api\/sessions\/([^/]+)$/);
  if (api) {
    const id = decodeURIComponent(api[1]);
    if (method === "DELETE") {
      // id 非法是请求本身的问题（400）；容器读不出来是本机状态的问题（500）。两者都答 JSON，
      // 页面把消息弹出来——删不掉却说「成功」比不删更糟。
      if (!isSafeId(id)) {
        sendJson(res, 400, { error: t("sessions.badId") });
        return true;
      }
      try {
        const deleted = await deleteArchive(id, dir);
        sendJson(res, deleted ? 200 : 404, { deleted });
      } catch (err) {
        sendJson(res, 500, { error: errMessage(err) });
      }
      return true;
    }
    try {
      sendJson(res, 200, await readArchive(id, dir));
    } catch {
      sendJson(res, 404, { error: t("sessions.detailNotFound") });
    }
    return true;
  }
  const page = path.match(/^\/s\/([^/]+)$/);
  if (page) {
    try {
      const archive = await readArchive(decodeURIComponent(page[1]), dir);
      sendText(res, 200, renderDetailPage(archive), "text/html; charset=utf-8");
    } catch {
      sendText(
        res,
        404,
        shell(t("sessions.pageTitle"), t("sessions.heading"), "", `<div class="empty">${escapeHtml(t("sessions.detailNotFound"))}</div>`),
        "text/html; charset=utf-8",
      );
    }
    return true;
  }
  return false;
}

/** 在 `port` 起监听；端口被占用时向上顺延（最多 PORT_TRIES 次）。 */
function listenWithFallback(
  server: Server,
  port: number,
  host: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let candidate = port;
    let attempts = 0;
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && attempts < PORT_TRIES) {
        attempts += 1;
        candidate += 1;
        server.listen(candidate, host);
        return;
      }
      server.removeListener("error", onError);
      reject(err);
    };
    server.on("error", onError);
    server.once("listening", () => {
      server.removeListener("error", onError);
      resolve(candidate);
    });
    server.listen(candidate, host);
  });
}

/** best-effort 打开浏览器；打不开就算了（URL 已经打在终端上）。 */
function openBrowser(url: string): void {
  try {
    const [cmd, args] =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    // 打开失败不影响服务本身。
  }
}

/**
 * 起服务并常驻（Ctrl+C 退出）。
 *
 * 只监听 `127.0.0.1`：存档里是系统提示、用例文本与页面快照，没有理由让同一个网络里的
 * 别人也看得到。返回值只在监听失败时出现（调用方据此给退出码）。
 */
export async function runSessionServer(opts: SessionServerOptions = {}): Promise<number> {
  const dir = opts.dir ?? SESSIONS_DIR;
  const server = createServer((req, res) => {
    // 路由是异步的（存储换成 SQLite 后读写都返回 Promise）：这里显式接住 rejection，
    // 否则一个读失败的请求就足以让整个服务进程消失。
    void route(req, res, dir)
      .then((handled) => {
        if (!handled) sendText(res, 404, "not found");
      })
      .catch((err) => {
        // 响应已经开写（路由里发过一部分）时只能收尾，再写头会抛。
        if (res.headersSent) {
          res.end();
          return;
        }
        sendText(res, 500, errMessage(err));
      });
  });

  let port: number;
  try {
    port = await listenWithFallback(server, opts.port ?? DEFAULT_SESSIONS_PORT, "127.0.0.1");
  } catch (err) {
    // 端口无法监听（端口段被占、权限不足等）：给一条人话，而不是一个裸栈。
    process.stderr.write(
      t("err.sessionsListenFailed", {
        msg: err instanceof Error ? err.message : String(err),
      }) + "\n",
    );
    return 1;
  }

  const url = `http://127.0.0.1:${port}/`;
  opts.onReady?.({ port, url });
  info(t("log.sessionServing", { url }));
  info(t("log.sessionArchiveDir", { dir: databasePath(dir) }));
  if (isForeignContainer(dir)) {
    // 容器是早期版本留下的（表结构不同）：列不出来是**必然**的，当场说清为什么、怎么办——
    // 否则「一个运行记录都没有」看起来像存档全丢了。
    info(t("log.sessionArchiveForeign", { dir: databasePath(dir) }));
  } else if ((await listArchives(dir)).length === 0) {
    // 存档目录还没建（没跑过任何用例）时提示一句：空列表页容易让人以为服务坏了。
    info(t("log.sessionArchiveEmpty"));
  }
  if (opts.open !== false) openBrowser(url);

  // 常驻：直到用户 Ctrl+C。刻意不自己退出——它是个「开着看」的服务。
  return await new Promise<number>((resolve) => {
    const shutdown = () => {
      server.close(() => resolve(0));
      // 关掉在飞的连接（keep-alive），否则 close 回调可能一直不来。
      server.closeAllConnections?.();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
