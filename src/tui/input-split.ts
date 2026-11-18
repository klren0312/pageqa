/**
 * 把一次 stdin 读取拆成单条转义序列。
 *
 * pi-tui 识别鼠标事件用的是**整串精确匹配**（`/^\x1b\[<\d+;\d+;\d+[Mm]$/`，见
 * `tui-alt-screen.js` 的 `parseSgrMouseEvent`）。终端在一次快速拖动里会把好几个事件合并进
 * 同一个 chunk 送上来，整串不匹配就被当成键盘输入丢掉，`handleMouseEvent` 根本不会被调用：
 * 表现是「滚轮能滚（低频、单条），拖动完全没反应，而且连按下都收不到」。
 *
 * 键盘与粘贴不受影响：非序列文本按原样合并成一段，`\x1b[200~…\x1b[201~` 里的正文不会被切开。
 *
 * 纯函数，便于单测（语义见 `tests/tui/input-split.test.mjs`）。
 */
export function splitTerminalSequences(data: string): string[] {
  const parts: string[] = [];
  let plain = "";
  const takePlain = (): void => {
    if (plain.length > 0) {
      parts.push(plain);
      plain = "";
    }
  };

  let i = 0;
  while (i < data.length) {
    if (data.charCodeAt(i) !== 0x1b) {
      plain += data[i];
      i += 1;
      continue;
    }
    takePlain();
    const kind = data[i + 1];
    // X10 鼠标：`ESC [ M` + 3 个字节。它的终止字节不是标准 CSI 终字符，必须按定长切。
    if (kind === "[" && data[i + 2] === "M") {
      const end = Math.min(data.length, i + 6);
      parts.push(data.slice(i, end));
      i = end;
      continue;
    }
    if (kind === "[") {
      // CSI：参数字节 0x30-0x3F、中间字节 0x20-0x2F，终止字节 0x40-0x7E。
      let j = i + 2;
      while (j < data.length) {
        const code = data.charCodeAt(j);
        if (code >= 0x40 && code <= 0x7e) break;
        j += 1;
      }
      // chunk 边界把序列截断了：原样交出去（保持库原有的「认不出就丢掉」行为，不吞后面
      // 的正常文本）。
      if (j >= data.length) {
        parts.push(data.slice(i));
        i = data.length;
        continue;
      }
      parts.push(data.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (kind === "]") {
      // OSC：以 BEL 或 ST（`ESC \`）结束，里面可以含任意文本（剪贴板、超链接标题）。
      let j = i + 2;
      let end = -1;
      while (j < data.length) {
        if (data[j] === "\x07") {
          end = j + 1;
          break;
        }
        if (data[j] === "\x1b" && data[j + 1] === "\\") {
          end = j + 2;
          break;
        }
        j += 1;
      }
      if (end < 0) {
        parts.push(data.slice(i));
        i = data.length;
        continue;
      }
      parts.push(data.slice(i, end));
      i = end;
      continue;
    }
    // 孤立 ESC 或 `ESC` + 一个字符（Alt+键）：两字节即一条。
    if (kind === undefined) {
      parts.push(data.slice(i));
      i = data.length;
      continue;
    }
    parts.push(data.slice(i, i + 2));
    i += 2;
  }

  takePlain();
  return parts;
}