/**
 * 交互界面对按键的调整：键位覆盖 + 「↑/↓ 归谁」的上下文分派。
 *
 * ## 1. 视口滚动键位
 *
 * pi-tui 给主滚动视口（`primary: true`）留了翻页（`PageUp`/`PageDown`）、首尾
 * （`Home`/`End`）与鼠标滚轮，但**逐行滚动（`lineUp`/`lineDown`）默认没有任何键位**。
 * 那恰恰是用户最先去按的一档，因此这里把它接到 `Ctrl+↑`/`Ctrl+↓`。
 *
 * 为什么是这两个键：`Alt+↑/↓` 会被 Windows Terminal 抢去切分屏，`Shift+↑/↓` 会被终端
 * 抢去做文本选择，都送不到应用；`Ctrl+↑/↓` 在 Windows Terminal / conhost / VS Code
 * 终端里都能原样送达。视口的输入监听先于聚焦组件执行（`TuiBase.handleTerminalInput`），
 * 因此这些键不会漏进输入框；反过来，凡是编辑器要用的键（`Ctrl+U`/`Ctrl+D`/`Ctrl+W`…）
 * 这里一个都不碰。
 *
 * `previousPrompt` / `nextPrompt` 默认占着 `Ctrl+↑/↓`，但它们跳的是 shell 的 OSC 133
 * 提示符标记——pageqa 的日志里没有这种标记，按了等于没反应。因此把它们挪到
 * `Ctrl+Shift+↑/↓`（能力保留、键位腾出），而不是直接丢弃。
 *
 * ## 2. ↑/↓ 的上下文分派（用 `arrowKeysBelongToLog()`，在 `app.ts` 的输入监听里）
 *
 * 一部分终端在应用没开鼠标上报、或忽略了上报时，会把**滚轮翻译成 `↑`/`↓`** 送进来
 * （VS Code / xterm.js 的全屏缓冲就是如此：alt 缓冲里滚轮变成方向键，好让 less/man
 * 这类程序能翻页）。于是「用滚轮滚日志」在那类终端里等于「按 `↑`/`↓`」：
 * 输入框为空时编辑器把它当作历史浏览，直接把上一次提交的文本顶进输入框——
 * 滚轮没滚日志，反倒把输入框搞乱了。
 *
 * 滚轮和真的方向键在字节上**无法区分**，只能按上下文分派：**输入框为空时 `↑`/`↓`
 * 归日志视口**（滚轮因此能滚日志），历史输入改用 `Ctrl+P`/`Ctrl+N`。输入框里一旦有
 * 内容（包括 `Ctrl+P` 调出来的历史文本），`↑`/`↓` 立刻回到编辑器手里当光标/历史浏览用。
 *
 * ## 3. 滚轮步长
 *
 * pi-tui 默认一格 1 行：滚起来几乎看不出变化，容易被当成「滚不动」。3 行是终端里更常见的步长。
 * 被翻译成 `↑`/`↓` 的滚轮走同一个步长（它们本来就是同一串字节，步长不一致只会更费解）。
 */
import type { KeybindingsConfig } from "@earendil-works/pi-tui";

export const KEYBINDINGS: KeybindingsConfig = {
  "tui.altScreen.lineUp": "ctrl+up",
  "tui.altScreen.lineDown": "ctrl+down",
  "tui.altScreen.previousPrompt": "ctrl+shift+up",
  "tui.altScreen.nextPrompt": "ctrl+shift+down",
  // 历史输入从 ↑/↓（被滚轮占用）挪到 readline 的老习惯上。
  "tui.editor.historyPrevious": "ctrl+p",
  "tui.editor.historyNext": "ctrl+n",
};

/** 鼠标滚轮一格滚几行（被终端翻译成 `↑`/`↓` 的滚轮每格同样是这个步长）。 */
export const WHEEL_SCROLL_LINES = 3;

/**
 * `↑`/`↓` 此刻归日志视口，还是归输入框？
 *
 * 只有「输入框为空、且没有浮层/联想列表在等方向键」时才归日志：那样滚轮（被翻译成
 * `↑`/`↓`）就能滚日志，而输入框里一旦有内容（含 `Ctrl+P` 调出的历史），`↑`/`↓`
 * 立刻回到编辑器手里继续当历史浏览/光标移动用。
 */
export function arrowKeysBelongToLog(state: {
  /** 输入框里的文本。 */
  text: string;
  /** 是否有浮层（选择器、登录提问）正在使用方向键。 */
  overlayOpen: boolean;
  /** 自动补全列表是否正在显示（它也靠 `↑`/`↓` 选条目）。 */
  autocompleteShowing: boolean;
}): boolean {
  if (state.overlayOpen || state.autocompleteShowing) return false;
  return state.text.trim().length === 0;
}
