/**
 * 鼠标选中后的剪贴板写入：拖动松手即复制（pi-tui 的 `copyOnSelect` 默认就是开的）。
 *
 * pi-tui 自带两条路：
 * - **不注入** `copySelection`：它只写 OSC 52（`ESC ] 52 ; c ; <base64> BEL`）并无条件闪
 *   「Copied!」。OSC 52 是单向写，终端丢弃该序列时用户看到的是一次假成功——Terminal.app、
 *   没有 passthrough 的 tmux 都这样，剪贴板其实是空的。
 * - **注入** `copySelection`：由宿主决定怎么复制，**返回 `true` 才算成功**，此时它不再写 OSC 52，
 *   返回字符串则被当作失败文案闪 5 秒（`tui-alt-screen.js` 的 `copyTextToClipboard`）。
 *
 * 本模块给出的顺序是「能验证的先走」：
 * 1. 平台原生剪贴板（pi-tui 的 prebuild；Windows 走 `SetClipboardData(CF_UNICODETEXT)`，
 *    不依赖 powershell / clip.exe）；
 * 2. 原生不可用或抛错 → 回退 OSC 52，并回调 `onFallback` 让上层在日志里留痕（否则「复制了
 *    但剪贴板是空的」这件事永远查不出来）；
 * 3. 两条都失守 → 返回失败文案。
 *
 * 逻辑抽成纯函数、依赖靠注入，是因为 `tests/` 下没有真实 TTY（也就没有鼠标），只能这样覆盖
 * 分支：真实终端里没法断言「剪贴板里到底是什么」。
 */

/** 走 OSC 52 时要写的字节：内容按 UTF-8 转 base64，`c` 表示系统剪贴板（而非选择区）。 */
export function osc52Sequence(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

export interface ClipboardCopyDeps {
  /** 平台原生写入；`undefined` 表示当前平台没有 prebuild（此时直接走 OSC 52）。 */
  setText?: (text: string) => Promise<void> | void;
  /** 往终端写原始字节（`ProcessTerminal.write`）。 */
  write: (data: string) => void;
  /** 回退到 OSC 52 时回调一次：上层用它往日志里补一行「复制可能没生效」。 */
  onFallback?: () => void;
  /** 两条通道都失守时给用户看的文案；延迟求值，跟随当前界面语言。 */
  failureMessage: () => string;
}

/**
 * 造一个可注入给 `TuiAltScreen` 的 `copySelection`。
 *
 * 返回值语义与 pi-tui 的约定一致：`true` = 成功（它闪「Copied!」），字符串 = 失败文案。
 * 任何异常都不会冒出去——`copySelection` 是在鼠标事件处理器里被 `await` 的，抛错会直接
 * 落到事件循环上，把整个界面拖崩。
 */
export function createClipboardCopy(
  deps: ClipboardCopyDeps,
): (text: string) => Promise<true | string> {
  return async (text) => {
    if (!text) return deps.failureMessage();

    if (deps.setText) {
      try {
        await deps.setText(text);
        return true;
      } catch {
        // 原生通道失守（剪贴板被别的进程占用、DLL 缺失等）：继续往下走 OSC 52。
      }
    }

    try {
      deps.write(osc52Sequence(text));
    } catch {
      return deps.failureMessage();
    }
    deps.onFallback?.();
    // OSC 52 无法验证终端是否真的收下：乐观报成功，靠上面的那行日志留痕。
    return true;
  };
}