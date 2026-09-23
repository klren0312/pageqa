/**
 * 浮层外框：给浮层内容画一圈边框，并把每一行填满内宽。
 *
 * 浮层是**合成**在日志之上的（`showOverlay` 只覆盖自己那块矩形），所以光有内容还不够：
 * 没有边框、行右侧又留空时，底下的日志会从行间与右侧透出来，用户分不清哪块是弹框、
 * 哪块是日志。因此这里做两件事——画框，以及把每行补齐到内宽（即「不透底」）。
 *
 * 渲染刻意做成纯函数（`truncate` 由调用方注入 pi-tui 的 `truncateToWidth`）：app.ts 顶部
 * 只做**类型**导入 pi-tui，值一律在 runInteractive 里动态 import，好让非交互路径不为 UI
 * 依赖付出加载开销（见那里的说明）。这同时让「每行宽度必须等于浮层宽度」这条不变量
 * 可以直接单测。
 */
import { accent } from "./theme.js";

/** 与 pi-tui `truncateToWidth` 同形：按可见宽度截断，`pad` 为真时补齐到恰好 `maxWidth`。 */
export type WidthTruncate = (
  text: string,
  maxWidth: number,
  ellipsis?: string,
  pad?: boolean,
) => string;

/** 内容相对浮层左上角的偏移：左边框 1 + 左内边距 1。 */
export const OVERLAY_INSET = 2;

/** 浮层内容的可用宽度（去掉左右边框与内边距；再窄也留 1 列，不让负数往下传）。 */
export function overlayInnerWidth(width: number): number {
  return Math.max(1, width - OVERLAY_INSET * 2);
}

/** 把内容行包进边框；每行都补齐到 `width`，保证浮层不透出底下的日志。 */
export function frameLines(
  lines: string[],
  width: number,
  truncate: WidthTruncate,
): string[] {
  const inner = overlayInnerWidth(width);
  // 边框用强调色：与日志的暗色正文拉开距离，不然「有没有框」在视觉上没有区别。
  const edge = accent;
  const body = lines.map(
    (line) => edge("│") + " " + truncate(line, inner, "…", true) + " " + edge("│"),
  );
  const rule = edge("─".repeat(Math.max(0, width - 2)));
  return [
    edge("╭") + rule + edge("╮"),
    ...body,
    edge("╰") + rule + edge("╯"),
  ];
}
