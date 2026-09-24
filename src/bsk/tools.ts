import { execFile, spawn } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
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
import { JevClient } from "../jev.js";
import { debugLog, info, timer } from "../log.js";
import { slimSnapshot } from "../snapshot.js";
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

/** 操作被调用方主动中止（交互模式下按 Esc）。 */
export class BskAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BskAbortError";
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
 * 执行一条 bsk 命令：**异步、可中止、全局串行**。
 *
 * 异步不是风格选择：`execFileSync` 会阻塞整个事件循环，交互模式下界面在这期间完全不
 * 渲染、不收键，Esc 也停不下来（与 daemon 轮询必须异步是同一个原因，见 bskStatusJsonAsync）。
 * `signal` 触发时直接 kill 子进程，否则「中止」只能等当前这条命令自己跑完（最坏 60s）。
 */
function bsk(
  args: string[],
  signal?: AbortSignal,
  timeoutMs: number = BSK_TIMEOUT_MS,
): Promise<string> {
  // 上一条成功还是失败都要继续跑下一条：单条命令失败不该堵死整个队列。
  const run = commandChain.then(
    () => runBsk(args, signal, timeoutMs),
    () => runBsk(args, signal, timeoutMs),
  );
  commandChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
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
          resolve(String(stdout));
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
  /** 读取页面快照（已瘦身）；期间无页面改动且间隔很短时复用上一份，不重新抓取。 */
  snapshot(signal?: AbortSignal): Promise<string>;
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
  wait(ms: number, signal?: AbortSignal): Promise<string>;
  /**
   * 断言页面是否包含期望文本：字面包含优先，字面未命中时（Jev 可用）才做语义复核。
   */
  assertText(expectation: string, signal?: AbortSignal): Promise<string>;
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

/** 一次 assert_text / download 的结构化结果。 */
export interface AssertOutcome {
  /** 断言期望（assert_text 的 expectation，或 download 的「文件已下载」期望）。 */
  expectation: string;
  /** 是否成立。 */
  pass: boolean;
  /** 证据（页面里看到/没看到什么，或捕获到/没捕获到什么文件）。 */
  evidence: string;
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

  /** 页面被本工具改动过（或刚刚等待过），之前的快照不再可信。 */
  const markStale = (): void => {
    snapshotFresh = false;
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

    async snapshot(signal?: AbortSignal): Promise<string> {
      return await ensureSnapshot(SNAPSHOT_DEDUP_MS, "snapshot", signal);
    },

    async click(target: string, signal?: AbortSignal): Promise<string> {
      markStale();
      const out = await bsk(["click", target, ...quiet], signal);
      return `已点击 ${target}\n${out}`;
    },

    async fill(
      target: string,
      value: string,
      signal?: AbortSignal,
    ): Promise<string> {
      markStale();
      const out = await bsk(["fill", target, "--value", value, ...quiet], signal);
      return `已在 ${target} 填入文本\n${out}`;
    },

    async upload(
      target: string | undefined,
      file: string,
      signal?: AbortSignal,
    ): Promise<string> {
      if (!existsSync(file)) {
        throw new Error(t("bsk.err.uploadMissing", { file }));
      }
      markStale();
      const args = ["upload"];
      if (target) args.push(target);
      args.push("--file", file, ...quiet);
      const out = await bsk(args, signal);
      return `已上传文件 ${file}\n${out}`;
    },

    async download(
      target: string,
      out: string | undefined,
      expectName: string | undefined,
      timeoutMs: number,
      signal?: AbortSignal,
    ): Promise<string> {
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
      markStale();
      const out = await bsk(["hover", target, ...quiet], signal);
      return `已悬停 ${target}\n${out}`;
    },

    async scroll(target: string, signal?: AbortSignal): Promise<string> {
      // scroll-to 同时支持 @eN 引用与 CSS 选择器。
      // （早期实现用 evaluate + querySelector，遇到 @eN 会静默返回 element-not-found。）
      markStale();
      const out = await bsk(["scroll-to", target, ...quiet], signal);
      return `已滚动到 ${target}\n${out}`;
    },

    async wait(ms: number, signal?: AbortSignal): Promise<string> {
      // wait-ms 是 daemon 端 sleep，不接受 --session。
      // 等待本身就是为了让页面变化（异步渲染/动画/弹窗），因此必须置为不新鲜：
      // 回放的「每步重试前重新取快照」正是靠它生效的。
      markStale();
      // 超时按等待时长放宽：一律套默认 60s 的话 wait(90_000) 必然中途被杀，
      // 报出的还是「daemon 未启动」这种南辕北辙的提示。
      await bsk(["wait-ms", String(ms)], signal, ms + 30_000);
      return `已等待 ${ms}ms`;
    },

    async assertText(
      expectation: string,
      signal?: AbortSignal,
    ): Promise<string> {
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
      // 字面包含匹配即默认路径，也是 Jev 不可用时的回退；
      // 结论与证据同时写进 assertOutcome，供报告直接取用（不依赖模型自述措辞）。
      const literalHit = snap.includes(expectation);
      const verdict = (pass: boolean, why: string): string => {
        assertOutcome = { expectation, pass, evidence: why };
        return `断言「${expectation}」：${pass ? "成立" : "不成立"}。${why}`;
      };
      const literalWhy = literalHit
        ? `页面中包含「${expectation}」`
        : `页面中未找到「${expectation}」`;

      // 防御：快照为空或明显不是已加载页面 → 断言不成立。
      // 浏览器页面还没打开时，bsk 返回的是空串/about:blank/错误信息，
      // 此时不应信任 Jev 或直接判定「成立」（空页面不可能包含断言文本）。
      const snapLen = snap.trim().length;
      const SNAP_MIN_LEN = 30;
      if (snapLen < SNAP_MIN_LEN) {
        return verdict(
          false,
          `证据：页面快照为空或过短（${snapLen} 字符），页面可能尚未打开或未导航`,
        );
      }

      // 1) 字面包含命中即成立：这是默认路径，也是绝大多数断言的真实情况。
      //    命中时不再调用 Jev —— 省掉一次远端往返（超时上限 15s），
      //    也避免引入「肉眼可见的文本被判成不成立」这类新的失败来源。
      if (literalHit) return verdict(true, literalWhy);

      // 2) 字面未命中才请 Jev 复核：这正是语义判断有价值的场景
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
          return verdict(literalHit, `${literalWhy}（Jev 不可用，已回退）`);
        }
      }

      // 默认：字符串包含匹配
      return verdict(false, literalWhy);
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
  const exec = async (
    name: string,
    params: Record<string, unknown>,
    fn: (signal?: AbortSignal) => Promise<string>,
    signal?: AbortSignal,
  ) => {
    const before = ops.lastSnapshot();
    try {
      const text = await fn(signal);
      // download 也是断言型工具：它的结论（捕获到没有、文件名对不对）落在同一条结构化结果上。
      const assertion =
        name === "assert_text" || name === "download" ? ops.lastAssert() : null;
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
      return ok(text);
    } catch (err) {
      opts.onExec?.({ name, params, ok: false, lastSnapshot: before });
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
    description: "点击一个元素。可用快照里的 @eN 引用或 CSS 选择器。",
    parameters: paramsOf(
      { target: { type: "string", description: "@eN 引用或 CSS 选择器" } },
      ["target"],
    ),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const p = params as TargetParams;
      return exec(
        "click",
        { target: p.target },
        (s) => ops.click(p.target, s),
        signal,
      );
    },
  };

  const fill: AgentTool = {
    name: "fill",
    label: "Fill",
    description: "在输入框/文本域中填入文本（会先清空原有内容）。",
    parameters: paramsOf(
      {
        target: { type: "string", description: "@eN 引用或 CSS 选择器" },
        value: { type: "string", description: "要输入的文本" },
      },
      ["target", "value"],
    ),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const p = params as FillParams;
      return exec(
        "fill",
        { target: p.target, value: p.value },
        (s) => ops.fill(p.target, p.value, s),
        signal,
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
    description: "悬停在一个元素上，用于触发悬停菜单/提示。",
    parameters: paramsOf(
      { target: { type: "string", description: "@eN 引用或 CSS 选择器" } },
      ["target"],
    ),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const p = params as TargetParams;
      return exec(
        "hover",
        { target: p.target },
        (s) => ops.hover(p.target, s),
        signal,
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

  const wait: AgentTool = {
    name: "wait",
    label: "Wait",
    description: "等待一段时间（毫秒）或等待页面导航完成。",
    parameters: paramsOf({ ms: { type: "number", description: "等待毫秒数" } }),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const p = (params as WaitParams) ?? {};
      const ms = p.ms ?? 1000;
      return exec("wait", { ms }, (s) => ops.wait(ms, s), signal);
    },
  };

  const assertText: AgentTool = {
    name: "assert_text",
    label: "Assert Text",
    description:
      "断言当前页面是否包含指定文本。返回「成立」或「不成立」并附上证据（命中片段）。用于校验测试结果。",
    parameters: paramsOf(
      {
        expectation: { type: "string", description: "期望在页面中出现的文本" },
      },
      ["expectation"],
    ),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const p = params as ExpectParams;
      return exec(
        "assert_text",
        { expectation: p.expectation },
        (s) => ops.assertText(p.expectation, s),
        signal,
      );
    },
  };

  return [
    navigate,
    snapshot,
    click,
    fill,
    upload,
    download,
    hover,
    scroll,
    wait,
    assertText,
  ];
}

interface NavParams {
  url: string;
}
interface TargetParams {
  target: string;
}
interface FillParams {
  target: string;
  value: string;
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
interface ExpectParams {
  expectation: string;
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
