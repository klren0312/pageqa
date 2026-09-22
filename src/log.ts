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

/** 当前是否处于调试模式。 */
export function isDebug(): boolean {
  return debugEnabled;
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

function write(line: string): void {
  sink(`${stamp()} ${line}`);
}

/** 常规进度日志（始终输出）。 */
export function info(msg: string): void {
  write(msg);
}

/** 调试日志（仅 `--debug` 时输出）。 */
export function debugLog(msg: string): void {
  if (debugEnabled) write("[debug] " + msg);
}

/** 简单计时器：`const done = timer(); … done()` 返回自创建以来的毫秒数。 */
export function timer(): () => number {
  const t0 = Date.now();
  return () => Date.now() - t0;
}
