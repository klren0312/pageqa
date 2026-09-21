/**
 * 进度日志：统一输出到 **stderr**（stdout 保留给测试报告本身）。
 *
 * - `info()`：常规进度，**默认始终输出**，让长时间运行的用例在终端能看到「进行到哪一步」，
 *   避免看起来像卡死（尤其是 bsk daemon 启动、创建 session、等待模型输出这些静默阶段）。
 * - `debugLog()`：`--debug` 时额外输出的细节（bsk 命令、快照体积、上下文裁剪、Jev 请求等）。
 *
 * 每行带本地时间戳 `HH:mm:ss`，便于从时间间隔判断是「在跑」还是「卡住了」。
 */

let debugEnabled = false;

/** 设置是否输出调试日志（由 CLI 的 `--debug` 决定）。 */
export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

/** 当前是否处于调试模式。 */
export function isDebug(): boolean {
  return debugEnabled;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function stamp(): string {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function write(line: string): void {
  process.stderr.write(`${stamp()} ${line}\n`);
}

/** 常规进度日志（始终输出到 stderr）。 */
export function info(msg: string): void {
  write(msg);
}

/** 调试日志（仅 `--debug` 时输出到 stderr）。 */
export function debugLog(msg: string): void {
  if (debugEnabled) write("[debug] " + msg);
}

/** 简单计时器：`const done = timer(); … done()` 返回自创建以来的毫秒数。 */
export function timer(): () => number {
  const t0 = Date.now();
  return () => Date.now() - t0;
}
