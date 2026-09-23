import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  OVERLAY_INSET,
  frameLines,
  overlayInnerWidth,
} from "../dist/tui/overlay-frame.js";

/** 去掉着色码，只留可见文本（主题在测试环境下默认着色）。 */
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** 可见宽度：CJK 与 box-drawing 之外按 1 列算，够用即可。 */
const width = (s) =>
  [...strip(s)].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);

/**
 * 测试替身：与 pi-tui 的 `truncateToWidth` 同形的简化版（不处理 ANSI 与宽字符，
 * 因为 frameLines 只要求它「按内宽截断并补齐」）。
 */
const truncate = (text, maxWidth, ellipsis = "…", pad = false) => {
  // 省略号也算在 maxWidth 里（与 pi-tui 的 truncateToWidth 一致）。
  const out =
    text.length > maxWidth
      ? text.slice(0, Math.max(0, maxWidth - ellipsis.length)) + ellipsis
      : text;
  return pad ? out + " ".repeat(Math.max(0, maxWidth - out.length)) : out;
};

describe("浮层外框 frameLines", () => {
  test("每个内容行都被补齐到浮层宽度（不透出底下的日志）", () => {
    // 内容用 ASCII：宽字符的补齐是注入的 truncateToWidth 的职责（替身只按字符数算）。
    const lines = frameLines(["title", "s", ""], 40, truncate);
    assert.equal(lines.length, 5); // 3 行内容 + 上下边框
    for (const line of lines) assert.equal(width(line), 40);
  });

  test("上下是边框，内容行两侧是竖线且内容原样保留", () => {
    const lines = frameLines(["A"], 20, truncate).map(strip);
    assert.equal(lines[0], "╭" + "─".repeat(18) + "╮");
    assert.ok(lines[1].startsWith("│") && lines[1].endsWith("│"));
    assert.ok(lines[1].includes("A"));
    assert.equal(lines[2], "╰" + "─".repeat(18) + "╯");
  });

  test("超宽内容按内宽截断，不会顶破右边框", () => {
    const lines = frameLines(["x".repeat(200)], 30, truncate);
    assert.equal(width(lines[1]), 30);
    assert.ok(strip(lines[1]).endsWith("│"));
  });

  test("内宽 = 浮层宽 - 边框与内边距；极窄时至少留 1 列", () => {
    assert.equal(overlayInnerWidth(40), 40 - OVERLAY_INSET * 2);
    assert.equal(overlayInnerWidth(3), 1);
  });

  test("浮层宽度被压到极小时仍成对输出边框", () => {
    const lines = frameLines(["abc"], 4, truncate).map(strip);
    assert.equal(lines.length, 3);
    assert.ok(lines[0].startsWith("╭") && lines[0].endsWith("╮"));
    assert.ok(lines[2].startsWith("╰") && lines[2].endsWith("╯"));
  });
});
