/**
 * 帮助文本分页。
 *
 * Windows 上把 UTF-8 帮助管道给 `more.com` 会按控制台代码页解释，中文变乱码；
 * 因此默认使用**内置分页器**，直接写 `process.stdout`（与普通日志同一条编码路径）。
 * 用户显式设置 `PAGER` 时仍用外部分页器（编码由用户选择的程序负责）。
 *
 * 非 TTY（CI、管道）、`--no-pager`、`PAGEQA_NO_PAGER=1` 一律直接输出。
 */
import { spawn } from "node:child_process";
import { t } from "./shared/i18n.js";

export interface PagerCommand {
  command: string;
  args: string[];
  /** `PAGER` 可能带参数（`less -R`），交给 shell 解析。 */
  shell?: boolean;
}

export function shouldPage(
  isTTY: boolean,
  noPager: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isTTY || noPager) return false;
  return env.PAGEQA_NO_PAGER !== "1";
}

/** 只有显式 `PAGER` 才用外部程序；默认走内置分页器，避免 Windows 编码问题。 */
export function pagerCandidates(
  env: NodeJS.ProcessEnv = process.env,
): PagerCommand[] {
  const custom = env.PAGER?.trim();
  return custom ? [{ command: custom, args: [], shell: true }] : [];
}

function runPager(pager: PagerCommand, text: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(pager.command, pager.args, {
      stdio: ["pipe", "inherit", "inherit"],
      windowsHide: true,
      ...(pager.shell ? { shell: true } : {}),
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
    // 用户提前按 q 关闭分页器时，写入端会 EPIPE；不影响已经显示的内容。
    child.stdin?.on("error", () => {});
    child.stdin?.end(text);
  });
}

/** 尝试外部 `PAGER`；不可用返回 false，由调用方回退内置分页。 */
export async function pageText(
  text: string,
  candidates: PagerCommand[],
): Promise<boolean> {
  for (const pager of candidates) {
    try {
      const code = await runPager(pager, text);
      if (code === 0) return true;
    } catch {
      // 外部分页器启动失败：回退内置分页。
    }
  }
  return false;
}

/** 终端显示宽度：CJK / 全角字符按 2 列计。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe10 && c <= 0xfe19) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1f64f) ||
      (c >= 0x1f900 && c <= 0x1f9ff) ||
      (c >= 0x20000 && c <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

/**
 * 从 `start` 起取一页：按**显示高度**算（长行会换行），并给提示行留 2 行。
 * 返回本页行与下一页起点；纯函数，便于单测。
 */
export function takePage(
  lines: string[],
  start: number,
  rows: number,
  columns: number,
): { lines: string[]; next: number } {
  const maxHeight = Math.max(1, rows - 2);
  const width = Math.max(1, columns);
  let height = 0;
  let i = start;
  while (i < lines.length) {
    const lineHeight = Math.max(1, Math.ceil(displayWidth(lines[i]) / width));
    if (height + lineHeight > maxHeight && i > start) break;
    height += lineHeight;
    i += 1;
  }
  return { lines: lines.slice(start, i), next: i };
}

function readKey(): Promise<string> {
  return new Promise((resolve) => {
    const input = process.stdin;
    const wasRaw = input.isRaw ?? false;
    let done = false;
    const finish = (key: string) => {
      if (done) return;
      done = true;
      input.off("data", onData);
      input.off("end", onEnd);
      try {
        input.setRawMode?.(wasRaw);
      } catch {
        // 还原失败也不该把帮助卡住；进程随后正常退出。
      }
      input.pause();
      resolve(key);
    };
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      finish(text.slice(0, 1));
    };
    const onEnd = () => finish("q");
    try {
      input.setRawMode?.(true);
    } catch {
      finish("q");
      return;
    }
    input.resume();
    input.on("data", onData);
    input.once("end", onEnd);
  });
}

/** 内置分页：空格/Enter 下一页，q/Esc/Ctrl+C 退出。 */
export async function pageInternally(text: string): Promise<void> {
  const out = process.stdout;
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    out.write(text);
    return;
  }
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const rows = out.rows ?? 24;
  const columns = out.columns ?? 80;
  const prompt = t("pager.prompt");
  const clearPrompt = "\r" + " ".repeat(displayWidth(prompt) + 4) + "\r";
  let start = 0;
  let quit = false;
  while (start < lines.length) {
    const page = takePage(lines, start, rows, columns);
    out.write(page.lines.join("\n") + "\n");
    start = page.next;
    if (start >= lines.length) break;
    out.write(prompt);
    const key = await readKey();
    out.write(clearPrompt);
    if (key === "q" || key === "Q" || key === "\u0003" || key === "\u001b") {
      quit = true;
      break;
    }
  }
  if (quit) out.write("\n");
}
