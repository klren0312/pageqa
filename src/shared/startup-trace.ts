/**
 * 启动耗时打点：回答「TUI 打开要十几秒，这十几秒花在哪」。
 *
 * 为什么要有它：这个问题的每一种猜测都能自圆其说——node 自身启动、模块图加载、
 * 模型目录（pi-ai 的 40 多个 provider）、首帧渲染、某个网络请求——但它们相差一个数量级，
 * 猜错方向就是在给不慢的地方做优化。而真正缺的从来不是猜测，是一份时间线。
 *
 * 为什么是**文件**而不是屏幕：这类问题的典型表现就是「屏幕全黑、一行输出都没有」。
 * 打在屏幕上等于打在黑屏上，什么也留不下；所以每个打点立刻追加一行到文件，进程卡死
 * 在半路也留得下证据。
 *
 * 用法（默认完全关闭，`markStartup()` 退化成一次空函数调用，启动路径上不留任何 I/O）：
 *
 *   PAGEQA_STARTUP_TRACE=1 node dist/index.js          # 落 ~/.pageqa/startup-trace.log
 *   PAGEQA_STARTUP_TRACE=D:/tmp/boot.log node dist/index.js
 *
 * 时间基准是 `performance.now()`：Node 里它就是「进程启动至今的毫秒数」，因此**第一个
 * 打点本身就含着 node 自身的启动开销**——「node 慢」与「我们的模块慢」因此能一眼分开。
 * 相邻打点的差值是那一段的净耗时（见 {@link startupTraceSummary}）。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** `PAGEQA_STARTUP_TRACE=1` 时的默认落点。 */
const DEFAULT_TRACE_PATH = join(homedir(), ".pageqa", "startup-trace.log");

/**
 * 解析打点落点：`1`/`true` 用默认路径，`0`/`false`/空视为关闭，其它值当文件路径。
 *
 * 刻意在模块加载时算一次：之后每次打点都只做一次字符串拼接与 append，不再读环境变量。
 */
function resolveTraceTarget(): string | undefined {
  const raw = process.env.PAGEQA_STARTUP_TRACE?.trim();
  if (!raw || raw === "0" || raw === "false") return undefined;
  return raw === "1" || raw === "true" ? DEFAULT_TRACE_PATH : raw;
}

const target = resolveTraceTarget();

/** 已打的点（按时间顺序）：汇总行要算相邻差值。 */
const marks: Array<{ name: string; at: number }> = [];

/** 打点是否启用（调用方据此决定要不要构造开销较大的描述文本）。 */
export function startupTraceEnabled(): boolean {
  return target !== undefined;
}

/**
 * 打一个点。未启用时是一次空调用。
 *
 * 名字用短英文（`main` / `tui-module` / `first-frame`）：它是给人对着时间线读的，
 * 不该跟着 `--locale` 变。
 */
export function markStartup(name: string): void {
  if (!target) return;
  const at = performance.now();
  marks.push({ name, at });
  try {
    if (marks.length === 1) {
      mkdirSync(dirname(target), { recursive: true });
      // 每次运行都留一行分隔：追加写让历史都在，才能对比「以前快、现在慢」。
      appendFileSync(
        target,
        `--- ${new Date().toISOString()} pid=${process.pid} node=${process.version} argv=${process.argv.slice(2).join(" ") || "(无参)"}\n`,
      );
    }
    appendFileSync(target, `${at.toFixed(0)}ms\t${name}\n`);
  } catch {
    // 打点写不进去不该影响启动：这条路只服务诊断。
  }
}

/**
 * 记录「第一帧真正写到终端」的时刻（打点名 `first-frame`），并在那一刻执行 `onFirstWrite`。
 *
 * `tui.start()` 之后的首帧由 pi-tui 的渲染定时器触发，`requestRender()` 返回时屏幕上
 * 还什么都没有。因此在启动前包一层 `process.stdout.write`：第一次写入的时刻就是
 * 「用户看到东西」的时刻，记完立刻还原，不改变任何输出行为。
 *
 * `onFirstWrite` 在**转发这次写入之前**执行：它只该往日志视口（sink）里写，不能直接写
 * stdout（那会重新进入这个包层）；用它打启动汇总行，时机才恰好是「首帧这一刻」。
 */
export function markFirstStdoutWrite(
  name: string,
  onFirstWrite?: () => void,
): void {
  if (!target) return;
  // `raw` 只用于还原：还原成 bound 版会永久改掉 `process.stdout.write` 的函数身份。
  const raw = process.stdout.write;
  const forward = raw.bind(process.stdout);
  process.stdout.write = ((...args: Parameters<typeof forward>) => {
    process.stdout.write = raw;
    markStartup(name);
    onFirstWrite?.();
    return forward(...args);
  }) as typeof process.stdout.write;
}

/**
 * 一行汇总：每段净耗时 + 累计耗时，首帧之后打进日志视口。
 *
 * 未启用（或还没打过点）时返回 `undefined`——调用方不必自己判断。
 */
export function startupTraceSummary(): string | undefined {
  if (!target || marks.length === 0) return undefined;
  // 第一个点打绝对值（它含着 node 自身的启动开销），其余打与前一点的差值。
  const parts: string[] = [];
  let previous: number | undefined;
  for (const mark of marks) {
    parts.push(
      previous === undefined
        ? `${mark.name}=${mark.at.toFixed(0)}ms`
        : `${mark.name}=+${(mark.at - previous).toFixed(0)}ms`,
    );
    previous = mark.at;
  }
  return `[trace] startup ${(previous ?? 0).toFixed(0)}ms: ${parts.join(" · ")} (${target})`;
}
