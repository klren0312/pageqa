/**
 * 进度日志：默认输出到 **stderr**（stdout 保留给测试报告本身）。
 *
 * - `info()`：常规进度，**默认始终输出**，让长时间运行的用例在终端能看到「进行到哪一步」，
 *   避免看起来像卡死（尤其是 bsk daemon 启动、创建 session、等待模型输出这些静默阶段）。
 * - `debugLog()`：`--debug` 时额外输出的细节（bsk 命令、快照体积、上下文裁剪、Jev 请求等）。
 *
 * 每行带本地时间戳 `HH:mm:ss`，便于从时间间隔判断是「在跑」还是「卡住了」。
 *
 * 输出的**目的地是可注入的**（`setSink`）：交互模式下界面独占屏幕，stderr 再直接写会
 * 把画面撕开，因此日志接进界面的滚动视口；批处理模式用默认的 stderr sink，行为与历史
 * 逐字一致。时间戳在这一层统一加好，sink 只负责决定「把它送到哪」。
 */

import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 日志行（已带时间戳）的落点。 */
export type LogSink = (line: string) => void;

/** 默认 sink：带换行写 stderr（批处理模式的行为，与历史一致）。 */
const stderrSink: LogSink = (line) => {
  process.stderr.write(line + "\n");
};

let sink: LogSink = stderrSink;
let debugEnabled = false;

/** 设置是否输出调试日志（由 CLI 的 `--debug` 决定）。 */
export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

/**
 * 替换日志落点（交互模式把它接进界面视口）。
 * 传 `null` 恢复默认的 stderr——退出交互模式时应当复位，避免日志继续往已销毁的界面里写。
 */
export function setSink(next: LogSink | null): void {
  sink = next ?? stderrSink;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function stamp(): string {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * 写一行日志。`fileLine` 是**给文件的另一个版本**（省略即与终端同文）。
 *
 * 两个版本的必要性来自两种介质的不同约束：
 * - 终端/视口是逐行滚动的，一条事件撑成十几行会把上下文顶出屏幕，所以那里必须压成单行；
 * - 文件是事后排查的原文证据，「details 后面被截断了」等于白记——省下的几十字节换不来
 *   任何东西，却让「到底哪一种权限被拒」重新变成猜。
 *
 * 因此调用方在**会截断**的地方同时给出两版，其余情况只给一版。
 */
function write(line: string, fileLine?: string): void {
  const text = `${stamp()} ${line}`;
  // 先落盘再上屏：写文件失败不能影响终端输出（反之亦然，见 fileSink 的注释）。
  fileSink?.(fileLine === undefined ? text : `${stamp()} ${fileLine}`);
  sink(text);
}

/** 常规进度日志（始终输出）。`fileMsg` 见 {@link write}。 */
export function info(msg: string, fileMsg?: string): void {
  write(msg, fileMsg);
}

/** 调试日志（仅 `--debug` 时输出）。`fileMsg` 见 {@link write}。 */
export function debugLog(msg: string, fileMsg?: string): void {
  if (debugEnabled) write("[debug] " + msg, fileMsg === undefined ? undefined : "[debug] " + fileMsg);
}

// ── 日志落盘 ──
//
// 终端里的进度日志一滚就没了，而事后排查（「第 41 次导航为什么 56ms 就被拒」）
// 恰恰需要原文。落盘与 sink **互不干扰**：sink 是可替换的（交互模式接进视口），
// 文件则始终追加——因此这里挂在 `write()` 上，而不是做成另一种 sink。

/** 当前生效的落盘器；未启用时为 undefined。 */
let fileSink: ((line: string) => void) | undefined;

/** 当前日志文件路径（未启用时为 undefined）。 */
let filePath: string | undefined;

/** 只认本工具自己写的日志文件，避免清理时误删同目录的其它文件。 */
const LOG_NAME_RE = /^pageqa-(\d{4})-(\d{2})-(\d{2})\.log$/;

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 把 `YYYY-MM-DD` 平移若干天（用本地日期构造，避免跨时区偏一天）。 */
function shiftDays(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return dayKey(new Date(y, (m ?? 1) - 1, (d ?? 1) + days));
}

/**
 * 删掉超过保留期的日志文件，返回删掉的文件数。
 *
 * `keepDays = 1` 的意思是「只留今天」——用户要的就是一天一清。按文件名里的日期判断而不是
 * mtime：mtime 会被复制/解压改写，日期是这文件自己的身份。读不了目录就当没有（日志目录
 * 不存在是首次运行的常态）。
 */
export function pruneLogs(dir: string, keepDays: number, today = dayKey(new Date())): number {
  const cutoff = shiftDays(today, -(Math.max(1, keepDays) - 1));
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const m = LOG_NAME_RE.exec(name);
    if (!m) continue;
    const key = `${m[1]}-${m[2]}-${m[3]}`;
    // 形如 2026-11-18 的字符串可以直接按字典序比大小。
    if (key >= cutoff) continue;
    try {
      rmSync(join(dir, name));
      removed += 1;
    } catch {
      // 删不掉（被占用 / 权限）就留着，下次启动再清
    }
  }
  return removed;
}

export interface FileLogOptions {
  /** 目录，默认 `PAGEQA_LOG_DIR` 或 `~/.pageqa/logs`。 */
  dir?: string;
  /** 保留几天（含今天），默认 `PAGEQA_LOG_KEEP_DAYS` 或 1。 */
  keepDays?: number;
}

/**
 * 把进度日志追加到 `pageqa-YYYY-MM-DD.log`，并按天清理旧文件。
 *
 * - 默认目录 `~/.pageqa/logs`（与 auth/proxy/config 同一处），`PAGEQA_LOG_DIR` 可改；
 * - 默认只留今天，`PAGEQA_LOG_KEEP_DAYS=3` 这类可以放宽；
 * - `PAGEQA_LOG=0` 整体关掉。
 *
 * 返回当前文件路径，供启动日志说明「写到哪了」；未启用时返回 undefined。
 * 启用是**入口显式调用**的（见 index.ts），模块本身不自动落盘——否则 `node --test`
 * 跑一遍单测就会往用户 home 里塞日志。
 */
export function enableFileLog(options: FileLogOptions = {}): string | undefined {
  if (process.env.PAGEQA_LOG?.trim() === "0") return undefined;
  const dir =
    options.dir?.trim() ||
    process.env.PAGEQA_LOG_DIR?.trim() ||
    join(homedir(), ".pageqa", "logs");
  const rawKeep = options.keepDays ?? Number(process.env.PAGEQA_LOG_KEEP_DAYS);
  const keepDays = Number.isFinite(rawKeep) && rawKeep >= 1 ? Math.floor(rawKeep) : 1;

  /** 当前正写的文件及其属于哪一天；跨过午夜就换一个（长跑进程不会重启）。 */
  let currentDay = "";
  let currentFile = "";

  const openFor = (today: string): string => {
    currentDay = today;
    currentFile = join(dir, `pageqa-${today}.log`);
    try {
      mkdirSync(dir, { recursive: true });
      pruneLogs(dir, keepDays, today);
    } catch {
      // 目录建不出来也不抛：下面 append 会失败，届时统一停掉落盘
    }
    return currentFile;
  };

  filePath = openFor(dayKey(new Date()));
  let broken = false;
  fileSink = (line: string) => {
    if (broken) return;
    try {
      const today = dayKey(new Date());
      if (today !== currentDay) filePath = openFor(today);
      appendFileSync(currentFile, line + "\n", "utf8");
    } catch {
      // 磁盘满 / 权限不足：静默停掉，之后不再重试——写不了日志不该拖垮被测流程，
      // 也不该把同一个错误刷满终端。
      broken = true;
      fileSink = undefined;
    }
  };
  return filePath;
}

/** 停掉落盘（测试复位用；正常进程退出无需调用，每行都是同步追加）。 */
export function disableFileLog(): void {
  fileSink = undefined;
  filePath = undefined;
}

/** 当前日志文件路径；未启用时 undefined。 */
export function currentLogFile(): string | undefined {
  return filePath;
}

/** 简单计时器：`const done = timer(); … done()` 返回自创建以来的毫秒数。 */
export function timer(): () => number {
  const t0 = Date.now();
  return () => Date.now() - t0;
}
