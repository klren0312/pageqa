import { execFile, spawn } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { basename } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { readDownloadCleanup } from "../config.js";
import {
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  downloadDestination,
  downloadExpectation,
  downloadRetention,
  downloadStagingPath,
  ensureDownloadDirFor,
  fileSizeOrNull,
  matchFileName,
  recordDownloaded,
  uniquePath,
} from "../downloads.js";
import { t } from "../i18n.js";
import {
  ensureScreenshotDirFor,
  recordScreenshot,
  screenshotPath,
} from "../screenshots.js";
import { JevClient } from "../jev.js";
import {
  inspectRefTarget,
  parseSnapshotRefs,
  type SnapshotRef,
} from "../locator.js";
import { debugLog, info, timer } from "../log.js";
import {
  buildConfirmExpression,
  buildProbeExpression,
  describeCondition,
  needsConfirm,
  parseConfirm,
  parseProbe,
  pollUntil,
  probeSaysMaybe,
  type ConditionProbe,
  type WaitCondition,
} from "./condition.js";
import { buildSettleProbeExpression, describeSample, isSettled, parseSettleSample } from "./settle.js";
import {
  buildClearMarksExpression,
  buildDateDayMarkExpression,
  buildDatePanelProbeExpression,
  buildOptionMarkExpression,
  buildOverlayProbeExpression,
  buildOwnOverlayExpression,
  DATE_CONFIRM_SELECTORS,
  DATE_NEXT_SELECTORS,
  DATE_PREV_SELECTORS,
  DATE_RANGE_NEXT_SELECTORS,
  DATE_RANGE_PREV_SELECTORS,
  monthDelta,
  navDirection,
  parseDatePanelProbe,
  parseDateSpec,
  parseDayMark,
  parseOptionMark,
  parseOverlayProbe,
  pickTableIndex,
  PICK_SELECTOR,
  ROOT_SELECTOR,
  scopedToRoot,
  WIDE_OVERLAY_SELECTORS,
  type DatePanelProbe,
  type DateSpec,
  type OverlayProbe,
} from "./picker.js";
import { slimSnapshot } from "../snapshot.js";
import {
  BskIpcAbortError,
  BskIpcRpcError,
  BskIpcTransportError,
  ipcCall,
} from "./ipc.js";
import {
  extractDialogs,
  ipcErrorToCliError,
  ipcTimeoutToCliError,
  isProtocolDrift,
  looksLikeRef,
  planIpcCall,
  renderDialogs,
  withCliTrailingNewline,
} from "./ipc-commands.js";
import {
  diagnoseNavigateFailure,
  readErrorText,
} from "./navigate-diagnosis.js";

/**
 * browserskill（`bsk`）工具层：把 bsk CLI 命令包装成 pi-agent-core 的 AgentTool。
 *
 * bsk 连接一个已运行的真实浏览器，每个命令都需要 --session <id>。
 * 所有命令以 --quiet 抑制进度输出，仅返回结构化/可读结果。
 *
 * 分两层：
 * - `createBskOps`（操作层）：每次浏览器操作 = 一条 bsk 命令，返回可读结果。
 * - `createBskTools`（工具层）：把操作层包成 agent 可调用的工具，并上报每次执行为录制提供素材。
 * 回放（replay.ts）直接用操作层，因此「录制时怎么操作」与「回放时怎么操作」是同一条命令路径。
 */

/**
 * 单条 bsk 命令的默认超时。
 *
 * `wait-ms` 这类命令的耗时由调用方指定，不能套这个默认值——见 `bsk()` 的 timeoutMs 参数。
 */
const BSK_TIMEOUT_MS = 60_000;

/**
 * 捕获一次下载最多点几次触发元素。
 *
 * 2 = 首轮 + 一次重试：实测「页面刚加载完就点」这类时序问题会让第一次点击白点（紧接着
 * 重试就成功），而「没等到下载」按设计是一条不成立的断言——不重试就会留下一条洗不掉的
 * FAIL。代价是「真的没下载」的用例最坏等 2 倍 timeoutMs（用例可用 timeoutMs 收窄）。
 */
const DOWNLOAD_ATTEMPTS = 2;

/**
 * 「等页面稳定」的等待上限（毫秒）。
 *
 * 800ms 是照着重试循环里原来那个固定 500ms 定的：页面真在播动画时比它耐心一点，
 * 页面本来就稳定时则一步都不等（第一次探针就判定稳定）。
 */
const SETTLE_MAX_MS = 800;

/** 轮询间隔（毫秒）：页面还没稳定时每隔这么久问一次探针。 */
const SETTLE_POLL_MS = 50;

/** 距离上一个资源结束多久算「网络安静」（毫秒）。 */
const SETTLE_NETWORK_QUIET_MS = 200;

/** 单次探针的超时（毫秒）。探针是同步表达式，正常是毫秒级；这个上限只防页面卡死。 */
const SETTLE_PROBE_TIMEOUT_MS = 5_000;

/** 探针不可用（页面抛异常、命令失败）时的固定短等待（毫秒）。 */
const SETTLE_FALLBACK_MS = 300;

/** `wait_for` 的默认等待上限（毫秒）；模型没给时用它。 */
export const DEFAULT_WAIT_FOR_TIMEOUT_MS = 3_000;

/** `wait_for` 能吃下的最大等待上限（毫秒）：再长几乎肯定是写错了。 */
export const MAX_WAIT_FOR_TIMEOUT_MS = 60_000;

/** `wait_for` 的轮询间隔（毫秒）：一次探针在 IPC 快路径下是毫秒级，150ms 已经足够灵敏。 */
const WAIT_FOR_POLL_MS = 150;

/**
 * 等下拉浮层 / 日期面板出现的上限（毫秒）。
 *
 * 弹出动画是几百毫秒级，3 秒已经很宽松；再长说明这个控件根本不是「点开出现浮层」那种，
 * 继续等只是把一次必然的失败拖成十几秒。
 */
const PICKER_WAIT_MS = 3_000;

/**
 * 等浮层**收起**的上限（毫秒）。
 *
 * 关闭动画是 200–300ms 级。这段等待不是洁癖：浮层收起前一直盖在下面的控件上，
 * 不等它消失就去点下一个控件，那一下会落在浮层上——A 的下拉没关、B 的下拉没开，
 * 后续读到的是 A 的选项（真实页面上正是这么串的）。等不到也无妨，多选下拉本就不关。
 */
const PICKER_CLOSE_MS = 1_500;

/**
 * 日期面板最多点几次「上/下一月」。
 *
 * 12 次 = 一年，够覆盖「选明年的某天」这类用例；再多就说明目标日期算错了
 * （比如把日写成了月），继续点下去只是白跑。范围面板的窗口宽两个月，12 次移动
 * 仍能覆盖大约一年。
 */
const MAX_MONTH_NAV = 12;

/** 日期 → `yyyy-MM-dd`（返回文案与日志里统一用这个形状）。 */
function fmtDate(d: DateSpec): string {
  return `${d.y}-${d.m}-${d.d}`;
}

/** 操作被调用方主动中止（交互模式下按 Esc）。 */
export class BskAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BskAbortError";
  }
}

/**
 * `@eN` 引用已失效：最近一次快照之后页面被改动过，旧编号可能已指向另一个元素。
 *
 * 单独一个类型（而不是只有一句文案）是为了让 `exec` 能认出它并**顺手把当前可交互元素
 * 清单附在报错里**：模型收到这条报错后必然要做「重新 snapshot 拿新编号」这件事，
 * 让它为此多花一轮 LLM 往返（实测 3 秒起）纯属浪费。
 */
export class RefStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefStaleError";
  }
}

/**
 * bsk 命令的串行队列。
 *
 * 「一次只有一条 bsk 命令在飞」以前是 `execFileSync` 免费提供的——同步调用天然把并发
 * 挡在门外。改成异步之后这条保证必须显式维护：两条命令并发执行会让 `@eN` 引用与页面
 * 状态互相踩，而「页面此刻长什么样」恰恰是这一层所有操作的隐含前提。
 */
let commandChain: Promise<unknown> = Promise.resolve();

/**
 * 常驻 IPC 快路径的状态。
 *
 * `disabled` 只在**协议漂移**（daemon 不认我们发的那个方法）时置位：那说明 bsk 换了
 * 协议，本进程里再怎么试也是白试。传输层问题（连不上、超时）**不永久关**——daemon 重启、
 * 升级这类抖动会自己恢复，用一段冷却期（`suspendedUntil`）把失败尝试的代价关在笼子里
 * 就够了（每次失败都要先等一次建连超时再退回 CLI）。
 */
let ipcDisabled = false;
let ipcSuspendedUntil = 0;

/** 传输层问题的冷却时长：期间直接走 CLI，不再尝试 IPC。 */
const IPC_SUSPEND_MS = 30_000;

/**
 * 现在能不能用快路径。
 *
 * `PAGEQA_BSK_IPC=0`（也接受 `off`/`false`）强制走 CLI 子进程：排查「回退是否正常」
 * 与做 A/B 计时都要一条不依赖代码改动的开关。
 */
function ipcFastPathUsable(): boolean {
  if (ipcDisabled || Date.now() < ipcSuspendedUntil) return false;
  const flag = process.env.PAGEQA_BSK_IPC?.trim().toLowerCase();
  return !(flag === "0" || flag === "off" || flag === "false");
}

/**
 * 执行一条 bsk 命令：**异步、可中止、全局串行**。
 *
 * 异步不是风格选择：`execFileSync` 会阻塞整个事件循环，交互模式下界面在这期间完全不
 * 渲染、不收键，Esc 也停不下来（与 daemon 轮询必须异步是同一个原因，见 bskStatusJsonAsync）。
 * `signal` 触发时直接 kill 子进程，否则「中止」只能等当前这条命令自己跑完（最坏 60s）。
 *
 * 之所以先试 IPC：每条命令的「起进程 + 连管道 + daemon 探测」实测约 13–20ms，
 * 而常驻连接的往返是 0–1ms（见 ipc.ts 文件头）。快路径失败一律退回 CLI 子进程，
 * 语义与今天逐字一致；回退的判定规则见 runBskCommand。
 */
function bsk(
  args: string[],
  signal?: AbortSignal,
  timeoutMs: number = BSK_TIMEOUT_MS,
): Promise<string> {
  // 上一条成功还是失败都要继续跑下一条：单条命令失败不该堵死整个队列。
  const run = commandChain.then(
    () => runBskCommand(args, signal, timeoutMs),
    () => runBskCommand(args, signal, timeoutMs),
  );
  commandChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 一条命令的实际执行：常驻 IPC 优先，不合适/不可用时退回 CLI 子进程。
 *
 * 回退规则（这一层最需要说清楚的事）：
 * - **daemon 的结构化错误**：不回退。那是命令的结果，不是故障；
 * - **改动型命令在请求已发出后失败**（超时、连接断）：不回退，按 CLI 超时的口径如实报失败。
 *   动作可能已经在页面上生效，退回 CLI 重发就是「点两次」；
 * - **请求还没发出去**（读不到端点、连不上、握手失败），或**只读命令**：回退 CLI 重来一次；
 * - **协议漂移**（daemon 不认这个方法）：永久关掉快路径并回退 CLI。
 */
async function runBskCommand(
  args: string[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<string> {
  const plan = ipcFastPathUsable() && !signal?.aborted ? planIpcCall(args) : null;
  if (!plan) return await runBsk(args, signal, timeoutMs);

  try {
    const result = await ipcCall(plan.sessionKey, plan.method, plan.params, timeoutMs, signal);
    // 原生对话框随每次交互的结果带回（result.dialogs）：CLI 路径下它在 stderr 里，
    // 这里在 result 里。两条路径追加到同一个位置，模型看到的形状便与走哪条路无关。
    return withCliTrailingNewline(plan.render(result) + renderDialogs(dialogsOf(result)));
  } catch (err) {
    if (err instanceof BskIpcAbortError) {
      throw new BskAbortError(t("bsk.err.aborted", { cmd: args.join(" ") }));
    }
    if (err instanceof BskIpcRpcError) {
      if (isProtocolDrift(err)) {
        ipcDisabled = true;
        debugLog(`[bsk-ipc] daemon 不认 ${plan.method}（bsk 协议已变？），本进程改用 CLI 子进程`);
        return await runBsk(args, signal, timeoutMs);
      }
      throw ipcErrorToCliError(err);
    }
    if (err instanceof BskIpcTransportError) {
      if (err.sent && plan.mutating) {
        // 动作可能已经生效：不回退、不重发，按「超时且结果未知」交给上层。
        debugLog(`[bsk-ipc] ${plan.method} 已发出但没拿到结果（${err.message}），不重发`);
        throw ipcTimeoutToCliError(plan.method, err.message);
      }
      ipcSuspendedUntil = Date.now() + IPC_SUSPEND_MS;
      debugLog(`[bsk-ipc] 快路径不可用（${err.message}），本条改走 CLI 子进程`);
      return await runBsk(args, signal, timeoutMs);
    }
    throw err;
  }
}

function runBsk(
  args: string[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const done = timer();
    debugLog("[bsk] $ bsk " + args.join(" "));
    if (signal?.aborted) {
      reject(new BskAbortError(t("bsk.err.abortedBefore", { cmd: args.join(" ") })));
      return;
    }
    let aborted = false;
    const child = execFile(
      "bsk",
      args,
      { encoding: "utf-8", timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        signal?.removeEventListener("abort", onAbort);
        // 必须先判中止：被 kill 出来的错误同样是 SIGTERM，后判会被误报成「命令超时」。
        if (aborted) {
          reject(new BskAbortError(t("bsk.err.aborted", { cmd: args.join(" ") })));
          return;
        }
        if (!err) {
          debugLog(`[bsk] $ bsk ${args[0] ?? ""} 完成（${done()}ms）`);
          // 对话框摘要走 stderr（human 模式），成功路径此前整条丢掉。有它时才先收掉
          // stdout 的尾换行再附加：IPC 路径的文本不带尾换行、由 withCliTrailingNewline
          // 统一补上，这样两条路径的最终形状才一致（不多出空行）。
          const dialogs = extractDialogs(String(stderr ?? ""));
          resolve(
            dialogs ? String(stdout).replace(/[\r\n]+$/, "") + dialogs : String(stdout),
          );
          return;
        }
        debugLog(`[bsk] $ bsk ${args[0] ?? ""} 失败（${done()}ms）`);
        const e = err as { code?: string; signal?: string };
        if (e.code === "ENOENT") {
          reject(new Error(t("bsk.err.notFound")));
          return;
        }
        if (e.code === "ETIMEDOUT" || e.signal === "SIGTERM") {
          reject(
            new Error(
              t("bsk.err.timeout", {
                seconds: Math.round(timeoutMs / 1000),
                cmd: args.join(" "),
              }),
            ),
          );
          return;
        }
        // execFile 回调里的 error 上**不带** stdout/stderr（实测 Node 22 上 `err.stdout`
        // 就是 undefined，内容只在回调参数里），而 bsk 恰恰把结构化失败原因打在 stdout
        // （`{"code":…,"message":…,"exit_code":…}`）。原样 reject 的话，上层能拿到的只有
        // `Command failed: bsk …` 这行包装噪声——下载失败证据与 navigate 诊断都靠它，
        // 丢掉等于让每次失败都说不清原因。
        reject(
          Object.assign(err as { stdout?: string; stderr?: string }, {
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
          }),
        );
      },
    );
    const onAbort = () => {
      aborted = true;
      child.kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * `bsk status --json` 的异步版本。
 *
 * 与同步版返回语义一致：daemon 未运行/解析失败返回 null；bsk 未安装（ENOENT）抛出致命错误。
 * 用于 daemon 启动轮询：轮询期间必须让出事件循环，否则同步子进程调用会阻塞
 * 整个进程，导致启动等待期（最长 30s）无法响应 Ctrl+C 等信号。
 */
function bskStatusJsonAsync(): Promise<unknown | null> {
  return new Promise((resolve, reject) => {
    execFile(
      "bsk",
      ["status", "--json"],
      { encoding: "utf-8", timeout: BSK_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err) {
          const e = err as { code?: string };
          if (e.code === "ENOENT") {
            reject(new Error(t("bsk.err.notFound")));
            return;
          }
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(stdout) as unknown);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/** 当前是否已连接至少一个浏览器（从 status 解析，异步）。 */
async function connectedBrowserCount(): Promise<number> {
  const status = (await bskStatusJsonAsync()) as { browsers?: unknown[] } | null;
  if (!status || !Array.isArray(status.browsers)) return 0;
  return status.browsers.length;
}

/** 后台启动 bsk daemon（bsk daemon start 是前台阻塞的，必须 detached 启动后轮询等待就绪）。 */
function startDaemon(): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    info(t("bsk.daemon.starting"));
    const child = spawn("bsk", ["daemon", "start"], {
      detached: true,
      stdio: "ignore",
      // Windows 下 detached 子进程默认会弹出一个控制台窗口；daemon 是后台进程，不该有窗口。
      windowsHide: true,
    });
    child.unref();

    const deadline = Date.now() + 30_000;
    const poll = async () => {
      try {
        if (child.exitCode !== null && child.exitCode !== 0) {
          reject(
            new Error(t("bsk.err.daemonExit", { code: child.exitCode })),
          );
          return;
        }
      } catch {
        // 子进程状态读取失败，继续轮询
      }
      let status: unknown | null;
      try {
        status = await bskStatusJsonAsync();
      } catch (err) {
        // bsk 未安装（ENOENT）：致命错误，直接失败而不是空等 30s
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (status !== null) {
        info(
          t("bsk.daemon.ready", {
            seconds: ((Date.now() - started) / 1000).toFixed(1),
          }),
        );
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(t("bsk.err.daemonTimeout")));
        return;
      }
      debugLog(
        `[bsk] 等待 daemon 就绪… ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
      setTimeout(poll, 500);
    };
    setTimeout(poll, 500);
  });
}

let readyPromise: Promise<void> | null = null;

/**
 * 自动确保 bsk 就绪：启动 daemon（若未运行）+ 校验浏览器连接（若未连则报错）。
 * 同一进程最多一个在飞的检查；**成功后**才缓存结果。
 *
 * 失败不能缓存：「此刻未连接浏览器」是交互模式的常态（用户连上之后下一条用例就该能跑），
 * 若把 rejected 的 promise 缓存住，本进程会拿第一次的失败答复所有后续调用，再无恢复机会。
 */
export function ensureBskReady(): Promise<void> {
  if (readyPromise) return readyPromise;
  const attempt = (async () => {
    debugLog("[bsk] 查询 daemon 状态…");
    if ((await bskStatusJsonAsync()) === null) {
      await startDaemon();
    } else {
      debugLog("[bsk] daemon 已在运行，跳过启动");
    }
    const n = await connectedBrowserCount();
    if (n === 0) {
      throw new Error(t("bsk.err.noBrowser"));
    }
    info(t("bsk.connected", { count: n }));
  })();
  attempt.catch(() => {
    // 只清掉自己这次的结果：并发场景下 readyPromise 可能已被下一次调用替换。
    if (readyPromise === attempt) readyPromise = null;
  });
  readyPromise = attempt;
  return readyPromise;
}

/**
 * 从 bsk 输出里抠出 JSON。
 *
 * 不用 `JSON.parse(out)` 一把梭：bsk 在 JSON 前后可能带进度行（ensureSession 里为同样的
 * 原因做了兜底），直接抛会把一条已经捕获成功的下载判成解析失败。
 */
function parseBskJson<T>(out: string): T | null {
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(out.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/**
 * 取交互结果里的原生对话框（`dialogs` 字段）。
 *
 * 形状不认识（不是对象、字段缺失）时给 undefined —— 对话框是**附加信息**，
 * 读不到不该影响一次已经成功的操作。
 */
function dialogsOf(result: unknown): unknown {
  return result && typeof result === "object"
    ? (result as { dialogs?: unknown }).dialogs
    : undefined;
}

/**
 * 把 bsk 命令失败的原因压成一行可读文本（下载失败时作为证据）。
 *
 * Node 的 `execFile` 会在 message 前面挂一行 `Command failed: bsk …`——那是包装噪声，
 * 真正有用的 `error:/hint:/details:` 在它后面（与 navigate-diagnosis 的取舍一致）。
 */
function bskErrorDetail(err: unknown): string {
  const envelope = bskErrorEnvelope(err);
  if (envelope?.message?.trim()) return envelope.message.trim().slice(0, 400);
  // 没有信封（daemon 未起、参数错、被中止等）时退回原始文本：readErrorText 认 stderr 与
  // 包装后的 message，再剥掉 `Command failed: …` 那一行包装噪声。
  const raw = readErrorText(err).trim();
  const lines = raw
    .split(/\r?\n/)
    .filter((line) => !/^Command failed:/.test(line));
  return (lines.join(" ").trim() || raw).replace(/\s+/g, " ").slice(0, 400);
}

/**
 * bsk 的结构化失败信封（打在 **stdout**，runBsk 已把它贴到错误对象上）。
 *
 * 有它才能区分「元素根本没找到」与「元素点了但没产生下载」——这两种失败的处置完全相反
 * （前者该抛错让模型重试，后者该记一条不成立的断言），而光看 `Command failed:` 分不出来。
 */
function bskErrorEnvelope(err: unknown): BskErrorJson | null {
  const e = err as { stderr?: unknown; stdout?: unknown } | null | undefined;
  const text = [e?.stderr, e?.stdout]
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .join("\n");
  const json = parseBskJson<BskErrorJson>(text);
  return json && typeof json.code === "string" ? json : null;
}

/** 构造 AgentTool 标准的成功返回（含必填 details 字段）。 */
function ok(text: string) {
  return { content: [{ type: "text", text } as const], details: {} };
}

/**
 * 构造 AgentTool 的 parameters 声明。
 * pi-agent-core 的 parameters 类型与 JSON Schema 子集不完全兼容，
 * 这里集中做一次类型断言，避免在每个工具定义里重复 `as unknown as ...`。
 */
function paramsOf(
  properties: Record<string, unknown>,
  required: string[] = [],
): AgentTool["parameters"] {
  // SAFETY: pi-agent-core 的 AgentTool["parameters"] 类型是 JSON Schema 的受限子集，
  // 与这里构造的 {type, properties, required} 结构在运行时兼容，但静态类型无法推导，
  // 因此集中在此处断言一次（工具定义处不再重复断言）。
  return {
    type: "object",
    properties,
    required,
  } as unknown as AgentTool["parameters"];
}

/**
 * `showPage` 参数的声明（click / fill / hover 共用，措辞必须一致）。
 *
 * 默认**关闭**而不是默认开：附带的是一整份元素清单，在 Element Plus 那种几百个可交互
 * 元素的页面上它本身就很大，每步都附等于让上下文翻倍——那反而更慢。只有当模型知道
 * 「这一步会改变页面、接下来要看新编号」时才值得带上。
 */
const SHOW_PAGE_PARAM = {
  type: "boolean",
  description:
    "可选。设为 true 时，动作完成后在结果里附一份「动作后的可交互元素」清单（含新的 @eN 编号）——" +
    "展开下拉/菜单/弹窗之后用它，可以直接拿到新编号，省掉紧接着的一次 snapshot。" +
    "其它情况不要开：清单本身不小，每步都带会把上下文撑大。",
} as const;

/**
 * `showPage` 的「**默认开**」版本（`select_option` / `pick_date` 用）。
 *
 * 为什么这两个工具与 click/fill/hover 的默认值相反：它们**必然**改动页面（点开浮层、
 * 写入取值、收起面板），`markStale()` 之后模型手里那套编号全部失效；而「选完一个控件、
 * 紧接着操作同一区域的下一个控件」是用例里最常见的节奏。默认不给清单，就只剩最贵的
 * 那条路——引用被拒 → 模型再想一轮 → 重新 snapshot → 重试（实测每个选择类动作白付
 * 一轮 LLM 往返 + 一次全量快照，D1 那种「4 个下拉 + 2 个日期范围」的用例要白付 6 次）。
 *
 * 代价可控：清单是快照的 `refs` 档位（只留可交互元素），比模型本来要拍的那份全量快照小，
 * 因此这一步通常是**省上下文**而不是加。确实不需要时（本场景最后一次操作页面）传 false。
 */
const SHOW_PAGE_PARAM_DEFAULT_ON = {
  type: "boolean",
  description:
    "可选，默认 true：动作完成后在结果里附一份「动作后的可交互元素」清单（含新的 @eN 编号）。" +
    "选择类操作必然改动页面（点开浮层/写入取值/收起面板），旧的 @eN 随即失效——" +
    "带上它就能直接拿到新编号继续操作，省掉一次失败的引用校验和一次单独的 snapshot。" +
    "本次已是本场景最后一次操作页面时可以传 false。",
} as const;

/**
 * `showPage` 的取值：**默认开**，只有显式传 `false` 才关（见 SHOW_PAGE_PARAM_DEFAULT_ON）。
 *
 * 抽成函数是为了能被单测钉住：这是选择类工具与 click/fill/hover 唯一的行为差异，
 * 也正是「每个选择动作白付一轮失败重试 + 一次全量快照」那个问题的开关。
 */
export function resolveShowPage(requested?: boolean): boolean {
  return requested !== false;
}

/**
 * 断言型工具：它们的调用结果是一条**断言**（进报告、影响退出码），而不只是一次操作。
 *
 * 用一个集合而不是散落的 `||`：新增断言型工具时只改这里，`exec` 的上报与报告侧的取用
 * 都不会漏掉——漏掉的后果是「断言跑了但报告里没有它」，一条静默的假通过。
 */
const ASSERTION_TOOLS: ReadonlySet<string> = new Set([
  "assert_text",
  "download",
  "assert_no_console_error",
  "assert_network",
]);

/**
 * bsk 操作层：一次浏览器操作 = 一条 bsk 命令。
 *
 * `lastSnapshot()` 暴露「最近一次快照文本」：录制时用它把 `@eN` 解析成语义定位符
 * （`@eN` 只在那次快照内有效，不能直接写进回放脚本）。
 */
export interface BskOps {
  readonly session: string;
  /** 最近一次快照文本（每次 snapshot / assert_text 都会刷新）。 */
  lastSnapshot(): string;
  navigate(url: string, signal?: AbortSignal): Promise<string>;
  /**
   * 读取页面快照（已瘦身）；期间无页面改动且间隔很短时复用上一份，不重新抓取。
   *
   * `fresh` 绕开这个复用窗口（见 SNAPSHOT_DEDUP_MS）：回放的**定位轮询**必须每次都看当下，
   * 否则连续几次轮询会拿到同一份旧快照，把「页面就绪了没有」问成一句废话
   * （见 replay.ts 的 resolveByWaiting）。
   */
  snapshot(signal?: AbortSignal, options?: { fresh?: boolean }): Promise<string>;
  click(target: string, signal?: AbortSignal): Promise<string>;
  fill(target: string, value: string, signal?: AbortSignal): Promise<string>;
  upload(
    target: string | undefined,
    file: string,
    signal?: AbortSignal,
  ): Promise<string>;
  /**
   * 捕获一次下载：由本方法**自己点击** `target`（触发下载的元素），把捕获到的文件落到本地。
   *
   * 方法名与 bsk 子命令同名，语义也一致：`target` 必填——实测 bsk 省略它直接报
   * `missing target`（exit_code 2），并不存在「等一次正在进行的下载」这种用法。
   * 因此调用方**不能先 click 再调本方法**：那样下载已经流走，没人接。
   *
   * 失败不抛错，而是把结论写成一条**不成立的断言**（见 AssertOutcome）：
   * 「该下载却没下载」正是这条用例要判的事，抛成工具错误只会让模型当成环境抖动去重试。
   */
  download(
    target: string,
    out: string | undefined,
    expectName: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string>;
  hover(target: string, signal?: AbortSignal): Promise<string>;
  scroll(target: string, signal?: AbortSignal): Promise<string>;
  /**
   * 按一次键盘键（可选：先聚焦到某元素再按）。
   *
   * 与用 `evaluate` 注入合成 `KeyboardEvent` 的区别：这里走 bsk（CDP
   * `Input.dispatchKeyEvent`），是**真实按键**——React/Vue 受控组件、快捷键处理、
   * 「输入框里回车提交」这类原生行为认得它；而合成事件多半被框架忽略（`isTrusted=false`）。
   */
  press(
    key: string,
    options?: { target?: string; modifiers?: string; holdMs?: number },
    signal?: AbortSignal,
  ): Promise<string>;
  /**
   * 截一张图并落盘（视口 / 整页 / 某个元素），返回落盘路径。
   *
   * 它是**只读**动作：不改变页面内容，因此不像 click/fill 那样让快照失效；它也不产生断言
   * ——「截图」本身不是结论，结论仍由 assert_* 给。它的价值在于**证据**：报告会把这些图
   * 内联出来，失败现场因此不用靠文字去脑补。
   */
  screenshot(
    options?: { fullPage?: boolean; target?: string; out?: string },
    signal?: AbortSignal,
  ): Promise<string>;
  /**
   * 派发一次**真实滚轮事件**。
   *
   * 和 `scroll(target)` 不是一回事：那个是 `scroll-to`（把元素滚进视口，**不产生滚动事件**），
   * 而这个走 CDP 的 wheel 输入——页面的 `scroll` 监听、无限加载的触底回调、
   * 横向滚动容器认的都是它。
   */
  wheel(
    options?: { target?: string; deltaX?: number; deltaY?: number; modifiers?: string },
    signal?: AbortSignal,
  ): Promise<string>;
  /**
   * 让元素获得 / 失去焦点。
   *
   * 表单校验常挂在 blur 上（值填完了但错误提示不出来，就是还没触发失焦），而「点一下别处」
   * 会顺带触发那个元素的点击副作用；想干净地只改焦点就用这两个。
   */
  focus(target: string, signal?: AbortSignal): Promise<string>;
  blur(target: string, signal?: AbortSignal): Promise<string>;
  /**
   * 取原始 DOM HTML（可选只取某个 `@eN` 子树）。
   *
   * 补的是 snapshot 的盲区：快照是 aria 树 + 可见文本，看不到**属性**
   * （class / data-* / value / href / disabled），长文本还会被截断。
   */
  getHtml(
    options?: { target?: string; maxBytes?: number; out?: string },
    signal?: AbortSignal,
  ): Promise<string>;
  wait(ms: number, signal?: AbortSignal): Promise<string>;
  /**
   * 等页面稳定下来：没有正在播的动画、且 DOM 已经安静一小会儿；已经是稳定状态时立刻返回。
   *
   * 与 `wait(ms)` 的区别是**盲等 vs 条件等**：回放里「一步失败后重试」用它替代固定 500ms，
   * 因为那笔等待的绝大多数花在「页面上根本没有这个元素」上——再等也不会出现。
   * 上限 `maxMs` 内一定返回，不会把一步拖死。
   */
  settle(maxMs?: number, signal?: AbortSignal): Promise<string>;
  /**
   * 等到条件成立：页面出现某文本 / 某元素出现 / 某元素消失；到点仍未成立则如实返回「未达成」。
   *
   * 与 `wait(ms)` 的区别是**知道在等什么**：条件一成立就走，因此回放里能省掉录制时猜的秒数；
   * 又不像 `settle` 那样等的是「页面稳定」这个代理指标，条件不成立就一定等满上限，
   * 因此不存在提前放行的风险。
   */
  waitFor(cond: WaitCondition, timeoutMs?: number, signal?: AbortSignal): Promise<string>;
  /**
   * 选择一个下拉/级联选项：点开控件 → 等浮层 → 按可见文本匹配选项 → 真实点击。
   *
   * 存在的理由是**省往返**：通用路径下这一步是「click 点开 → snapshot 看编号 →
   * click 点选项」（常常还要再 snapshot 确认），每次工具调用都是一轮 LLM 往返（几秒）；
   * 这里把它们压成一次调用，中间态根本不进模型上下文。
   *
   * 找不到浮层或选项时**抛错**，不猜、不静默：拿不到就说明这条捷径在这页面上不适用，
   * 该由模型退回「看快照自己点」的通用路径，而不是被一个假的成功蒙过去。
   */
  selectOption(target: string, option: string, signal?: AbortSignal): Promise<string>;
  /**
   * 选一个日期（或一个日期范围）：点开面板 → 导航到目标年月 → 点日 →（有「确定」则点它）。
   *
   * 与 selectOption 同一动机。日期写法见 picker.ts 的 parseDateSpec：
   * `2026-09-29` / `2026/9/29` / `2026年9月29日` / `today` / `今天` / `+3` / `-7`。
   *
   * 给了 `endSpec` 就按**范围**处理（选开始 → 选结束 → 确定）。面板类型与参数必须一致：
   * 范围面板只给一个日期、或单日期面板给了两个，都会**明确报错**而不是将就着做完——
   * 「只选了一端的范围 + 点掉确定」会留下一个半截筛选条件，而工具还会报成功，
   * 那种假成功比报错难查得多。
   */
  pickDate(
    target: string,
    spec: string,
    endSpec?: string,
    signal?: AbortSignal,
  ): Promise<string>;
  /**
   * 断言页面是否包含期望文本：字面包含优先，字面未命中时（Jev 可用）才做语义复核。
   *
   * `opts.absent` 为 true 时语义反转：断言页面**不包含**该文本（字面命中即不成立）。
   * 反向断言不做语义复核，理由见 `literalAssertion`。
   */
  assertText(
    expectation: string,
    opts?: AssertTextOptions,
    signal?: AbortSignal,
  ): Promise<string>;
  /**
   * 断言「页面没有 JavaScript 报错」：读 console 缓冲，找 `exception` / `error` 级条目。
   *
   * 为什么值得单独做一个工具：这类错误**不体现在页面文字上**，`assert_text` 永远看不到它，
   * 而它恰恰是页面测试最该抓的一类缺陷（脚本抛异常 → 点了按钮没反应 → 后续断言全挂，
   * 报告里却只说「没找到某段文本」）。做成断言而不是「读一下看看」「没有报错」也是这个
   * 原因：它是一件应该影响退出码的事实。
   *
   * `ignore` 是必需的逃生口：被测页面常有已知噪音（第三方脚本、favicon 404 之类），
   * 没有它，用户只剩下「把断言删掉」一条路——那等于把这类缺陷整个放弃。
   */
  assertNoConsoleError(
    options?: { ignore?: string[]; warnings?: boolean },
    signal?: AbortSignal,
  ): Promise<string>;
  /**
   * 断言「某个请求发生了，且状态符合期望」：读 network 缓冲，按 URL 子串（可选方法）匹配。
   *
   * 与 `assert_text` 是同一件事的两面：一个看页面**显示**了什么，一个看页面**请求**了什么。
   * 后端 500 而前端把错误吞掉、只显示一句「操作失败」的页面，只有它能抓到真正的原因。
   */
  assertNetwork(
    url: string,
    options?: { status?: string; method?: string },
    signal?: AbortSignal,
  ): Promise<string>;
  /** 最近一次 assertText 是否**靠 Jev 语义判断才成立**（供录制标记语义断言）。 */
  lastAssertSemantic(): boolean;
  /**
   * 最近一次 assertText 的**结构化结果**（期望值、成立与否、证据）。
   *
   * 报告用它做断言的准源：工具返回的「成立/不成立」是确定性的，而模型自述的措辞
   * 千变万化（「…，断言成立。」这类写法既没有期望值也没法可靠解析），据此解析
   * 会造成「实际已全部通过却报 0/N」的假失败。
   */
  lastAssert(): AssertOutcome | null;
}

/** 一次断言型工具（assert_text / download / assert_no_console_error / assert_network）的结构化结果。 */
export interface AssertOutcome {
  /** 断言期望（assert_text 的 expectation，或 download 的「文件已下载」期望）。 */
  expectation: string;
  /** 是否成立。 */
  pass: boolean;
  /** 证据（页面里看到/没看到什么，或捕获到/没捕获到什么文件）。 */
  evidence: string;
}

/**
 * `assert_text` 的方向参数。
 *
 * 为什么需要它：字符串包含匹配只能表达「页面**有**这段文字」。用例里的
 * 「断言页面不包含 X / X 不存在」若照旧把 X 当正向期望传进来，一条本该通过的断言
 * 必然返回「不成立」——实测就是这么把 A3 判成了假失败。
 */
export interface AssertTextOptions {
  /** true = 断言页面**不包含** `expectation` 这段文本。 */
  absent?: boolean;
}

/** 快照短于这个长度就当作「页面还没打开」——见 literalAssertion 的第一条规则。 */
const MIN_ASSERT_SNAPSHOT_CHARS = 30;

/**
 * 断言判定的**字面部分**（纯函数）：给定快照与期望，得出不依赖语义复核的结论。
 *
 * 返回 `null` 表示「正向断言、字面未命中」——只有这一种情形才值得再请 Jev 复核
 * （同义词/近义表达/格式差异造成的误报 FAIL）。抽成纯函数是因为这里有三条容易写错的规则：
 *
 * - **快照过短（页面没打开）时反向断言也不能算成立**：空页面上确实什么都不存在，但那是
 *   「还没导航」而不是「页面确实没有这段文字」；判成成立就是一条最危险的假通过
 *   （用例写错 URL 也会「通过」）。
 * - **反向断言只做字面判断**：语义相似度回答不了「页面上有没有意思相近的文字」，
 *   把它当成「不成立」的证据，正是 A3 被 Jev 以 3% 匹配度判 FAIL 的原因。
 * - 证据要写清「看到/没看到什么」，否则反向断言的失败读起来与正向断言一模一样。
 */
export function literalAssertion(
  snapshot: string,
  expectation: string,
  absent = false,
): { pass: boolean; evidence: string } | null {
  const snapLen = snapshot.trim().length;
  if (snapLen < MIN_ASSERT_SNAPSHOT_CHARS) {
    return {
      pass: false,
      evidence: `证据：页面快照为空或过短（${snapLen} 字符），页面可能尚未打开或未导航`,
    };
  }
  const hit = snapshot.includes(expectation);
  if (absent) {
    return hit
      ? { pass: false, evidence: `页面中包含「${expectation}」（断言要求不包含）` }
      : { pass: true, evidence: `页面中未找到「${expectation}」` };
  }
  if (hit) return { pass: true, evidence: `页面中包含「${expectation}」` };
  return null;
}

/** bsk 失败时打在 stdout 的结构化信封（用到哪几个就声明哪几个，其余忽略）。 */
interface BskErrorJson {
  /** 机器可读的错误类别，如 `not_found`（元素/资源不存在）、超时等。 */
  code?: string;
  /** 人可读的原因（证据里用的就是它）。 */
  message?: string;
  /** 通用劝退提示（如「是不是 daemon 没起」），对定位没帮助，不往证据里放。 */
  hint?: string;
  /** 细分原因，如 `selector_not_found`。 */
  data?: { reason?: string };
}

/** `bsk download --json` 回传的字段（用到哪几个就声明哪几个，其余忽略）。 */
interface BskDownloadJson {
  /** 落盘路径（bsk 写的就是我们给的 --out，这里用于交叉核对）。 */
  path?: string;
  /** 服务器建议的文件名（`Content-Disposition`），未给时为 null。 */
  suggested_filename?: string | null;
  /** 落盘字节数。 */
  byte_size?: number;
  /** 内容类型。 */
  mime?: string | null;
  /** bsk 对下载内容的危险分级（如 `safe`）。 */
  danger?: string | null;
}

/** 一条 console 记录（`bsk console --json` 的 `entries[]`；只声明用到的字段）。 */
interface BskConsoleEntry {
  /** 文档序（单调递增）。 */
  sequence?: number;
  /** `console`（console.* 调用）/ `exception`（未捕获异常）/ `log`（浏览器日志，如资源 404）。 */
  kind?: string;
  /** `error` / `warning` / `warn` / `log` / `info` / `debug`… */
  level?: string;
  /** 正文（已被 bsk 按 `--max-text-chars` 截断）。 */
  text?: string;
  /** 出处的脚本 URL。 */
  url?: string;
  line?: number;
}

/** `bsk console --json` 回传的字段（用到哪几个就声明哪几个）。 */
interface BskConsoleJson {
  entries?: BskConsoleEntry[];
  /** 缓冲里还有更早的记录没能返回（超过扩展的缓冲上限）。 */
  truncated?: boolean;
}

/** 一条网络记录（`bsk network --json` 的 `entries[]`；只声明用到的字段）。 */
interface BskNetworkEntry {
  sequence?: number;
  /** `response`（收到了响应）/ `failure`（请求未完成）。 */
  kind?: string;
  method?: string;
  url?: string;
  /** HTTP 状态码（仅 `response`）。 */
  status?: number;
  /** CDP 的失败原因（仅 `failure`），如 `net::ERR_CONNECTION_REFUSED`。 */
  error_text?: string;
}

/** `bsk network --json` 回传的字段（用到哪几个就声明哪几个）。 */
interface BskNetworkJson {
  entries?: BskNetworkEntry[];
  truncated?: boolean;
}

/** `bsk screenshot --json` 回传的字段（用到哪几个就声明哪几个）。 */
interface BskScreenshotJson {
  tab_id?: number;
  width?: number;
  height?: number;
  format?: string;
  path?: string;
  byte_size?: number;
  /** 截不到时的原因（如 `page_hidden`）；**有它说明这次截图没成**，不是一张空图。 */
  capture_unavailable?: string;
}

/** `bsk get-html --json` 回传的字段（用到哪几个就声明哪几个）。 */
interface BskGetHtmlJson {
  tab_id?: number;
  html?: string;
  /** 未截断时的原始字节数（截断后它仍是原始长度）。 */
  byte_size?: number;
  truncated?: boolean;
}

/**
 * `get_html` 默认给模型多少 HTML：约 4–5K token 的体量，够看清属性，又不至于挤掉上下文。
 */
const HTML_BUDGET_DEFAULT = 16 * 1024;

/** `get_html` 允许内联的最大体量：再大就该走 `out` 落盘，而不是塞进模型上下文。 */
const HTML_BUDGET_MAX = 64 * 1024;

/**
 * 收敛 `get_html` 的字节预算。
 *
 * 为什么由工具这边管死：HTML 是**原样进模型上下文**的东西。bsk 自己的默认预算是 512KiB，
 * 折合十几万 token，一次调用就能把上下文冲爆——而模型多半只是想确认某个 class 在不在。
 * 要更大的范围就走 `out` 落盘（那条路径不设预算，返回的是路径而不是正文）。
 *
 * 超出上限时**报错而不是静默改小**：静默截断会让模型以为自己看到了完整 DOM，
 * 由此得出的「页面里没有这个属性」是假的。
 */
function clampHtmlBudget(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return HTML_BUDGET_DEFAULT;
  const n = Math.floor(requested);
  if (n < 1 || n > HTML_BUDGET_MAX) {
    throw new Error(t("bsk.getHtml.badBudget", { max: HTML_BUDGET_MAX }));
  }
  return n;
}

/** console 的读取上限：与扩展侧的缓冲上限（`MAX_CONSOLE_BUFFER = 200`）一致，一次拿全。 */
const CONSOLE_LIMIT = 200;

/** 网络记录的读取上限：同上（`MAX_NETWORK_BUFFER = 200`）。 */
const NETWORK_LIMIT = 200;

/**
 * 这条 console 记录算不算「报错」。
 *
 * `kind === "exception"` 是未捕获异常（一定是错）；`level === "error"` 覆盖 `console.error`
 * 与浏览器日志里的错误条目（含资源加载失败这类 `kind: "log"` 的记录）。warning 只在显式
 * 要求时才算——第三方库的 deprecation 警告太常见，默认把它们当失败会让这个工具没法用。
 */
export function isConsoleOffender(
  entry: { kind?: string; level?: string },
  withWarnings: boolean,
): boolean {
  if (entry.kind === "exception") return true;
  const level = (entry.level ?? "").toLowerCase();
  if (level === "error") return true;
  // CDP 两处来源写法不一：Runtime 侧给 `warning`，部分版本给 `warn`。
  return withWarnings && (level === "warn" || level === "warning");
}

/**
 * 这条记录是不是**浏览器自身 / 扩展**产生的（而不是被测页面的）。
 *
 * 必须过滤掉它们，这不是洁癖：任何真实浏览器上都装着一堆扩展，它们在页面里注入的脚本
 * 会产生自己的请求与报错。实测（2026-09-29，真实跑）——一条
 * `GET chrome-extension://invalid/ net::ERR_FAILED` 就足以让「断言页面没有报错」失败，
 * 而那条报错与被测页面毫无关系。不过滤的话，这个断言在**每个人**的机器上都会红。
 */
export function isBrowserInternalUrl(url: string | undefined): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return (
    lower.startsWith("chrome-extension://") ||
    lower.startsWith("chrome-untrusted://") ||
    lower.startsWith("chrome://") ||
    lower.startsWith("devtools://") ||
    lower.startsWith("moz-extension://")
  );
}

/** 状态码期望：`200` 精确，`2xx` / `4xx` / `5xx` 区间；认不出返回 null。 */
export type StatusSpec = { exact: number } | { from: number; to: number };

export function parseStatusSpec(spec: string): StatusSpec | null {
  const text = spec.trim().toLowerCase();
  if (!text) return null;
  const range = /^([1-5])xx$/.exec(text);
  if (range) {
    const base = Number(range[1]) * 100;
    return { from: base, to: base + 99 };
  }
  const exact = Number(text);
  if (!Number.isInteger(exact) || exact < 100 || exact > 599) return null;
  return { exact };
}

/** 状态码期望 → 可读文案（期望描述与证据里用同一个形状）。 */
function describeStatusSpec(spec: StatusSpec): string {
  return "exact" in spec ? String(spec.exact) : `${Math.floor(spec.from / 100)}xx`;
}

/** 某条响应是否满足状态码期望。 */
export function statusMatches(status: number | undefined, spec: StatusSpec): boolean {
  if (typeof status !== "number") return false;
  return "exact" in spec
    ? status === spec.exact
    : status >= spec.from && status <= spec.to;
}

/**
 * 取必填的 `target` 参数；缺失或为空时在**本地**报错。
 *
 * 与 wait_for 同一条规则：用法错误不消耗一次浏览器往返，这次失败也不会被录进回放脚本
 * （录制层只记成功的操作）。
 */
function requiredTarget(params: unknown, tool: string): string {
  const p = params as { target?: unknown } | null | undefined;
  const target = typeof p?.target === "string" ? p.target.trim() : "";
  if (!target) {
    throw new Error(`${tool} 需要给出 target（要操作的元素：@eN 引用或 CSS 选择器）`);
  }
  return target;
}

/** 把一段文本压成单行短句（证据要进报告，不能让它整段吞掉输出）。 */
function clipLine(text: string, max = 160): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

/**
 * 连续重复抓取的去重窗口：模型（或回放）在没有任何改页面动作的情况下又要素一份快照时，
 * 直接给上一份，省掉一次 bsk 往返。窗口给得短——它要覆盖的只是「刚看过又要素」这种重复。
 */
const SNAPSHOT_DEDUP_MS = 1_000;

/**
 * 断言可复用快照的窗口。
 *
 * 断言的「当下」比定位更敏感（页面可能已被异步更新），因此只在自上次快照以来
 * 没有任何改页面动作、且间隔很短的条件下复用；窗口外的实情是「模型思考了足够久」，
 * 此时宁可按原行为重新抓取。
 */
const SNAPSHOT_ASSERT_MS = 5_000;

export function createBskOps(session: string, jevClient?: JevClient): BskOps {
  const quiet = ["--session", session, "--quiet"];
  let snapshotText = "";
  /** 同一份快照瘦身前的完整原文（assert_text 的字面匹配必须用它，见 ensureRawSnapshot）。 */
  let snapshotRawText = "";
  let assertSemantic = false;
  let assertOutcome: AssertOutcome | null = null;
  /** 最近一次快照的时刻与新鲜度（见 ensureSnapshot）。 */
  let snapshotAt = 0;
  let snapshotFresh = false;
  /** 最近一次快照解析出的引用表（惰性解析一次，快照一换即作废）。 */
  let snapshotRefs: SnapshotRef[] | null = null;

  /** 页面被本工具改动过（或刚刚等待过），之前的快照不再可信。 */
  const markStale = (): void => {
    snapshotFresh = false;
  };

  /** 最近一次快照里的引用表（解析成本随快照长度线性增长，因此按快照缓存）。 */
  const refsOf = (): SnapshotRef[] => {
    if (snapshotRefs === null) snapshotRefs = parseSnapshotRefs(snapshotText);
    return snapshotRefs;
  };

  /**
   * 引用闸门：动作前确认 `@eN` 此刻指向的仍是同一批元素，并把落点交回给调用方回显。
   *
   * 必须在 `markStale()` **之前**调用——它判定的正是「动作之前页面有没有被改过」，
   * 放到 markStale 之后会把每一次带引用的动作都判成失效。
   *
   * 三种结论（判定逻辑在 locator.ts 的 inspectRefTarget，此处只负责措辞与回显）：
   * - CSS 选择器：放行，无可回显的落点；
   * - 快照之后页面已被改动 → 抛错，让模型重新 snapshot 再取编号；
   * - 编号不在最近一次快照里 → 抛错（沿用更早快照或凭记忆写编号）；
   * - 通过 → 返回「（落点：角色「名字」）」这段可读文本，供操作结果里回显。
   *
   * 为什么值得每次动作都解析一遍快照：它把「静默点到另一个元素」变成**模型自己看得见的一行**
   * （用例里的菜单点错就是这么发生的：侧边栏展开后旧编号落到了另一个菜单项上，没人发现）。
   */
  const checkRef = (action: string, target: string): string => {
    const info = inspectRefTarget(target, snapshotFresh, refsOf());
    if (info.kind === "css") return "";
    if (info.kind === "stale") {
      throw new RefStaleError(t("bsk.err.refStale", { action, target }));
    }
    if (info.kind === "unknown") {
      throw new Error(t("bsk.err.refUnknown", { action, target }));
    }
    // 引用行也可能没有可访问名（`@e42 button`）：拿不到名字时不编，直接不提落点。
    const who =
      info.role && info.name
        ? `${info.role}「${info.name}」`
        : info.role || info.name;
    return who ? t("bsk.ref.landed", { who }) : "";
  };

  /** 真正抓一次快照：瘦身后交给模型，并按需记录瘦身统计。 */
  const takeSnapshot = async (signal?: AbortSignal): Promise<string> => {
    const raw = await bsk(["snapshot", ...quiet], signal);
    const slim = slimSnapshot(raw);
    if (slim.applied) {
      debugLog(
        `[bsk] snapshot 瘦身：${slim.before} -> ${slim.after} 字符` +
          `（截断 ${slim.truncatedLines} 行、省略 ${slim.droppedLines} 行` +
          (slim.foldedRefs ? `、同名折叠 ${slim.foldedRefs} 个元素` : "") +
          `）`,
      );
    } else {
      // 快照体积直接决定上下文压力（长流程易因上下文超限被中断）
      debugLog("[bsk] snapshot 字符数=" + raw.length);
    }
    snapshotRawText = raw;
    snapshotText = slim.text;
    snapshotRefs = null;
    snapshotAt = Date.now();
    snapshotFresh = true;
    return snapshotText;
  };

  /**
   * 取快照：自上次快照后页面**没有被本工具改动**、且间隔在 maxAgeMs 内时复用上一份。
   *
   * 所有会改动页面的操作（navigate/click/fill/upload/hover/scroll/wait）都会把快照置为
   * 不新鲜，因此复用只可能发生在「纯读取之后」——最典型的是「刚 snapshot 完就断言」
   * 或回放里「上一步是断言、下一步要定位」。页面自身异步更新导致的偏差由窗口兜住。
   */
  const ensureSnapshot = async (
    maxAgeMs: number,
    label: string,
    signal?: AbortSignal,
  ): Promise<string> => {
    const age = Date.now() - snapshotAt;
    if (snapshotFresh && age <= maxAgeMs) {
      debugLog(`[bsk] ${label} 复用 ${age}ms 前的快照（期间页面未被改动）`);
      return snapshotText;
    }
    return await takeSnapshot(signal);
  };

  /**
   * 同 ensureSnapshot，但返回**瘦身前**的完整原文。
   *
   * 断言的字面匹配必须基于完整快照：瘦身会截断长文本行、整行省略非关键文本，
   * 拿瘦身文本做 includes，针对长页面文本的断言会假未命中，且证据不会说明漏看。
   * 模型上下文仍吃瘦身文本，省 token 的收益不受影响。
   */
  const ensureRawSnapshot = async (
    maxAgeMs: number,
    label: string,
    signal?: AbortSignal,
  ): Promise<string> => {
    const age = Date.now() - snapshotAt;
    if (snapshotFresh && age <= maxAgeMs) {
      debugLog(
        `[bsk] ${label} 复用 ${age}ms 前的完整快照（期间页面未被改动）`,
      );
      return snapshotRawText;
    }
    await takeSnapshot(signal);
    return snapshotRawText;
  };

  /**
   * daemon 端 sleep（`wait-ms` 不接受 --session）。
   * 抽成本地函数是因为 `settle` 的兜底路径也要用它——写成对象方法会依赖 `this`。
   */
  const doWait = async (ms: number, signal?: AbortSignal): Promise<string> => {
    // 等待本身就是为了让页面变化（异步渲染/动画/弹窗），因此必须置为不新鲜：
    // 回放的「每步重试前重新取快照」正是靠它生效的。
    markStale();
    // 超时按等待时长放宽：一律套默认 60s 的话 wait(90_000) 必然中途被杀，
    // 报出的还是「daemon 未启动」这种南辕北辙的提示。
    await bsk(["wait-ms", String(ms)], signal, ms + 30_000);
    return `已等待 ${ms}ms`;
  };

  /**
   * 等页面稳定：**由我们轮询页面侧同步探针**（判定规则与理由见 settle.ts）。
   *
   * 页面本来就稳定时只花一次探针（IPC 快路径下是毫秒级）；还在加载/播动画时每
   * `SETTLE_POLL_MS` 问一次，最多问到 `maxMs`。刻意不使用「页面内 await 一个 Promise」：
   * 那种写法依赖页面里的定时器，而后台标签页的定时器会被节流到 1s 以上，
   * 在用户切走窗口的场景下会比它要替代的固定 500ms 盲等还慢（详见 settle.ts 文件头）。
   *
   * 这一步同样要置快照为不新鲜——它的意义就是「等页面变完」，之后的重试必须重新取快照，
   * 否则会拿到变化前的缓存。
   */
  const doSettle = async (
    maxMs: number = SETTLE_MAX_MS,
    signal?: AbortSignal,
  ): Promise<string> => {
    markStale();
    const started = Date.now();
    const expr = buildSettleProbeExpression();
    for (;;) {
      const elapsed = Date.now() - started;
      let sample;
      try {
        const out = await bsk(
          ["evaluate", expr, "--session", session, "--timeout", `${SETTLE_PROBE_TIMEOUT_MS}ms`],
          signal,
          SETTLE_PROBE_TIMEOUT_MS + 10_000,
        );
        sample = parseSettleSample(out);
      } catch (err) {
        if (err instanceof BskAbortError) throw err;
        // 探针本身不可用（页面抛异常、evaluate 被拒）：退回固定短等待，
        // 「尽量少等」这件事失败了不该把一步回放判死。
        debugLog(
          "[bsk] settle 探针失败，退回固定短等待：" +
            (err instanceof Error ? err.message : String(err)),
        );
        await doWait(Math.min(SETTLE_FALLBACK_MS, maxMs), signal);
        return `页面稳定检测不可用，已等待 ${Math.min(SETTLE_FALLBACK_MS, maxMs)}ms`;
      }
      if (!sample) {
        debugLog("[bsk] settle 探针未返回可解析的结果，退回固定短等待");
        await doWait(Math.min(SETTLE_FALLBACK_MS, maxMs), signal);
        return `页面稳定检测不可用，已等待 ${Math.min(SETTLE_FALLBACK_MS, maxMs)}ms`;
      }
      if (isSettled(sample, { networkQuietMs: SETTLE_NETWORK_QUIET_MS })) {
        debugLog(`[bsk] settle：稳定（等待 ${elapsed}ms，${describeSample(sample)}）`);
        return `页面已稳定（等待 ${elapsed}ms，${describeSample(sample)}）`;
      }
      if (elapsed >= maxMs) {
        debugLog(`[bsk] settle：${maxMs}ms 内未稳定（${describeSample(sample)}），按上限继续`);
        return `页面未在 ${maxMs}ms 内稳定（${describeSample(sample)}），按上限继续`;
      }
      await sleep(Math.min(SETTLE_POLL_MS, maxMs - elapsed));
    }
  };

  /**
   * 等到条件成立（见 condition.ts）：页面**可见文本**出现、元素出现、或元素消失。
   *
   * 一条 `evaluate` 探针就是一次 IPC 往返（快路径下毫秒级），因此轮询是便宜的；
   * 命中判定与超时取证各多花一次 `evaluate`（读 `innerText` 比 `textContent` 贵，
   * 所以只在需要结论时读，而不是每次轮询都读）。
   */
  const doWaitFor = async (
    cond: WaitCondition,
    timeoutMs: number = DEFAULT_WAIT_FOR_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<string> => {
    const limit = Math.min(Math.max(1, Math.round(timeoutMs)), MAX_WAIT_FOR_TIMEOUT_MS);
    // 等待的意义就是让页面变化：缓存的快照一律不能再信（与 wait / settle 同一条规则）。
    markStale();
    const probeExpr = buildProbeExpression(cond);
    const confirmExpr = buildConfirmExpression(cond);
    const probe = async (expr: string): Promise<string> =>
      await bsk(
        ["evaluate", expr, "--session", session, "--timeout", `${SETTLE_PROBE_TIMEOUT_MS}ms`],
        signal,
        SETTLE_PROBE_TIMEOUT_MS + 10_000,
      );

    const outcome = await pollUntil<ConditionProbe>({
      timeoutMs: limit,
      intervalMs: WAIT_FOR_POLL_MS,
      sleep,
      now: Date.now,
      // 探针不可解析时返回 null：pollUntil 按「这次没取到」处理，继续轮询到上限。
      sample: async () => parseProbe(await probe(probeExpr)),
      isHit: async (sample) => {
        if (!probeSaysMaybe(cond, sample)) return false;
        if (!needsConfirm(cond)) return true;
        // 文本类条件：`textContent` 命中只说明「字在 DOM 里」，还要确认它**看得见**。
        const confirmed = parseConfirm(await probe(confirmExpr));
        return confirmed?.visibleHit === true;
      },
    });

    const what = describeCondition(cond);
    if (outcome.hit) {
      debugLog(`[bsk] wait_for：${what} 已达成（等待 ${outcome.waitedMs}ms，探针 ${outcome.polls} 次）`);
      return `等待「${what}」：已达成（等待 ${outcome.waitedMs}ms）`;
    }
    // 超时：取一次页面当前可见文本作为证据，并明确劝阻「再等一遍」——
    // 同一个条件等第二遍只会白烧时间，该做的是看清页面现在是什么。
    let excerpt = "";
    try {
      const confirmed = parseConfirm(await probe(confirmExpr));
      excerpt = confirmed?.excerpt ?? "";
    } catch (err) {
      if (err instanceof BskAbortError) throw err;
      debugLog("[bsk] wait_for 取证失败：" + (err instanceof Error ? err.message : String(err)));
    }
    debugLog(`[bsk] wait_for：${what} 未达成（等待 ${outcome.waitedMs}ms）`);
    return (
      `等待「${what}」：${limit}ms 内未达成` +
      (excerpt ? `（页面当前可见文本：「${excerpt}」）` : "") +
      `。不要重复等待同一个条件，先用 snapshot 确认页面当前状态`
    );
  };

  /**
   * 跑一条页面侧同步表达式。
   *
   * 与 wait_for / settle 走同一条路径（`bsk evaluate`）。表达式本身是毫秒级的，
   * 那个 timeout 只防页面卡死。
   */
  const evalExpr = async (expr: string, signal?: AbortSignal): Promise<string> =>
    await bsk(
      ["evaluate", expr, "--session", session, "--timeout", `${SETTLE_PROBE_TIMEOUT_MS}ms`],
      signal,
      SETTLE_PROBE_TIMEOUT_MS + 10_000,
    );

  /** 清掉上一次留下的选择标记（残留会把这次的真实点击引到别的元素上）。 */
  const clearMarks = async (signal?: AbortSignal): Promise<void> => {
    try {
      await evalExpr(buildClearMarksExpression(), signal);
    } catch (err) {
      if (err instanceof BskAbortError) throw err;
      // 清理失败不影响这次操作（标记本来就会被下一次覆盖），只留一行 debug。
      debugLog(
        "[bsk] 清理选择标记失败：" +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  };

  /** 依次尝试候选选择器，点中第一个存在的；全都不存在返回 false。 */
  const clickFirst = async (
    selectors: readonly string[],
    signal?: AbortSignal,
  ): Promise<boolean> => {
    for (const sel of selectors) {
      try {
        await bsk(["click", sel, ...quiet], signal);
        return true;
      } catch (err) {
        if (err instanceof BskAbortError) throw err;
        // 这个候选在当前组件库/版本里不存在：换下一个。全都不在才算「点不到」。
      }
    }
    return false;
  };

  /** 轮询一条探针直到命中或超时，返回最后一次解析出的样本。 */
  const pollProbe = async <T>(
    expr: string,
    hit: (sample: T | null) => boolean,
    parse: (out: string) => T | null,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T | null> => {
    const outcome = await pollUntil<T | null>({
      timeoutMs,
      intervalMs: WAIT_FOR_POLL_MS,
      sleep,
      now: Date.now,
      sample: async () => parse(await evalExpr(expr, signal)),
      isHit: (sample) => hit(sample),
    });
    return outcome.last;
  };

  /** 读一次浮层状态（不等待）；命中时表达式会顺手标记那个浮层。 */
  const probeOverlay = async (
    signal?: AbortSignal,
  ): Promise<OverlayProbe | null> =>
    parseOverlayProbe(await evalExpr(buildOverlayProbeExpression(), signal));

  /** 等一个可见浮层出现；命中时表达式会顺手标记那个浮层。 */
  const waitOverlay = async (
    signal?: AbortSignal,
  ): Promise<OverlayProbe | null> =>
    await pollProbe<OverlayProbe>(
      buildOverlayProbeExpression(),
      (sample) => sample?.hit === true,
      parseOverlayProbe,
      PICKER_WAIT_MS,
      signal,
    );

  /**
   * 问「target **自己**打开了吗」——按它声明的关联（`aria-controls`）找它的浮层。
   *
   * 比 `probeOverlay`（页面上有没有可见浮层）准：后者会把上一个还在关闭动画里的浮层
   * 误认成本次的，于是「跳过点击」跳错、或在别人的浮层里找选项。
   */
  const probeOwnOverlay = async (
    target: string,
    signal?: AbortSignal,
  ): Promise<OverlayProbe | null> =>
    parseOverlayProbe(await evalExpr(buildOwnOverlayExpression(target), signal));

  /** 等 target 自己的浮层出现（点开之后）。 */
  const waitOwnOverlay = async (
    target: string,
    signal?: AbortSignal,
  ): Promise<OverlayProbe | null> =>
    await pollProbe<OverlayProbe>(
      buildOwnOverlayExpression(target),
      (sample) => sample?.hit === true,
      parseOverlayProbe,
      PICKER_WAIT_MS,
      signal,
    );

  /** 页面上还有没有可见浮层（下拉、菜单、日期面板、通用 popper 都算）。 */
  const anyOverlayVisible = async (signal?: AbortSignal): Promise<boolean> =>
    parseOverlayProbe(
      await evalExpr(
        buildOverlayProbeExpression(WIDE_OVERLAY_SELECTORS),
        signal,
      ),
    )?.hit === true;

  /**
   * 等浮层收起来。
   *
   * 选完一项之后浮层还在做关闭动画，这段时间它**盖在下面的控件上面**：紧接着去点下一个
   * 控件，那一下会落在浮层上——A 的下拉没关、B 的下拉没开，后续读到的就是 A 的选项。
   * 真实页面上正是这么串的。
   *
   * 等不到也不报错：多选下拉本来就不关闭，那种情况交给下一次操作自己的定位逻辑。
   */
  const waitOverlayGone = async (signal?: AbortSignal): Promise<void> => {
    await pollUntil<boolean>({
      timeoutMs: PICKER_CLOSE_MS,
      intervalMs: WAIT_FOR_POLL_MS,
      sleep,
      now: Date.now,
      sample: async () => !(await anyOverlayVisible(signal)),
      isHit: (gone) => gone,
    });
  };

  /** 读一次日期面板状态（不等待）；命中时表达式会顺手标记那个面板。 */
  const probeDatePanel = async (
    signal?: AbortSignal,
  ): Promise<DatePanelProbe | null> =>
    parseDatePanelProbe(await evalExpr(buildDatePanelProbeExpression(), signal));

  /** 等日期面板出现。 */
  const waitDatePanel = async (
    signal?: AbortSignal,
  ): Promise<DatePanelProbe | null> =>
    await pollProbe<DatePanelProbe>(
      buildDatePanelProbeExpression(),
      (sample) => sample?.hit === true,
      parseDatePanelProbe,
      PICKER_WAIT_MS,
      signal,
    );

  /**
   * 把面板窗口移动到目标月，返回移动后的面板状态。
   *
   * 单日期面板只有一张表，范围面板左右两张（窗口宽两个月），两者都靠 `navDirection`
   * 算方向；区别只在点哪一组箭头——范围类型的箭头是 `.arrow-left` / `.arrow-right`，
   * 点一下整个窗口一起移动。
   */
  const navigateToMonth = async (
    target: DateSpec,
    range: boolean,
    signal?: AbortSignal,
  ): Promise<DatePanelProbe | null> => {
    let state = await probeDatePanel(signal);
    for (let i = 0; i < MAX_MONTH_NAV; i++) {
      if (!state?.hit) return state ?? null;
      const dir = navDirection(state.tables, target);
      if (dir === 0) return state;
      // 箭头限定在刚标记的那个面板内：全局选择器会命中 DOM 里第一个面板的箭头，
      // 页面上有多个日期选择器时那可能是别人的（点不到，或把别的控件改掉）。
      const moved = await clickFirst(
        scopedToRoot(
          range
            ? dir > 0
              ? DATE_RANGE_NEXT_SELECTORS
              : DATE_RANGE_PREV_SELECTORS
            : dir > 0
              ? DATE_NEXT_SELECTORS
              : DATE_PREV_SELECTORS,
        ),
        signal,
      );
      // 箭头全都不存在就停在这里：再循环也只是重复失败，点不到目标日时会如实报错。
      if (!moved) return state;
      state = await probeDatePanel(signal);
    }
    return state;
  };

  /**
   * 在目标月所在的那张表里点中目标日。
   *
   * `pickTableIndex` 为 -1（面板里读不出月份）时退回第一张表：范围面板的左右两表
   * 之外别无选择，而点错月份的风险由「点完校验结果」兜住——真点错时上层报的是
   * 「目标日点不到」，而不是一个假的成功。
   */
  const clickDateDay = async (
    container: string,
    target: DateSpec,
    state: DatePanelProbe,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const found = pickTableIndex(state.tables, target);
    const index = found >= 0 ? found : 0;
    const mark = parseDayMark(
      await evalExpr(
        buildDateDayMarkExpression(container, target.d, index),
        signal,
      ),
    );
    if (!mark?.found) {
      debugLog(
        `[bsk] pick_date 未命中 ${target.y}-${target.m}-${target.d}（表 ${index}）：${mark?.reason ?? "unknown"}`,
      );
      return false;
    }
    await bsk(["click", PICK_SELECTOR, ...quiet], signal);
    await clearMarks(signal);
    return true;
  };

  /** 面板有「确定」就点掉它（只有部分类型/配置会渲染出来）。 */
  const confirmDatePanel = async (signal?: AbortSignal): Promise<boolean> => {
    const after = await probeDatePanel(signal);
    if (!after?.hit || !after.hasFooter) return false;
    // 同理限定在标记的面板内：「确定」按钮在别的日期面板里也有一个。
    return await clickFirst(scopedToRoot(DATE_CONFIRM_SELECTORS), signal);
  };

  /**
   * 读 console 缓冲（最近 `CONSOLE_LIMIT` 条）。
   *
   * 刻意**不带 `--since`**：bsk 的语义是「没有游标时取尾部 limit 条」（见扩展的
   * `readBufferedEntries`：有游标才从头切片，没游标取 `slice(-limit)`）——正是「最近的报错」
   * 需要的。带游标反而会从头拿一批陈年记录，把最近的错误挤出窗口。
   */
  const readConsole = async (
    signal?: AbortSignal,
  ): Promise<{ entries: BskConsoleEntry[]; truncated: boolean }> => {
    const out = await bsk(
      ["console", "--limit", String(CONSOLE_LIMIT), "--json", ...quiet],
      signal,
    );
    const json = parseBskJson<BskConsoleJson>(out);
    if (!json || !Array.isArray(json.entries)) {
      // 形状认不出 = 这一条断言**没有依据**，不能当成「没有报错」放过去。
      throw new Error(t("bsk.console.unreadable"));
    }
    return {
      // 扩展注入脚本自己的报错不是被测页面的问题，先滤掉（理由见 isBrowserInternalUrl）。
      entries: json.entries.filter((e) => !isBrowserInternalUrl(e.url)),
      truncated: json.truncated === true,
    };
  };

  /** 读网络缓冲（最近 `NETWORK_LIMIT` 条）；语义与 readConsole 相同。 */
  const readNetwork = async (
    signal?: AbortSignal,
  ): Promise<{ entries: BskNetworkEntry[]; truncated: boolean }> => {
    const out = await bsk(
      ["network", "--limit", String(NETWORK_LIMIT), "--json", ...quiet],
      signal,
    );
    const json = parseBskJson<BskNetworkJson>(out);
    if (!json || !Array.isArray(json.entries)) {
      throw new Error(t("bsk.network.unreadable"));
    }
    return {
      // 同上：扩展自己的请求会把「最近的请求」这段诊断淹掉（实测整段全是 chrome-extension://）。
      entries: json.entries.filter((e) => !isBrowserInternalUrl(e.url)),
      truncated: json.truncated === true,
    };
  };

  return {
    session,
    lastSnapshot: () => snapshotText,
    lastAssertSemantic: () => assertSemantic,
    lastAssert: () => assertOutcome,

    async navigate(url: string, signal?: AbortSignal): Promise<string> {
      markStale();
      try {
        const out = await bsk(
          ["navigate", url, ...quiet, "--wait-until", "domcontentloaded"],
          signal,
        );
        return `已导航到 ${url}\n${out}`;
      } catch (err) {
        // 被中止不是「页面打不开」，别拿诊断层去解释它。
        if (err instanceof BskAbortError) throw err;
        const diagnosis = diagnoseNavigateFailure(url, readErrorText(err));
        // 翻译不了就原样抛出：诊断层的价值来自「说得准」，硬套分类比不解释更糟。
        if (!diagnosis) throw err;
        debugLog("[bsk] navigate 失败已翻译为可读原因：" + diagnosis);
        throw new Error(diagnosis);
      }
    },

    async snapshot(
      signal?: AbortSignal,
      options?: { fresh?: boolean },
    ): Promise<string> {
      // 强制取新：轮询场景专用（理由见 BskOps.snapshot 的说明）
      if (options?.fresh) return await takeSnapshot(signal);
      return await ensureSnapshot(SNAPSHOT_DEDUP_MS, "snapshot", signal);
    },

    async click(target: string, signal?: AbortSignal): Promise<string> {
      const landed = checkRef("click", target);
      markStale();
      const out = await bsk(["click", target, ...quiet], signal);
      return `已点击 ${target}${landed}\n${out}`;
    },

    async fill(
      target: string,
      value: string,
      signal?: AbortSignal,
    ): Promise<string> {
      const landed = checkRef("fill", target);
      markStale();
      const out = await bsk(["fill", target, "--value", value, ...quiet], signal);
      return `已在 ${target} 填入文本${landed}\n${out}`;
    },

    async upload(
      target: string | undefined,
      file: string,
      signal?: AbortSignal,
    ): Promise<string> {
      if (!existsSync(file)) {
        throw new Error(t("bsk.err.uploadMissing", { file }));
      }
      const landed = target ? checkRef("upload", target) : "";
      markStale();
      const args = ["upload"];
      if (target) args.push(target);
      args.push("--file", file, ...quiet);
      const out = await bsk(args, signal);
      return `已上传文件 ${file}${landed}\n${out}`;
    },

    async download(
      target: string,
      out: string | undefined,
      expectName: string | undefined,
      timeoutMs: number,
      signal?: AbortSignal,
    ): Promise<string> {
      // 引用闸门只在入口判一次：重试沿用同一个引用，是「同一次操作的第二次尝试」
      // （见 DOWNLOAD_ATTEMPTS），不是「页面已变还接着用旧编号」——重试前再判必然失败，
      // 会把这条兜底时序抖动的重试彻底废掉。
      const landing = checkRef("download", target);
      if (landing) debugLog("[bsk] download 落点：" + landing);
      markStale();
      const now = new Date();
      const explicit = out?.trim() ? out.trim() : undefined;
      // 没给路径就先落到临时名：服务器建议的文件名要等捕获完成才知道（见 downloads.ts）。
      const staging = explicit ? null : downloadStagingPath(now);
      const dest = staging ?? downloadDestination({ explicit, now });
      ensureDownloadDirFor(dest);
      const expectation = downloadExpectation(expectName);
      /** 把结论写成一条**不成立的断言**（而不是抛错），并返回与报告同一句话给模型。 */
      const fail = (evidence: string): string => {
        assertOutcome = { expectation, pass: false, evidence };
        return `断言「${expectation}」：不成立。${evidence}`;
      };

      // 点一次 + 等一次下载，抽成可重试的一步。
      const captureOnce = (): Promise<string> =>
        bsk(
          [
            "download",
            target,
            "--out",
            dest,
            "--json",
            ...quiet,
            "--timeout",
            `${timeoutMs}ms`,
            // 显式路径允许覆盖：用例点名了「就写到这个文件」，第二次运行因文件已存在而失败
            // 会被读成「下载坏了」；默认路径带时间戳，本就不会撞名。
            ...(explicit ? ["--overwrite"] : []),
          ],
          signal,
          // 给 bsk 自己留出报超时的余量：让我们的 execFile 先超时的话，拿到的是一条通用的
          //「命令执行超时」，而不是 bsk 对「没等到下载」的结构化说明。
          timeoutMs + 5_000,
        );

      let raw: string | null = null;
      let attempts = 0;
      let lastFailure: unknown = null;
      for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
        attempts = attempt;
        try {
          raw = await captureOnce();
          break;
        } catch (err) {
          if (err instanceof BskAbortError) throw err;
          if (bskErrorEnvelope(err)?.code === "not_found") {
            // 元素/资源层面的问题（选择器写错、`@eN` 失效、session 掉了）：这一步**根本没走成**，
            // 不等于「下载没发生」。抛成工具错误让模型重新 snapshot 后重试——记一条不成立的断言
            // 会把模型的一次笔误变成假的用例失败（普通动作遇到同样问题也是抛错重试）。
            // 回放路径里元素找不到在 resolveStepTarget 那层就被拦住并显式判 FAIL（见 replay.ts）。
            throw new Error(
              t("bsk.download.triggerError", { detail: bskErrorDetail(err) }),
            );
          }
          lastFailure = err;
          // 「没等到下载」在工具内自己重试一次：实测「页面刚加载完就点」这类时序问题会让
          // 第一次点击白点（紧接着重试就成功），而按设计「没捕获到」是一条**不成立的断言**
          // ——不重试的话，这类抖动会留下一条 FAIL，模型后面再试成功也洗不掉（假失败）。
          if (attempt < DOWNLOAD_ATTEMPTS) {
            info(
              t("bsk.download.retrying", {
                seconds: Math.round(timeoutMs / 1000),
                detail: bskErrorDetail(err),
              }),
            );
          }
        }
      }
      if (raw === null) {
        const detail = bskErrorDetail(lastFailure);
        debugLog("[bsk] download 未捕获到下载：" + detail);
        // bsk 认得出来的那一类要翻译成人话（与 navigate-diagnosis 同一条原则：只翻译不猜测）。
        // `download_capture_failed` 实测是「daemon/浏览器刚重启或刚升级，下载捕获还没就绪」：
        // 只报「点了没产生下载」会让人去查页面，而真正该做的是重连扩展/稍后再试。
        const notReady =
          bskErrorEnvelope(lastFailure)?.data?.reason === "download_capture_failed"
            ? t("bsk.download.captureNotReady")
            : "";
        return fail(
          t("bsk.download.notCaptured", {
            seconds: Math.round(timeoutMs / 1000) * attempts,
            detail,
          }) + notReady,
        );
      }

      const meta = parseBskJson<BskDownloadJson>(raw);
      const suggested = meta?.suggested_filename?.trim() || null;
      let landed =
        explicit ??
        uniquePath(downloadDestination({ suggestedName: suggested ?? undefined, now }));
      if (staging) {
        try {
          renameSync(staging, landed);
        } catch (err) {
          // 改名失败（被占用/杀软扫描）：留着临时名也比丢掉这次捕获强，证据里会带真实路径。
          debugLog(
            "[bsk] download 改名失败，保留临时名：" +
              (err instanceof Error ? err.message : String(err)),
          );
          landed = staging;
        }
      }

      const bytes = fileSizeOrNull(landed);
      if (bytes === null) {
        return fail(t("bsk.download.notWritten", { path: landed }));
      }
      if (bytes <= 0) {
        // 0 字节的文件确实躺在那儿，照样算一条「下载产物」，摘要里报出来（否则它就是个
        // 无人交代的残留文件）。
        recordDownloaded(landed);
        return fail(t("bsk.download.empty", { path: landed }));
      }

      // 文件名期望同时比对「落盘名」与「服务器建议名」：用例写包含式通配（如 `*报表*`）
      // 两者都匹配，而写死完整名（如 `导出报表.xls`）时落盘名多了时间戳前缀，只有建议名能对上。
      const candidates = [basename(landed), suggested].filter(
        (n): n is string => Boolean(n),
      );
      if (expectName && !candidates.some((n) => matchFileName(expectName, n))) {
        // 名字不符 → 文件**留下**：失败时它正是排查对象（是不是导出了别的报表？）。
        recordDownloaded(landed);
        return fail(
          t("bsk.download.nameMismatch", {
            pattern: expectName,
            name: suggested ?? basename(landed),
            path: landed,
          }),
        );
      }

      const mime = meta?.mime?.trim() || null;
      const danger = meta?.danger?.trim() || null;
      const extras = [
        mime ? t("bsk.download.evidenceMime", { mime }) : null,
        // `safe` 是绝大多数情况，逐条报出来只是噪声；非 safe 才值得占用证据的位置。
        danger && danger.toLowerCase() !== "safe"
          ? t("bsk.download.evidenceDanger", { level: danger })
          : null,
      ]
        .filter((x): x is string => Boolean(x))
        .join("，");

      // 断言成立 → 按规则决定留不留：显式 out / 关掉开关 = 留，默认路径 = 登记待清理。
      // 待清理的文件由**场景收尾**统一删（见 downloads.ts 的 flushDownloadCleanup）：
      // 捕获后立刻删会让同一场景里后面任何一步都拿不到这个文件。证据只说明"会清理"，
      // 真正"已清理"由收尾清单如实标注（删失败了就不标）。
      const scheduled =
        downloadRetention({
          explicit: Boolean(explicit),
          cleanupEnabled: readDownloadCleanup(),
        }) === "clean";
      recordDownloaded(landed, { cleanupPending: scheduled });

      const notes = [
        attempts > 1 ? t("bsk.download.retried") : "",
        scheduled ? t("bsk.download.cleanupScheduled") : "",
      ].join("");
      const evidence =
        t("bsk.download.captured", {
          path: landed,
          bytes,
          extra: extras ? `，${extras}` : "",
        }) + notes;
      assertOutcome = { expectation, pass: true, evidence };
      return `断言「${expectation}」：成立。${evidence}`;
    },

    async hover(target: string, signal?: AbortSignal): Promise<string> {
      const landed = checkRef("hover", target);
      markStale();
      const out = await bsk(["hover", target, ...quiet], signal);
      return `已悬停 ${target}${landed}\n${out}`;
    },

    async scroll(target: string, signal?: AbortSignal): Promise<string> {
      // scroll-to 同时支持 @eN 引用与 CSS 选择器。
      // （早期实现用 evaluate + querySelector，遇到 @eN 会静默返回 element-not-found。）
      const landed = checkRef("scroll", target);
      markStale();
      const out = await bsk(["scroll-to", target, ...quiet], signal);
      return `已滚动到 ${target}${landed}\n${out}`;
    },

    async press(
      key: string,
      options?: { target?: string; modifiers?: string; holdMs?: number },
      signal?: AbortSignal,
    ): Promise<string> {
      const target = options?.target?.trim();
      // 引用闸门与其它动作同一条规则：拿旧编号聚焦会聚焦到别的元素，随后这一键就按给了它。
      const landed = target ? checkRef("press", target) : "";
      markStale();
      const args = ["press", key];
      // press 的位置参数是**键名**，元素目标只能走 --ref / --selector（先聚焦再按键）。
      if (target) args.push(looksLikeRef(target) ? "--ref" : "--selector", target);
      const modifiers = options?.modifiers?.trim();
      if (modifiers) args.push("--modifiers", modifiers);
      if (typeof options?.holdMs === "number" && options.holdMs > 0) {
        args.push("--hold-ms", String(Math.round(options.holdMs)));
      }
      args.push(...quiet);
      const out = await bsk(args, signal);
      const what = target ? `${key}（先聚焦 ${target}）` : key;
      return `已按键 ${what}${landed}\n${out}`;
    },

    async screenshot(
      options?: { fullPage?: boolean; target?: string; out?: string },
      signal?: AbortSignal,
    ): Promise<string> {
      const fullPage = options?.fullPage === true;
      const target = options?.target?.trim();
      // 协议侧这两种模式互斥（bsk 的 clap 也是 conflicts_with）：同时给只会拿到一条难懂的下层报错。
      if (fullPage && target) throw new Error(t("bsk.screenshot.bothModes"));
      // 元素截图在协议侧**只认 ref**（bsk 的 screenshot 没有 --selector）：是 CSS 选择器就
      // 当场说清楚，硬试一次只会白跑一轮。
      if (target && !looksLikeRef(target)) {
        throw new Error(t("bsk.screenshot.refOnly", { target }));
      }
      const landed = target ? checkRef("screenshot", target) : "";
      const label = fullPage ? "full-page" : target ? "element" : "viewport";
      const dest = screenshotPath(new Date(), label, options?.out);
      ensureScreenshotDirFor(dest);
      const args = ["screenshot", "--out", dest, "--json", ...quiet];
      if (fullPage) args.push("--full-page");
      else if (target) args.push("--ref", target);
      const out = await bsk(args, signal);
      const meta = parseBskJson<BskScreenshotJson>(out);
      // `capture_unavailable` = bsk 明确说「这次没截成」（页面隐藏、Canvas 读不到等）。
      // 那意味着**没有证据**，不能给出一条看起来成功的回显——报告里会因此少一张图却无人知道。
      const unavailable = meta?.capture_unavailable?.trim();
      if (unavailable) {
        throw new Error(t("bsk.screenshot.unavailable", { reason: unavailable }));
      }
      const path = meta?.path?.trim() || dest;
      const size =
        typeof meta?.width === "number" && typeof meta?.height === "number"
          ? `${meta.width}x${meta.height}`
          : "";
      const bytes =
        typeof meta?.byte_size === "number" ? meta.byte_size : fileSizeOrNull(path);
      recordScreenshot(path);
      return (
        `已截图（${label}）：${path}` +
        (size ? `，${size}` : "") +
        (typeof bytes === "number" && bytes > 0 ? `，${bytes} 字节` : "") +
        landed
      );
    },

    async wheel(
      options?: { target?: string; deltaX?: number; deltaY?: number; modifiers?: string },
      signal?: AbortSignal,
    ): Promise<string> {
      const target = options?.target?.trim();
      const deltaX =
        typeof options?.deltaX === "number" && Number.isFinite(options.deltaX)
          ? options.deltaX
          : 0;
      const deltaY =
        typeof options?.deltaY === "number" && Number.isFinite(options.deltaY)
          ? options.deltaY
          : 0;
      // 两个增量都是 0 的滚轮事件没有意义（bsk 也拒绝）：在本地拦下，省一次浏览器往返。
      if (deltaX === 0 && deltaY === 0) throw new Error(t("bsk.wheel.needDelta"));
      const landed = target ? checkRef("wheel", target) : "";
      markStale();
      const args = ["wheel", "--delta-x", String(deltaX), "--delta-y", String(deltaY)];
      if (target) args.push(target);
      const modifiers = options?.modifiers?.trim();
      if (modifiers) args.push("--modifiers", modifiers);
      args.push(...quiet);
      const out = await bsk(args, signal);
      return `已滚动（delta ${deltaX}, ${deltaY}）${landed}\n${out}`;
    },

    async focus(target: string, signal?: AbortSignal): Promise<string> {
      const landed = checkRef("focus", target);
      markStale();
      const out = await bsk(["focus", target, ...quiet], signal);
      return `已聚焦 ${target}${landed}\n${out}`;
    },

    async blur(target: string, signal?: AbortSignal): Promise<string> {
      const landed = checkRef("blur", target);
      markStale();
      const out = await bsk(["blur", target, ...quiet], signal);
      return `已失焦 ${target}${landed}\n${out}`;
    },

    async getHtml(
      options?: { target?: string; maxBytes?: number; out?: string },
      signal?: AbortSignal,
    ): Promise<string> {
      const target = options?.target?.trim();
      // 协议侧只认 `@eN` 引用（没有 selector 入口）：给 CSS 就当场说清楚，别让模型以为
      // 「传了选择器就等于取到了那块 DOM」。
      if (target && !looksLikeRef(target)) {
        throw new Error(t("bsk.getHtml.refOnly", { target }));
      }
      const landed = target ? checkRef("getHtml", target) : "";
      const outPath = options?.out?.trim();
      const args = ["get-html", "--json", ...quiet];
      if (target) args.push("--ref", target);
      if (outPath) {
        // 落盘时不设预算：bsk 自己有 512KiB 的默认上限，而这条路径本来就是为了
        // 「别把 HTML 灌进模型上下文」——再压一次预算只会让人拿到半截文件。
        args.push("--out", outPath);
      } else {
        args.push("--max-bytes", String(clampHtmlBudget(options?.maxBytes)));
      }
      const raw = await bsk(args, signal);
      const meta = parseBskJson<BskGetHtmlJson>(raw);
      if (!meta || typeof meta.html !== "string") {
        throw new Error(t("bsk.getHtml.unreadable"));
      }
      const bytes = typeof meta.byte_size === "number" ? meta.byte_size : meta.html.length;
      const summary =
        `tab=${meta.tab_id ?? "?"} bytes=${bytes}` +
        (meta.truncated === true ? " truncated=true" : "");
      if (outPath) return `已保存页面 HTML：${outPath}（${summary}）${landed}`;
      const note = meta.truncated === true ? t("bsk.getHtml.truncated", { bytes }) : "";
      return `${summary}${landed}\n${meta.html}${note}`;
    },

    wait: doWait,

    settle: doSettle,

    waitFor: doWaitFor,

    async selectOption(
      target: string,
      option: string,
      signal?: AbortSignal,
    ): Promise<string> {
      // 引用闸门与普通动作同一条规则：拿旧编号点开控件会点到别的地方去。
      const landed = checkRef("select_option", target);
      markStale();
      // 上一次的标记若还在，这次的 `bsk click [data-pageqa-pick]` 就会点到那个元素。
      await clearMarks(signal);

      // 先问「target **自己**打开了吗」——按它声明的关联判断，而不是「页面上有没有可见浮层」。
      // 后者会把上一个还没收起来的浮层误认成本次的：于是既不点开 target，又在那个浮层里
      // 找选项，读到的自然是隔壁下拉的选项。
      let overlay: OverlayProbe | null = await probeOwnOverlay(target, signal);
      if (!overlay?.hit) {
        await bsk(["click", target, ...quiet], signal);
        overlay = await waitOwnOverlay(target, signal);
      }
      // 组件库没有 `aria-controls`（或结构不同）时回退到「任意可见浮层」：通用组件也能用，
      // 代价是页面上同时有多个同类浮层时可能读错——那种情况会以「没有这个选项，当前可选项：
      // …」的形式暴露出来，足以判断该换个用法。
      if (!overlay?.hit) overlay = await probeOverlay(signal);
      if (!overlay?.hit) throw new Error(t("bsk.picker.noOverlay", { target }));

      // 根必须用**探针标记的那个**浮层，而不是探针回报的选择器字符串：后者能定位到的
      // 只是 DOM 里第一个同类浮层——页面上有几个下拉时，那多半属于别人，于是读到隔壁的
      // 选项（报告里那条「点开消息类型，却报出机器人、WEBHOOK」就是这么来的）。
      const mark = parseOptionMark(
        await evalExpr(buildOptionMarkExpression(ROOT_SELECTOR, option), signal),
      );
      if (!mark?.found) {
        // 如实回报「现在能选什么」：让模型一次就能改对，而不是再花一轮去 snapshot 找选项。
        const list =
          mark && mark.candidates.length > 0 ? mark.candidates.join("、") : "";
        throw new Error(
          t("bsk.picker.optionMissing", { option }) +
            (list ? t("bsk.picker.optionCandidates", { list }) : ""),
        );
      }

      const out = await bsk(["click", PICK_SELECTOR, ...quiet], signal);
      await clearMarks(signal);
      markStale();
      // 等它收起来再交还控制权：浮层还盖在下面的控件上，不等就去点下一个会点在它身上。
      await waitOverlayGone(signal);
      return `已选择「${mark.text}」${landed}\n${out}`;
    },

    async pickDate(
      target: string,
      spec: string,
      endSpec?: string,
      signal?: AbortSignal,
    ): Promise<string> {
      const start = parseDateSpec(spec);
      // 解析不出来就说清楚，绝不退回到「今天」猜一个——那会把用例的错写成测试通过。
      if (!start) throw new Error(t("bsk.picker.badDate", { spec }));
      const end = endSpec === undefined ? null : parseDateSpec(endSpec);
      if (endSpec !== undefined && !end) {
        throw new Error(t("bsk.picker.badDate", { spec: endSpec }));
      }
      // 结束早于开始是写反了，不是页面问题：当场说清楚，别让它退化成「结束日点不到」。
      if (end && monthDelta(start, end) < 0) {
        throw new Error(
          t("bsk.picker.rangeOrder", {
            start: fmtDate(start),
            end: fmtDate(end),
          }),
        );
      }

      const landed = checkRef("pick_date", target);
      markStale();
      await clearMarks(signal);

      // 「已经打开了吗」按 target 自己声明的关联判断：面板类名随版本/类型变化，而
      // `aria-controls` 是元素自己声明的，更靠得住；上一个面板还在关闭动画里时也不会被
      // 误认成本次的（那会导致不点击、又在别人的面板里点日子）。
      let panel = (await probeOwnOverlay(target, signal))?.hit
        ? await probeDatePanel(signal)
        : null;
      if (!panel?.hit) {
        await bsk(["click", target, ...quiet], signal);
        panel = await waitDatePanel(signal);
      }
      // 没有 `aria-controls` 的组件库：退回「有没有可见面板」，与改造前行为一致。
      if (!panel?.hit) panel = await probeDatePanel(signal);
      if (!panel?.hit) throw new Error(t("bsk.picker.noPanel", { target }));
      // 日期单元格的根同样用**探针标记的那个面板**：页面上有多个日期选择器时，
      // 选择器字符串只能定位到 DOM 里第一个（往往是别的控件的面板），
      // 会从别人的面板里读到同名日子并按它点击。
      const container = ROOT_SELECTOR;

      const isRange = panel.isRange === true;
      if (isRange && !end) {
        // 范围面板只选一端就点「确定」，会在页面上留下一个半截范围，而工具还会报成功
        // —— 那比报错糟得多。宁可在这里停下，让模型知道「这是范围，得给两个日期」。
        throw new Error(t("bsk.picker.rangeNeedsEnd", { target }));
      }
      if (!isRange && end) {
        // 反过来：单日期面板却给了两个日期，说明模型认错了控件。
        throw new Error(t("bsk.picker.notRange", { target }));
      }

      if (!end) {
        // ── 单日期：导航到目标月 → 点中那一天 →（有确定则点它）──
        const state = await navigateToMonth(start, false, signal);
        if (!state) throw new Error(t("bsk.picker.noPanel", { target }));
        if (!(await clickDateDay(container, start, state, signal))) {
          throw new Error(t("bsk.picker.dayMissing", { date: fmtDate(start) }));
        }
        const confirmed = (await confirmDatePanel(signal))
          ? t("bsk.picker.confirmed")
          : "";
        markStale();
        // 面板收起前一直盖在下面的控件上：不等它消失，下一次点击会落在它身上。
        await waitOverlayGone(signal);
        return `已选择日期 ${fmtDate(start)}${confirmed}${landed}`;
      }

      // ── 范围：选开始 → 选结束 → 确定 ──
      // 点完开始，面板进入「选结束」状态（窗口通常不动），所以两端各自导航一次。
      let state = await navigateToMonth(start, true, signal);
      if (!state) throw new Error(t("bsk.picker.noPanel", { target }));
      if (!(await clickDateDay(container, start, state, signal))) {
        throw new Error(t("bsk.picker.dayMissing", { date: fmtDate(start) }));
      }
      state = await navigateToMonth(end, true, signal);
      if (!state) throw new Error(t("bsk.picker.noPanel", { target }));
      if (!(await clickDateDay(container, end, state, signal))) {
        throw new Error(t("bsk.picker.dayMissing", { date: fmtDate(end) }));
      }
      const confirmed = (await confirmDatePanel(signal))
        ? t("bsk.picker.confirmed")
        : "";
      markStale();
      await waitOverlayGone(signal);
      return `已选择日期范围 ${fmtDate(start)} 至 ${fmtDate(end)}${confirmed}${landed}`;
    },

    async assertText(
      expectation: string,
      opts: AssertTextOptions = {},
      signal?: AbortSignal,
    ): Promise<string> {
      const absent = opts.absent === true;
      // 断言要的是「当下」+「完整」：只有在期间没有任何改页面动作、且间隔很短时才复用，
      // 并且字面匹配基于瘦身前的完整快照（ensureRawSnapshot 里有原因说明）。
      const snap = await ensureRawSnapshot(
        SNAPSHOT_ASSERT_MS,
        "assert_text",
        signal,
      );
      // 本次断言是否「靠语义判断才成立」，每次调用先重置：
      // 只有字面未命中、由 Jev 复核判定成立的断言才为 true。
      assertSemantic = false;
      // 展示形式：反向断言必须带上「页面不包含」，否则报告里那条
      // 「[PASS] THIS_TEXT_…」会被读成一条正向断言——事实正好相反。
      const label = absent ? `页面不包含「${expectation}」` : expectation;
      const subject = absent ? label : `「${expectation}」`;
      // 结论与证据一起写进 assertOutcome，供报告直接取用（不依赖模型自述措辞）。
      const verdict = (pass: boolean, why: string): string => {
        assertOutcome = { expectation: label, pass, evidence: why };
        return `断言${subject}：${pass ? "成立" : "不成立"}。${why}`;
      };

      // 字面判定：三条规则（快照过短一律不成立、反向断言只看字面、字面命中不做语义复核）
      // 都在 literalAssertion 里，有单测钉住。返回 null = 正向断言、字面未命中。
      const literal = literalAssertion(snap, expectation, absent);
      if (literal) return verdict(literal.pass, literal.evidence);

      // 字面未命中才请 Jev 复核：这正是语义判断有价值的场景
      //    （同义词/近义表达/格式差异导致的误报 FAIL）。
      if (jevClient?.enabled) {
        try {
          const prob = await jevClient.assertText(snap, expectation);
          const pass = prob >= jevClient.threshold;
          // 靠语义复核才成立的断言，回放时字符串匹配必然不成立，需要标记
          assertSemantic = pass;
          const pct = (prob * 100).toFixed(1);
          const threshold = (jevClient.threshold * 100).toFixed(0);
          return verdict(
            pass,
            `字面未命中，语义匹配度 ${pct}%，${pass ? "超过" : "未达到"}阈值 ${threshold}%`,
          );
        } catch (err) {
          // Jev 调用失败：回退到原有的字符串包含逻辑。
          // 必须记录失败原因（超时/鉴权/网络等），否则用户只看到「Jev 不可用，已回退」，
          // 却无法从 --debug 日志判断到底是哪一类故障。
          debugLog(
            "[bsk] Jev 断言失败，回退到字符串匹配：" +
              (err instanceof Error ? err.message : String(err)),
          );
          return verdict(false, `页面中未找到「${expectation}」（Jev 不可用，已回退）`);
        }
      }

      // 默认：字符串包含匹配
      return verdict(false, `页面中未找到「${expectation}」`);
    },

    async assertNoConsoleError(
      options?: { ignore?: string[]; warnings?: boolean },
      signal?: AbortSignal,
    ): Promise<string> {
      const { entries, truncated } = await readConsole(signal);
      const withWarnings = options?.warnings === true;
      const ignores = (options?.ignore ?? [])
        .map((s) => String(s).trim().toLowerCase())
        .filter((s) => s.length > 0);
      const scope = t(
        withWarnings ? "bsk.console.scopeWarnings" : "bsk.console.scopeErrors",
      );
      const expectation = t("bsk.console.expectation", { scope });
      // 缓冲真满了才有必要说这句：不说明的话，「没发现报错」会被读成「整场都没有报错」。
      const note = truncated ? t("bsk.console.truncated") : "";

      const offenders = entries.filter((entry) => {
        if (!isConsoleOffender(entry, withWarnings)) return false;
        // 已知噪音按子串放行：正文与出处 URL 一起看，否则「同一条消息换了 URL」就会漏放。
        const haystack = `${entry.text ?? ""} ${entry.url ?? ""}`.toLowerCase();
        return !ignores.some((needle) => haystack.includes(needle));
      });

      if (offenders.length === 0) {
        const evidence = t("bsk.console.clean", {
          count: entries.length,
          scope,
          note,
        });
        assertOutcome = { expectation, pass: true, evidence };
        return `断言「${expectation}」：成立。${evidence}`;
      }

      const sample = offenders
        .slice(0, 3)
        // 带上出处 URL：这次真机跑的第一版证据只给了 level/kind/text，看不出那条
        // 「Failed to load resource」到底是谁的，只能再跑一次去猜。
        .map(
          (e) =>
            `[${e.level ?? "?"}/${e.kind ?? "?"}] ${clipLine(e.text ?? "", 140)}` +
            (e.url ? ` @ ${clipLine(e.url, 100)}` : ""),
        )
        .join("；");
      const evidence = t("bsk.console.dirty", {
        count: offenders.length,
        scope,
        sample,
        note,
      });
      assertOutcome = { expectation, pass: false, evidence };
      return `断言「${expectation}」：不成立。${evidence}`;
    },

    async assertNetwork(
      url: string,
      options?: { status?: string; method?: string },
      signal?: AbortSignal,
    ): Promise<string> {
      const needle = url.trim();
      if (!needle) throw new Error(t("bsk.network.urlRequired"));
      const rawStatus = (options?.status ?? "").trim();
      const statusSpec = rawStatus ? parseStatusSpec(rawStatus) : null;
      // 状态码写错是**用法错误**，当场说清楚：硬按「有请求就行」跑下去，
      // 等于把一条本该严格的断言悄悄放宽，而报告里看不出这回事。
      if (rawStatus && !statusSpec) {
        throw new Error(t("bsk.network.badStatus", { spec: rawStatus }));
      }
      const method = (options?.method ?? "").trim().toUpperCase();

      const { entries, truncated } = await readNetwork(signal);
      const note = truncated ? t("bsk.network.truncated") : "";
      const wanted = needle.toLowerCase();
      /**
       * 只看 URL 的命中。必须单独留着它，才能把「地址片段写错了」和
       * 「地址没错、只是方法对不上」分开报：后者的正确改法是动 method，
       * 而两者原先都落进「没有匹配「url」的请求」——人去改那个本来没错的地址，
       * 白跑一轮（实测就这么被误导过）。
       */
      const urlMatched = entries.filter((entry) =>
        (entry.url ?? "").toLowerCase().includes(wanted),
      );
      const matched = urlMatched.filter(
        (entry) => !method || (entry.method ?? "").toUpperCase() === method,
      );

      // 方法也是匹配条件，因此必须出现在**期望**里：报告里那句断言原文若只有
      // 「请求 /x 返回 200」，没人看得出还有一条方法约束（methodMismatch 是同一件事的显式报法）。
      const methodSuffix = method ? t("bsk.network.methodSuffix", { method }) : "";
      const methodNote = method ? t("bsk.network.methodNote", { method }) : "";

      const expectation = statusSpec
        ? t("bsk.network.expectationStatus", {
            url: needle,
            status: describeStatusSpec(statusSpec),
            method: methodSuffix,
          })
        : t("bsk.network.expectationAny", { url: needle, method: methodSuffix });
      const verdict = (pass: boolean, why: string): string => {
        assertOutcome = { expectation, pass, evidence: why };
        return `断言「${expectation}」：${pass ? "成立" : "不成立"}。${why}`;
      };
      /** 一条记录 → 短描述（证据里逐条列出实际发生了什么）。 */
      const one = (e: BskNetworkEntry): string =>
        e.kind === "failure"
          ? `${e.method ?? "?"} 失败(${clipLine(e.error_text ?? "failed", 60)})`
          : `${e.method ?? "?"} ${e.status ?? "?"}`;

      if (matched.length === 0) {
        // URL 命中了、只是方法都不对：单独报，并给出实际出现过的方法。
        // 「把 method 改对」和「把 url 改对」是两条完全不同的修法，不能混成一句话。
        if (method && urlMatched.length > 0) {
          const actual = [
            ...new Set(urlMatched.map((e) => (e.method ?? "?").toUpperCase())),
          ].join("、");
          return verdict(
            false,
            t("bsk.network.methodMismatch", {
              url: needle,
              count: urlMatched.length,
              expected: method,
              actual,
              note,
            }),
          );
        }
        // 如实给出「最近到底请求过什么」：模型据此一轮就能改对 URL 片段，
        // 不必再花一轮去猜（与 picker 报「当前可选项」同一个动机）。
        const recent = entries
          .slice(-5)
          .map((e) => `${one(e)} ${clipLine(e.url ?? "(未知)", 80)}`)
          .join("；");
        return verdict(
          false,
          t("bsk.network.noMatch", {
            url: needle,
            count: entries.length,
            recent: recent || t("bsk.network.noTraffic"),
            note,
            method: methodNote,
          }),
        );
      }

      const responses = matched.filter((e) => e.kind === "response");
      if (statusSpec) {
        const hit = responses.filter((e) => statusMatches(e.status, statusSpec));
        if (hit.length > 0) {
          const last = hit[hit.length - 1];
          return verdict(
            true,
            t("bsk.network.hit", {
              url: needle,
              count: matched.length,
              latest: one(last),
              note,
            }),
          );
        }
        return verdict(
          false,
          t("bsk.network.miss", {
            url: needle,
            count: matched.length,
            actual: matched.map(one).join("、"),
            expected: describeStatusSpec(statusSpec),
            note,
            method: methodNote,
          }),
        );
      }

      if (responses.length > 0) {
        // 没给状态码时语义是「这个请求发生了（且没有失败）」：有一条成功响应即成立。
        const last = responses[responses.length - 1];
        return verdict(
          true,
          t("bsk.network.hit", {
            url: needle,
            count: matched.length,
            latest: one(last),
            note,
            method: methodNote,
          }),
        );
      }
      return verdict(
        false,
        t("bsk.network.miss", {
          url: needle,
          count: matched.length,
          actual: matched.map(one).join("、"),
          expected: t("bsk.network.expectedResponse"),
          note,
          method: methodNote,
        }),
      );
    },
  };
}

/** 工具层上报的一次执行（供录制回放脚本）。 */
export interface BskToolExec {
  /** 工具名。 */
  name: string;
  /** 模型给出的入参。 */
  params: Record<string, unknown>;
  /** bsk 是否成功（失败的尝试不会被录进回放脚本）。 */
  ok: boolean;
  /** 本次操作**之前**页面最后一次快照文本。 */
  lastSnapshot: string;
  /** 断言是否靠 Jev 语义判断才成立（仅 assert_text 会上报该字段）。 */
  semantic?: boolean;
  /** 断言的结构化结果（仅 assert_text 成功时上报）；报告据此判定，而非解析模型措辞。 */
  assert?: AssertOutcome;
}

export interface BskToolOptions {
  session: string;
  jevClient?: JevClient;
  /** 每次工具执行后的回调（录制回放脚本用）。 */
  onExec?: (event: BskToolExec) => void;
}

/** 构造一组浏览器操作工具，供 page-test agent 调用。 */
export function createBskTools(opts: BskToolOptions): AgentTool[] {
  const ops = createBskOps(opts.session, opts.jevClient);

  /**
   * 统一包装一次工具执行：拿到结果后上报给录制器，失败时先上报再抛出
   * （抛出让 pi-agent-core 把该工具标记为错误，模型会据此重试）。
   */
  /**
   * 动作之后附一份**可交互元素清单**（快照的 `refs` 档位）。
   *
   * 这是「点开一个浮层之后」最省时间的一步：通用路径是「click 点开 → snapshot 看新编号
   * → click 选项」，其中 snapshot 那一轮纯粹是为了拿编号，每次都是一轮 LLM 往返（几秒）。
   * 把清单直接附在动作结果里，这一轮就省掉了。
   *
   * 只给清单而不是整页快照：此刻模型需要的仅仅是「现在能点哪些东西、编号是多少」，
   * 而纯文本在 Element Plus 那种页面上能占掉九成体积。
   *
   * 取不到快照**不抛错**：动作本身已经成功了，附带的清单只是福利，不能让它把成功改写失败。
   */
  const refsAfterAction = async (
    signal?: AbortSignal,
    /**
     * 清单标题。默认是「动作后的可交互元素」；引用失效的报错里换成「重试用」的措辞——
     * 那次动作没成功，说「动作后」会让人以为它成功了。
     */
    header: string = t("bsk.refs.afterAction"),
  ): Promise<string> => {
    try {
      // `fresh`：动作刚改过页面，缓存的快照在这里必然是过期的。
      const fresh = await ops.snapshot(signal, { fresh: true });
      const slim = slimSnapshot(fresh, { mode: "refs" });
      return `\n\n【${header}】\n${slim.text}`;
    } catch (err) {
      if (err instanceof BskAbortError) throw err;
      return `\n\n${t("bsk.refs.failed", {
        msg: err instanceof Error ? err.message : String(err),
      })}`;
    }
  };

  const exec = async (
    name: string,
    params: Record<string, unknown>,
    fn: (signal?: AbortSignal) => Promise<string>,
    signal?: AbortSignal,
    options: { snapshotAfter?: boolean } = {},
  ) => {
    const before = ops.lastSnapshot();
    try {
      const text = await fn(signal);
      // 断言型工具的结论（成立与否 + 证据）都落在同一条结构化结果上：报告直接取用，
      // 不去解析工具返回文案的措辞（见 ASSERTION_TOOLS）。
      const assertion = ASSERTION_TOOLS.has(name) ? ops.lastAssert() : null;
      // 断言不成立是**确定性的失败信号**：当场截一张图——此刻页面正是「期望 vs 实际」的
      // 现场。放到场景收尾再截就晚了：后面的步骤可能已经把页面带走，而失败往往就发生在
      // 「点击 → 页面跳转 → 结果不对」这条链的中间。截图失败不影响结论（见该函数）。
      const shot =
        assertion && !assertion.pass
          ? await captureSessionScreenshot(opts.session, { label: "failure", signal })
          : null;
      opts.onExec?.({
        name,
        params,
        ok: true,
        lastSnapshot: before,
        // 逐条上报「这条断言是否靠语义判断才成立」：录制层据此精确标记，
        // 而不是按「整场是否启用 Jev」一刀切（字面命中的断言回放同样能通过）。
        ...(name === "assert_text"
          ? { semantic: ops.lastAssertSemantic() }
          : {}),
        // 结构化断言结果（期望值 + 成立与否 + 证据）：报告直接取用，
        // 不再从模型自述里反推（见 report.ts 的 buildReport）。
        ...(assertion ? { assert: assertion } : {}),
      });
      // 把截图路径告诉模型：它据此知道「现场已经留下来了」，不必再自己调一次 screenshot。
      const shotNote = shot ? t("bsk.screenshot.onFailure", { path: shot }) : "";
      return ok(
        options.snapshotAfter
          ? text + shotNote + (await refsAfterAction(signal))
          : text + shotNote,
      );
    } catch (err) {
      opts.onExec?.({ name, params, ok: false, lastSnapshot: before });
      // 引用失效是**可自愈**的：模型收到它之后必然要做「重新 snapshot 拿新编号」这件事。
      // 与其让它为此多花一轮 LLM 往返（实测 3 秒起），不如这里顺手把**当前页面**的可交互
      // 元素清单附在报错里——它直接拿新编号重试即可（这一抓也把快照刷新成新鲜的了）。
      // 注意顺序：清单取的是**动作之后**的页面，那才是接下来要操作的那一版。
      if (err instanceof RefStaleError) {
        throw new RefStaleError(
          err.message +
            (await refsAfterAction(
              signal,
              t("bsk.refs.forRetry", { action: name }),
            )),
        );
      }
      throw err;
    }
  };

  const navigate: AgentTool = {
    name: "navigate",
    label: "Navigate",
    description:
      "在浏览器标签页打开一个 URL（支持 http/https/about: 等）。导航完成后页面 DOM 就绪。",
    parameters: paramsOf({ url: { type: "string", description: "目标 URL" } }, [
      "url",
    ]),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const p = params as NavParams;
      return exec(
        "navigate",
        { url: p.url },
        (s) => ops.navigate(p.url, s),
        signal,
      );
    },
  };

  const snapshot: AgentTool = {
    name: "snapshot",
    label: "Snapshot",
    description:
      "读取当前页面的 aria 语义树与可见文本（标题、段落、链接、按钮等）。用于读取内容、标题、文本并定位元素。",
    parameters: paramsOf({}),
    execute: async (_id: string, _params: unknown, signal?: AbortSignal) =>
      exec("snapshot", {}, (s) => ops.snapshot(s), signal),
  };

  const click: AgentTool = {
    name: "click",
    label: "Click",
    description:
      "点击一个元素。可用快照里的 @eN 引用或 CSS 选择器。" +
      "展开下拉/菜单/弹窗、切换路由这类**会改变页面**的点击，请带上 showPage: true，一次拿到新编号。",
    parameters: paramsOf(
      {
        target: { type: "string", description: "@eN 引用或 CSS 选择器" },
        showPage: SHOW_PAGE_PARAM,
      },
      ["target"],
    ),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const p = params as TargetParams;
      return exec(
        "click",
        { target: p.target, ...(p.showPage ? { showPage: true } : {}) },
        (s) => ops.click(p.target, s),
        signal,
        { snapshotAfter: p.showPage === true },
      );
    },
  };

  const fill: AgentTool = {
    name: "fill",
    label: "Fill",
    description:
      "在输入框/文本域中填入文本（会先清空原有内容）。" +
      "**只能填真正的文本输入框**：下拉框（el-select）、日期选择器等控件的输入框是只读的，" +
      "填不进去——那两类请分别用 select_option / pick_date。" +
      "填完之后若需要看校验提示或新出现的元素，带上 showPage: true。",
    parameters: paramsOf(
      {
        target: { type: "string", description: "@eN 引用或 CSS 选择器" },
        value: { type: "string", description: "要输入的文本" },
        showPage: SHOW_PAGE_PARAM,
      },
      ["target", "value"],
    ),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const p = params as FillParams;
      return exec(
        "fill",
        { target: p.target, value: p.value, ...(p.showPage ? { showPage: true } : {}) },
        (s) => ops.fill(p.target, p.value, s),
        signal,
        { snapshotAfter: p.showPage === true },
      );
    },
  };

  const selectOption: AgentTool = {
    name: "select_option",
    label: "Select Option",
    description:
      "在下拉框 / 级联选择器里选一项：工具自己点开控件、等浮层出现、按**可见文本**匹配选项并点击。" +
      "**下拉框一律用它，不要用 fill**（el-select 这类控件的输入框是只读的，填不进去）；" +
      "也不要「先 click 展开、再 snapshot、再 click 选项」——那要花三到四轮，这个工具一轮就完成。" +
      "target 传下拉控件本身（@eN 或 CSS 选择器）；option 传页面上**印出来的选项文本**（如「已完成」「北京市」）。" +
      "找不到浮层或选项时会报错，并把当前可选的项列出来，那时再退回通用路径手动操作。" +
      "选完后结果里会附一份「动作后的可交互元素」清单（含新编号）：**直接用清单里的新编号接着操作**，" +
      "不要再单独 snapshot——选择类操作必然让旧编号失效。",
    parameters: paramsOf(
      {
        target: { type: "string", description: "下拉控件（@eN 引用或 CSS 选择器）" },
        option: { type: "string", description: "选项的可见文本（页面上印出来的字）" },
        showPage: SHOW_PAGE_PARAM_DEFAULT_ON,
      },
      ["target", "option"],
    ),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const p = params as SelectOptionParams;
      // 默认开（见 SHOW_PAGE_PARAM_DEFAULT_ON）：选择类操作必然改页面，旧编号随即失效。
      const showPage = resolveShowPage(p.showPage);
      return exec(
        "select_option",
        {
          target: p.target,
          option: p.option,
          ...(p.showPage === false ? { showPage: false } : {}),
        },
        (s) => ops.selectOption(p.target, p.option, s),
        signal,
        { snapshotAfter: showPage },
      );
    },
  };

  const pickDate: AgentTool = {
    name: "pick_date",
    label: "Pick Date",
    description:
      "在日期选择器里选一个日期：工具自己点开面板、翻到目标年月、点中那一天（面板有「确定」时一并点掉）。" +
      "**日期一律用它，不要一步步 click**：翻月份要点很多次，而每次点击之后旧编号都会失效、" +
      "又得重新 snapshot，一轮轮下来能把一次选日期拖成五六次调用。" +
      "target 传日期输入框（@eN 或 CSS 选择器；范围控件传它的**任一**输入框都可以，点哪个都会打开同一个面板）；" +
      "date 支持 2026-09-29、2026/9/29、2026年9月29日，" +
      "以及相对写法 today / 今天 / +3（三天后）/ -7（七天前）——**能写相对就写相对**：" +
      "写死绝对日期会让用例过几天就变成假失败。" +
      "**日期范围**（「发送时间 开始~结束」这类两个输入框的控件）：把结束日期传进 endDate，" +
      "工具会按「选开始 → 选结束 → 点确定」走；只传 date 而面板其实是范围类型时会直接报错，" +
      "不会留下一个半截的范围。" +
      "选完后结果里会附一份「动作后的可交互元素」清单（含新编号）：**直接用清单里的新编号接着操作**，" +
      "不要再单独 snapshot——选日期同样会让旧编号失效。",
    parameters: paramsOf(
      {
        target: { type: "string", description: "日期输入框（@eN 引用或 CSS 选择器）" },
        date: {
          type: "string",
          description: "目标日期：2026-09-29 / 2026/9/29 / 2026年9月29日 / today / 今天 / +3 / -7",
        },
        endDate: {
          type: "string",
          description: "仅日期范围控件需要：结束日期，写法同 date（必须不早于 date）",
        },
        showPage: SHOW_PAGE_PARAM_DEFAULT_ON,
      },
      ["target", "date"],
    ),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const p = params as PickDateParams;
      // 默认开（见 SHOW_PAGE_PARAM_DEFAULT_ON）：选日期会让旧编号整体失效。
      const showPage = resolveShowPage(p.showPage);
      return exec(
        "pick_date",
        {
          target: p.target,
          date: p.date,
          ...(p.endDate ? { endDate: p.endDate } : {}),
          ...(p.showPage === false ? { showPage: false } : {}),
        },
        (s) => ops.pickDate(p.target, p.date, p.endDate, s),
        signal,
        { snapshotAfter: showPage },
      );
    },
  };

  const upload: AgentTool = {
    name: "upload",
    label: "Upload",
    description:
      "上传本地文件到页面的文件输入框或上传区域（如 el-upload 的「Click to upload」按钮）。" +
      "target 传触发文件选择器的元素（@eN 或 CSS 选择器），也可直接传隐藏的 <input type=\"file\">；" +
      "不传 target 时 bsk 自动在页面中查找文件输入框。" +
      "注意：原生文件选择框无法被自动化点击，因此不要先 click 触发按钮再调用本工具，" +
      "直接调用 upload 并指定该按钮为 target 即可。",
    parameters: paramsOf(
      {
        target: {
          type: "string",
          description:
            "触发文件选择器的元素（@eN 引用或 CSS 选择器），或 file input 本身",
        },
        file: { type: "string", description: "待上传的本地文件绝对路径" },
      },
      ["file"],
    ),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const p = params as UploadParams;
      return exec(
        "upload",
        p.target ? { target: p.target, file: p.file } : { file: p.file },
        (s) => ops.upload(p.target, p.file, s),
        signal,
      );
    },
  };

  const download: AgentTool = {
    name: "download",
    label: "Download",
    description:
      "捕获一次浏览器下载并把它落到本地，用于校验「点击导出/下载按钮后文件确实下载下来了」。" +
      "target 传**触发下载的那个元素**（如导出按钮，或确认弹框里的「确定」按钮），@eN 引用或 CSS 选择器。" +
      "注意：点击触发的下载只能由本工具自己捕获，不要先 click 再调用本工具——那次下载会流走、没人接。" +
      "expectName 可选，传文件名通配（如 *.xlsx），不符合则断言不成立；" +
      "out 可选，传落盘路径（省略则写到配置的下载目录，文件名带时间戳）；" +
      "timeoutMs 可选，等待上限（默认 " + DEFAULT_DOWNLOAD_TIMEOUT_MS + " 毫秒）。" +
      "本工具直接产生一条断言：捕获到并落盘为「成立」，超时/落盘失败/文件名不符为「不成立」。",
    parameters: paramsOf(
      {
        target: {
          type: "string",
          description: "触发下载的元素（@eN 引用或 CSS 选择器）",
        },
        out: {
          type: "string",
          description:
            "可选的落盘路径；省略则写到下载目录（~/.pageqa/downloads，文件名带时间戳）",
        },
        expectName: {
          type: "string",
          description: "可选的文件名通配期望，如 *.xlsx（大小写不敏感）",
        },
        timeoutMs: {
          type: "number",
          description: `可选的等待上限（毫秒，默认 ${DEFAULT_DOWNLOAD_TIMEOUT_MS}）`,
        },
      },
      ["target"],
    ),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const p = params as DownloadParams;
      // 只把「用例真的写了」的等待上限传给操作层：省略时才能回落默认值，
      // 也让录制层不必为一个从没被指定过的数字背锅。
      const timeoutMs =
        typeof p.timeoutMs === "number" && p.timeoutMs > 0
          ? Math.round(p.timeoutMs)
          : DEFAULT_DOWNLOAD_TIMEOUT_MS;
      return exec(
        "download",
        {
          target: p.target,
          ...(p.out ? { out: p.out } : {}),
          ...(p.expectName ? { expectName: p.expectName } : {}),
          ...(p.timeoutMs ? { timeoutMs } : {}),
        },
        (s) => ops.download(p.target, p.out, p.expectName, timeoutMs, s),
        signal,
      );
    },
  };

  const hover: AgentTool = {
    name: "hover",
    label: "Hover",
    description:
      "悬停在一个元素上，用于触发悬停菜单/提示。" +
      "悬停型下拉（如 el-dropdown）展开后带上 showPage: true，一次拿到菜单项的新编号。",
    parameters: paramsOf(
      {
        target: { type: "string", description: "@eN 引用或 CSS 选择器" },
        showPage: SHOW_PAGE_PARAM,
      },
      ["target"],
    ),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const p = params as TargetParams;
      return exec(
        "hover",
        { target: p.target, ...(p.showPage ? { showPage: true } : {}) },
        (s) => ops.hover(p.target, s),
        signal,
        { snapshotAfter: p.showPage === true },
      );
    },
  };

  const scroll: AgentTool = {
    name: "scroll",
    label: "Scroll",
    description: "滚动到指定元素使其进入视口。",
    parameters: paramsOf(
      { target: { type: "string", description: "@eN 引用或 CSS 选择器" } },
      ["target"],
    ),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const p = params as TargetParams;
      return exec(
        "scroll",
        { target: p.target },
        (s) => ops.scroll(p.target, s),
        signal,
      );
    },
  };

  const press: AgentTool = {
    name: "press",
    label: "Press",
    description:
      "按一次键盘键（**真实按键**，走 CDP 键盘事件，不是合成事件）。" +
      "key 传键名：Enter / Escape / Tab / ArrowDown / Backspace / Home，或组合键 Ctrl+A / Ctrl+Enter / Shift+Tab。" +
      "**用它的时机**：输入框里回车触发搜索或提交、按 Escape 关掉弹窗/下拉/抽屉、" +
      "用 Tab 走焦点顺序验证失焦校验、先 fill 再 Ctrl+A 重填。" +
      "**不要**用 evaluate 注入 KeyboardEvent 来代替它：合成事件 isTrusted=false，" +
      "React/Vue 受控组件与快捷键处理多半不认，会得到「看起来按了、页面毫无反应」。" +
      "target 可选：传 @eN 或 CSS 选择器时**先聚焦到该元素再按键**（如聚焦输入框后按 Enter）；" +
      "不传就按在页面当前焦点上（通常是上一步 fill 过的输入框）。" +
      "modifiers 可选：逗号分隔的修饰键（如 \"Ctrl,Shift\"）；键名里已写出的组合键不必重复。" +
      "holdMs 可选：按下与松开之间保持的毫秒数，用于测试长按。" +
      "showPage: true 时在结果里附一份动作后的可交互元素清单。",
    parameters: paramsOf(
      {
        key: {
          type: "string",
          description:
            "键名，如 Enter / Escape / Tab / ArrowDown / Backspace，或组合键 Ctrl+A / Shift+Tab",
        },
        target: {
          type: "string",
          description: "可选：先聚焦的元素（@eN 引用或 CSS 选择器）；不传则按在当前焦点上",
        },
        modifiers: {
          type: "string",
          description: "可选的修饰键列表（逗号分隔）：Ctrl / Shift / Alt / Meta",
        },
        holdMs: { type: "number", description: "可选：按住多少毫秒再松开（测试长按）" },
        showPage: SHOW_PAGE_PARAM,
      },
      ["key"],
    ),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const p = params as PressParams;
      // 键名是这一步的全部内容：空的 key 没有意义，在本地拦下，别白费一次浏览器往返
      // （这次失败也不会被录进回放脚本——录制层只记成功的操作）。
      if (typeof p.key !== "string" || !p.key.trim()) {
        throw new Error(
          "press 需要给出 key（键名，如 Enter / Escape / Tab / Ctrl+A）",
        );
      }
      const options = {
        ...(p.target ? { target: p.target } : {}),
        ...(p.modifiers ? { modifiers: p.modifiers } : {}),
        ...(typeof p.holdMs === "number" ? { holdMs: p.holdMs } : {}),
      };
      return exec(
        "press",
        { key: p.key, ...options, ...(p.showPage ? { showPage: true } : {}) },
        (s) => ops.press(p.key, options, s),
        signal,
        { snapshotAfter: p.showPage === true },
      );
    },
  };

  const wheel: AgentTool = {
    name: "wheel",
    label: "Wheel",
    description:
      "派发一次**真实滚轮事件**（CDP 的 wheel 输入）。" +
      "**和 scroll 不是一回事，别混用**：`scroll` 是 `scroll-to`（把某个元素滚进视口、**不产生滚动事件**）；" +
      "页面的 scroll 监听、**无限加载的触底回调**、横向滚动容器只认这个 wheel。" +
      "deltaY：向下为正、向上为负（一次一屏大约 600–800）；deltaX 同理，向右为正；两个不能同时为 0。" +
      "target 可选：给了就滚那个元素所在的区域（@eN 或 CSS 选择器），不给就滚视口中心。" +
      "**注意它会真的滚动页面**：无限加载是异步的，滚完要断言就先用 wait_for 等目标内容出现，" +
      "别滚完立刻断言。",
    parameters: paramsOf({
      deltaY: {
        type: "number",
        description: "垂直增量（CSS 像素）：向下为正、向上为负；一次一屏约 600–800",
      },
      deltaX: { type: "number", description: "水平增量（CSS 像素）：向右为正" },
      target: {
        type: "string",
        description: "可选：滚动的落点元素（@eN 或 CSS 选择器）；不给则滚视口中心",
      },
      modifiers: {
        type: "string",
        description: "可选：逗号分隔的修饰键（Ctrl / Shift / Alt / Meta）",
      },
    }),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const p = (params as WheelParams) ?? {};
      const options = {
        ...(p.target ? { target: p.target } : {}),
        ...(typeof p.deltaY === "number" ? { deltaY: p.deltaY } : {}),
        ...(typeof p.deltaX === "number" ? { deltaX: p.deltaX } : {}),
        ...(p.modifiers ? { modifiers: p.modifiers } : {}),
      };
      return exec("wheel", { ...options }, (s) => ops.wheel(options, s), signal);
    },
  };

  const focus: AgentTool = {
    name: "focus",
    label: "Focus",
    description:
      "让某个元素获得焦点（不点击、不输入）。" +
      "**用它的时机**：验证 `:focus` 样式、把焦点挪到某个元素后再用 press 按键、" +
      "或者为紧接着的一次 blur 做准备。" +
      "注意多数情况下不必显式调它——`fill` 会自己聚焦到目标输入框。" +
      "target 必填（@eN 或 CSS 选择器）。",
    parameters: paramsOf(
      {
        target: { type: "string", description: "要聚焦的元素（@eN 或 CSS 选择器）" },
      },
      ["target"],
    ),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const target = requiredTarget(params, "focus");
      return exec("focus", { target }, (s) => ops.focus(target, s), signal);
    },
  };

  const blur: AgentTool = {
    name: "blur",
    label: "Blur",
    description:
      "让某个元素**失去焦点**。" +
      "**用它的时机**：大量表单校验挂在 blur 上——值填完了但错误提示不出来，" +
      "就是因为还没触发失焦；「填完 → 失焦 → 断言报错提示」是页面测试里的常规链路。" +
      "比「点一下别处」干净：不会顺带触发那个元素的点击副作用（用 blur 只改焦点）。" +
      "target 必填（@eN 或 CSS 选择器）。",
    parameters: paramsOf(
      {
        target: { type: "string", description: "要失焦的元素（@eN 或 CSS 选择器）" },
      },
      ["target"],
    ),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const target = requiredTarget(params, "blur");
      return exec("blur", { target }, (s) => ops.blur(target, s), signal);
    },
  };

  const getHtml: AgentTool = {
    name: "get_html",
    label: "Get HTML",
    description:
      "取页面的**原始 DOM HTML**（可选只取某个 @eN 子树）。" +
      "**它补的是 snapshot 的盲区**：快照是 aria 树 + 可见文本，看不到**属性**——" +
      "class / data-* / value / href / disabled / name 这些一个都拿不到，长文本还会被截断。" +
      "需要确认「这个类名在不在」「data-id 是多少」「原生 select 每个 option 的 value 是什么」时用它。" +
      "**别拿它当常规手段**：绝大多数断言用 assert_text 看可见文本就够了。" +
      "target 可选，**只支持 @eN 引用**（bsk 侧没有选择器入口）。" +
      "maxBytes 可选，默认 16384、上限 65536——HTML 是原样进上下文的，别贪大；" +
      "要看更大的范围就传 out 落盘（那时结果只回路径与字节数，不带 HTML 正文）。" +
      "结果第一行是 `tab=… bytes=… truncated=…`：truncated=true 说明你看到的不是全部，" +
      "据此说「页面里没有某某」之前先想清楚。",
    parameters: paramsOf({
      target: {
        type: "string",
        description: "可选：只取这个元素的子树（@eN 引用；**不支持 CSS 选择器**）",
      },
      maxBytes: {
        type: "number",
        description: "可选：最多返回多少字节 HTML（默认 16384，上限 65536）",
      },
      out: {
        type: "string",
        description:
          "可选：把 HTML 写到这个文件；结果只回路径与字节数，不受 maxBytes 限制",
      },
    }),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const p = (params as GetHtmlParams) ?? {};
      const options = {
        ...(p.target ? { target: p.target } : {}),
        ...(typeof p.maxBytes === "number" ? { maxBytes: p.maxBytes } : {}),
        ...(p.out ? { out: p.out } : {}),
      };
      return exec("get_html", { ...options }, (s) => ops.getHtml(options, s), signal);
    },
  };

  const screenshot: AgentTool = {
    name: "screenshot",
    label: "Screenshot",
    description:
      "给当前页面截一张图并落盘（**留证据**）：默认截视口，fullPage=true 截整页，" +
      "target 传 @eN 引用时只截那个元素。" +
      "**什么时候用**：页面出现异常、断言对不上、或想给报告留一张现场图时。" +
      "它产出的文件会**内联进 HTML 报告**，所以用例里的「截图留证」用这个工具，" +
      "不要用 evaluate 去碰 canvas。" +
      "注意两点：① 它是**只读**动作，不改变页面，也**不产生断言**（结论仍由 assert_* 决定）；" +
      "② 元素截图只支持 @eN 引用（bsk 的 screenshot 没有 CSS 选择器入口），传 CSS 选择器会被拒绝。" +
      "out 可选：显式指定落盘路径（默认写到 ~/.pageqa/screenshots）。",
    parameters: paramsOf({
      fullPage: {
        type: "boolean",
        description: "可选：true 时截整页（自动滚动拼接），默认只截当前视口",
      },
      target: {
        type: "string",
        description: "可选：只截这个元素（@eN 引用；**不能用 CSS 选择器**）",
      },
      out: {
        type: "string",
        description: "可选：显式落盘路径；默认写到 ~/.pageqa/screenshots 下带时间戳的 PNG",
      },
    }),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const p = (params as ScreenshotParams) ?? {};
      const options = {
        ...(p.fullPage === true ? { fullPage: true } : {}),
        ...(p.target ? { target: p.target } : {}),
        ...(p.out ? { out: p.out } : {}),
      };
      return exec(
        "screenshot",
        { ...options },
        (s) => ops.screenshot(options, s),
        signal,
      );
    },
  };

  const wait: AgentTool = {
    name: "wait",
    label: "Wait",
    description:
      "固定等待一段时间（毫秒）。**页面内的等待一律用 wait_for**：只有当要等的事情发生在页面之外" +
      "（服务端正在生成导出文件、后台排队）且用例明确要求等待时才用它——写死的秒数会被回放脚本当成" +
      "事实照付，而「给页面一点时间」这种猜测几乎总是错的那一个。",
    parameters: paramsOf({ ms: { type: "number", description: "等待毫秒数" } }),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const p = (params as WaitParams) ?? {};
      const ms = p.ms ?? 1000;
      return exec("wait", { ms }, (s) => ops.wait(ms, s), signal);
    },
  };

  const waitFor: AgentTool = {
    name: "wait_for",
    label: "Wait For",
    description:
      "等到页面出现某个东西：text（等到可见文本出现）、selector（等到元素出现）、gone（等到元素消失，如 loading 遮罩）。" +
      "三者**只能给一个**。已知在等什么时用它，不要用 wait 猜秒数：条件达成会立刻返回，" +
      "因此比盲等更快也更稳；到了 timeoutMs（默认 3000）仍未达成会如实返回「未达成」并附上" +
      "页面当前可见文本，那时应当 snapshot 看清页面，而不是再等一遍。" +
      "**必用它的时机**：navigate 进入新页面后、点击展开下拉/弹窗/抽屉后、点搜索或提交后——" +
      "都等一个**只在该状态出现**的地标（标题区的文字、表头、面板里的字段标签或菜单项；" +
      "菜单与导航里的字到处都是，不能当地标）。" +
      "记下的是**条件本身**：回放会重新等同一个条件，页面没到那个状态时会如实报「等它没出现」。" +
      "典型用法：等列表刷新出现新行（text/selector）、等弹窗出现（selector）、等遮罩消失（gone）。" +
      "showPage: true 时等到之后顺带附一份可交互元素清单——「navigate 后先 wait_for 地标」" +
      "这条最常用的开头，用它可以省掉紧接着的那次 snapshot。",
    parameters: paramsOf(
      {
        text: {
          type: "string",
          description:
            "等到页面**可见文本**中出现该文本。必须是页面上真的印出来的字——" +
            "快照里的名字可能来自 aria-label / placeholder / title（如 `combobox \"创建时间 [has-submenu]\"`、" +
            "带 placeholder 的输入框），那类名字用 text 永远等不到，要等它们请改用 selector",
        },
        selector: { type: "string", description: "等到该 CSS 选择器命中元素" },
        gone: { type: "string", description: "等到该 CSS 选择器不再命中元素（如 loading 消失）" },
        timeoutMs: {
          type: "number",
          description: `等待上限（毫秒，默认 ${DEFAULT_WAIT_FOR_TIMEOUT_MS}，最大 ${MAX_WAIT_FOR_TIMEOUT_MS}）`,
        },
        showPage: SHOW_PAGE_PARAM,
      },
      [],
    ),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const p = (params as WaitForParams) ?? {};
      const cond: WaitCondition = {};
      if (typeof p.text === "string" && p.text.trim()) cond.text = p.text;
      if (typeof p.selector === "string" && p.selector.trim()) cond.selector = p.selector;
      if (typeof p.gone === "string" && p.gone.trim()) cond.gone = p.gone;
      // 三种条件互斥且必居其一：给错就在**本地**报错（不消耗一次浏览器往返），
      // 且这次失败不会被记进回放脚本（录制层只记成功的操作）。
      const given = [cond.text, cond.selector, cond.gone].filter(Boolean).length;
      if (given !== 1) {
        throw new Error(
          given === 0
            ? "wait_for 需要给出 text / selector / gone 中的一个（要等到什么？）"
            : "wait_for 的 text / selector / gone 只能给一个（分别是「等到文本出现」「等到元素出现」「等到元素消失」）",
        );
      }
      return exec(
        "wait_for",
        {
          ...(cond.text ? { text: cond.text } : {}),
          ...(cond.selector ? { selector: cond.selector } : {}),
          ...(cond.gone ? { gone: cond.gone } : {}),
          ...(typeof p.timeoutMs === "number" ? { timeoutMs: p.timeoutMs } : {}),
          ...(p.showPage ? { showPage: true } : {}),
        },
        (s) => ops.waitFor(cond, p.timeoutMs, s),
        signal,
        { snapshotAfter: p.showPage === true },
      );
    },
  };

  const assertText: AgentTool = {
    name: "assert_text",
    label: "Assert Text",
    description:
      "断言当前页面是否包含指定文本；absent=true 时反过来，断言页面**不包含**该文本。" +
      "返回「成立」或「不成立」并附上证据（看到/没看到什么）。用于校验测试结果。",
    parameters: paramsOf(
      {
        expectation: {
          type: "string",
          description:
            "被断言的文本本身。不要把「不包含 / 不存在」这类否定字眼写进来——否定用 absent 表达。",
        },
        absent: {
          type: "boolean",
          description:
            "可选。true = 断言页面**不包含** expectation 这段文本（用例里的「断言页面不包含 X」「页面不应出现 X」「看不到 X」都用它）；" +
            "缺省或 false = 断言页面包含它。",
        },
      },
      ["expectation"],
    ),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const p = params as ExpectParams;
      const absent = p.absent === true;
      return exec(
        "assert_text",
        { expectation: p.expectation, ...(absent ? { absent: true } : {}) },
        (s) => ops.assertText(p.expectation, { absent }, s),
        signal,
      );
    },
  };

  const assertNoConsoleError: AgentTool = {
    name: "assert_no_console_error",
    label: "Assert No Console Error",
    description:
      "断言页面自加载以来没有 JavaScript 报错（未捕获异常 + console.error / 浏览器错误日志）。" +
      "**这类错误不体现在页面文字上，assert_text 永远看不到它**：脚本抛异常导致按钮点了没反应时，" +
      "页面往往只显示一句「操作失败」，真正的原因只有它能给出来。" +
      "用例写了「页面无控制台报错」「不应有 JS 异常」「控制台没有报错」时用它，" +
      "不要用 assert_text 检查某个字眼来假装覆盖。" +
      "ignore 可选：字符串数组，正文或出处 URL 里含任一项的条目被忽略（放行已知噪音，" +
      "如第三方脚本的报错、favicon 404）——没有它，一条已知噪音就会让用例永远红。" +
      "warnings 可选（默认 false）：设为 true 时把 warning 级消息也算失败；默认只算 error 与未捕获异常，" +
      "因为第三方库的 deprecation 警告太常见。" +
      "本工具直接产生一条断言：没有匹配的报错为「成立」，有则「不成立」并列出前几条作为证据。",
    parameters: paramsOf({
      ignore: {
        type: "array",
        items: { type: "string" },
        description:
          "可选：放行的已知噪音（子串匹配、忽略大小写，同时比对正文与出处 URL），如 [\"favicon\", \"ResizeObserver loop\"]",
      },
      warnings: {
        type: "boolean",
        description:
          "可选：true 时把 warning 级消息也算失败（默认只算 error 与未捕获异常）",
      },
    }),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const p = (params as ConsoleAssertParams) ?? {};
      const ignore = Array.isArray(p.ignore)
        ? p.ignore
            .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
            .map((s) => s.trim())
        : [];
      const warnings = p.warnings === true;
      return exec(
        "assert_no_console_error",
        {
          ...(ignore.length > 0 ? { ignore } : {}),
          ...(warnings ? { warnings: true } : {}),
        },
        (s) => ops.assertNoConsoleError({ ignore, warnings }, s),
        signal,
      );
    },
  };

  const assertNetwork: AgentTool = {
    name: "assert_network",
    label: "Assert Network",
    description:
      "断言某个网络请求发生了、且状态符合期望（读 bsk 的网络缓冲并按 URL 子串匹配）。" +
      "**用于检查页面对后端请求的结果**：提交表单后确认接口真的返回了 200、" +
      "导出时确认 `/api/export` 被调用过、排查「页面说保存失败但不知道后端到底说了什么」。" +
      "url 必填，传请求地址里的**一段**（子串匹配、忽略大小写，如 `/api/user/save`）；" +
      "status 可选，写 `200`（精确）或 `2xx` / `4xx` / `5xx`（区间）；不给 status 时语义是" +
      "「这个请求成功完成了」（至少有一条非失败的响应）；" +
      "method 可选（如 POST），用于同名路径的 GET/POST 区分。" +
      "匹配不到时会把它看到的最接近的几条请求列出来，据此一轮就能改对 url。" +
      "本工具直接产生一条断言：命中为「成立」，未命中或状态不符为「不成立」。",
    parameters: paramsOf(
      {
        url: {
          type: "string",
          description: "请求地址的一段（子串匹配、忽略大小写），如 /api/user/save",
        },
        status: {
          type: "string",
          description: "可选的状态码期望：200（精确）或 2xx / 4xx / 5xx（区间）",
        },
        method: { type: "string", description: "可选的 HTTP 方法，如 GET / POST；不给则不限制" },
      },
      ["url"],
    ),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const p = (params as NetworkAssertParams) ?? {};
      const url = typeof p.url === "string" ? p.url : "";
      if (!url.trim()) {
        // 与 wait_for 同一条规则：用法错误在**本地**报错，不消耗一次浏览器往返，
        // 这次失败也不会被录进回放脚本（录制层只记成功的操作）。
        throw new Error(
          "assert_network 需要给出 url（要断言的那个请求地址的一段，如 /api/user/save）",
        );
      }
      const status = typeof p.status === "string" && p.status.trim() ? p.status.trim() : undefined;
      const method =
        typeof p.method === "string" && p.method.trim() ? p.method.trim() : undefined;
      return exec(
        "assert_network",
        { url, ...(status ? { status } : {}), ...(method ? { method } : {}) },
        (s) => ops.assertNetwork(url, { status, method }, s),
        signal,
      );
    },
  };

  return [
    navigate,
    snapshot,
    click,
    fill,
    selectOption,
    pickDate,
    upload,
    download,
    hover,
    scroll,
    press,
    wheel,
    focus,
    blur,
    getHtml,
    screenshot,
    wait,
    waitFor,
    assertText,
    assertNoConsoleError,
    assertNetwork,
  ];
}

interface NavParams {
  url: string;
}
interface TargetParams {
  target: string;
  /** 动作后附一份可交互元素清单（见 SHOW_PAGE_PARAM）。 */
  showPage?: boolean;
}
interface FillParams {
  target: string;
  value: string;
  showPage?: boolean;
}
interface PressParams {
  /** 键名（Enter / Escape / Tab / Ctrl+A…）。 */
  key: string;
  /** 可选：先聚焦到该元素再按键（@eN 引用或 CSS 选择器）。 */
  target?: string;
  /** 可选：逗号分隔的修饰键列表（Ctrl / Shift / Alt / Meta）。 */
  modifiers?: string;
  /** 可选：按住多少毫秒再松开。 */
  holdMs?: number;
  showPage?: boolean;
}
interface WheelParams {
  /** 滚轮落点（@eN 或 CSS 选择器）；不给则视口中心。 */
  target?: string;
  /** 垂直增量：向下为正。 */
  deltaY?: number;
  /** 水平增量：向右为正。 */
  deltaX?: number;
  /** 逗号分隔的修饰键。 */
  modifiers?: string;
}
interface GetHtmlParams {
  /** 只取该 `@eN` 子树（协议侧没有选择器入口）。 */
  target?: string;
  /** 内联返回的字节预算。 */
  maxBytes?: number;
  /** 落盘路径（给了就不返回正文）。 */
  out?: string;
}
interface ScreenshotParams {
  /** 整页截图（与 `target` 互斥）。 */
  fullPage?: boolean;
  /** 只截这个元素（@eN 引用；bsk 侧没有 CSS 选择器入口）。 */
  target?: string;
  /** 显式落盘路径。 */
  out?: string;
}
interface SelectOptionParams {
  target: string;
  option: string;
  showPage?: boolean;
}
interface PickDateParams {
  target: string;
  date: string;
  /** 日期范围控件的结束日期：给了就按范围处理（选开始 → 选结束 → 确定）。 */
  endDate?: string;
  showPage?: boolean;
}
interface UploadParams {
  target?: string;
  file: string;
}
interface DownloadParams {
  target: string;
  out?: string;
  expectName?: string;
  timeoutMs?: number;
}
interface WaitParams {
  ms?: number;
}
interface WaitForParams {
  text?: string;
  selector?: string;
  gone?: string;
  timeoutMs?: number;
  showPage?: boolean;
}
interface ExpectParams {
  expectation: string;
  /** 反向断言：断言页面**不包含** `expectation` 这段文本（见 AssertTextOptions）。 */
  absent?: boolean;
}
interface ConsoleAssertParams {
  /** 放行的已知噪音（子串，忽略大小写）；形状不认识时按「没有」处理。 */
  ignore?: unknown;
  /** 是否把 warning 级消息也算失败。 */
  warnings?: boolean;
}
interface NetworkAssertParams {
  /** 请求地址的一段（子串匹配）。 */
  url?: string;
  /** 状态码期望：`200` 或 `2xx`。 */
  status?: string;
  /** HTTP 方法（可选）。 */
  method?: string;
}

/**
 * 场景收尾自动截一张图（留证据），返回落盘路径；截不到返回 null。
 *
 * 与工具层的 `screenshot` 分开写而不是复用它，有两个理由：
 * - 它拿不到 ops 实例（场景收尾发生在 `createBskTools` 的闭包之外），只有一个 session id；
 * - 它的失败语义相反——**收尾截图失败绝不影响结论**。缺一张证据图不该把一条 PASS 变成 FAIL，
 *   所以这里把失败整个吞掉、只留一行 debug（工具层的 screenshot 是模型主动要的，失败必须报）。
 *
 * 为什么要有它（2026-09-29 实测）：真实业务用例不会专门写一行「截图留证」，于是报告里
 * 一张图都没有——而失败现场恰恰最需要它。用具意图表达的「截图」步骤仍然有效，两者不冲突。
 */
export async function captureSessionScreenshot(
  session: string,
  options: { fullPage?: boolean; signal?: AbortSignal; label?: string } = {},
): Promise<string | null> {
  const label = options.label ?? (options.fullPage ? "full-page" : "final");
  const dest = screenshotPath(new Date(), label);
  try {
    ensureScreenshotDirFor(dest);
    const args = ["screenshot", "--out", dest, "--json", "--session", session, "--quiet"];
    if (options.fullPage) args.push("--full-page");
    const out = await bsk(args, options.signal);
    const meta = parseBskJson<BskScreenshotJson>(out);
    // bsk 明确说「没截成」时不当成证据（与工具层同一条判定）。
    if (meta?.capture_unavailable?.trim()) {
      debugLog("[bsk] 收尾截图未成：" + meta.capture_unavailable);
      return null;
    }
    const path = meta?.path?.trim() || dest;
    recordScreenshot(path);
    return path;
  } catch (err) {
    debugLog(
      "[bsk] 收尾截图失败（不影响结论）：" +
        (err instanceof Error ? err.message : String(err)),
    );
    return null;
  }
}

/** 创建一个 bsk session；若已提供且仍在活跃列表中则复用，否则新建。 */
export async function ensureSession(existing?: string): Promise<string> {
  if (existing && (await isActiveSession(existing))) {
    debugLog(`[bsk] 复用已存在的 session ${existing}`);
    return existing;
  }
  debugLog("[bsk] 创建新的 session…");
  const out = await bsk(["session", "start", "--json"]);
  // 两种情形都要走正则兜底：输出不是 JSON（某些 bsk 版本会带进度行），
  // 或 JSON 里偏偏没有 session_id——只在 catch 里兜底会漏掉后一种。
  try {
    const json = JSON.parse(out) as { session_id?: unknown } | null;
    if (typeof json?.session_id === "string" && json.session_id.length > 0) {
      return json.session_id;
    }
  } catch {
    // 不是 JSON，落到下面的文本兜底。
  }
  const m = out.match(/session_id["\s:]+([a-z0-9]+)/i);
  if (m?.[1]) return m[1];
  throw new Error(t("bsk.err.sessionFailed"));
}

/**
 * 关闭本次运行用过的 bsk session：bsk 会随之销毁该 session 的 Agent Window，
 * 即自动化操作的那个浏览器窗口，并归还借用过的用户标签页。
 *
 * 用例跑完（无论通过还是失败）都应调用，避免留下越来越多个浏览器窗口。
 * 清理失败只提示、不抛出：它不应该改变测试结论，也不该掩盖真正的失败原因。
 */
export async function closeSession(session: string): Promise<void> {
  const done = timer();
  try {
    debugLog(`[bsk] 关闭 session ${session}（同时关闭 Agent Window）…`);
    await bsk(["session", "stop", session, "--quiet"]);
    debugLog(`[bsk] session ${session} 已关闭（${done()}ms）`);
    info(t("bsk.session.closed", { session }));
  } catch (err) {
    info(
      t("bsk.session.closeFailed", {
        session,
        msg: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/** 检查给定 session 是否在 bsk 活跃列表里。 */
async function isActiveSession(id: string): Promise<boolean> {
  try {
    const out = await bsk(["session", "list", "--json"]);
    const list = JSON.parse(out);
    if (Array.isArray(list)) return list.some((s) => s?.session_id === id);
  } catch {
    // 忽略解析错误
  }
  return false;
}
