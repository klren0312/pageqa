/**
 * stdin 转义序列切分的单测。
 *
 * 要守住的不变量只有一条：**每个鼠标事件必须单独成段**。pi-tui 用整串精确匹配识别鼠标
 * （`^...$`），合并在一起的 chunk 会被当成键盘输入丢掉——那正是「滚轮能滚、拖动没反应」
 * 的成因，所以这里逐条钉住切分边界。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { splitTerminalSequences } from "../../dist/tui/input-split.js";

const press = (x, y) => `\x1b[<0;${x};${y}M`;
const drag = (x, y) => `\x1b[<32;${x};${y}M`;
const release = (x, y) => `\x1b[<0;${x};${y}m`;

describe("splitTerminalSequences", () => {
  test("单条序列原样返回一段（不与普通文本粘连）", () => {
    assert.deepEqual(splitTerminalSequences(press(3, 2)), [press(3, 2)]);
  });

  test("一次拖动合并成的 chunk 被拆成按下/拖动/松开三条", () => {
    const chunk = `${press(3, 2)}${drag(5, 2)}${drag(9, 2)}${release(9, 2)}`;
    assert.deepEqual(splitTerminalSequences(chunk), [
      press(3, 2),
      drag(5, 2),
      drag(9, 2),
      release(9, 2),
    ]);
  });

  test("滚轮事件（按钮码带 64 位）也算独立一段", () => {
    const wheel = "\x1b[<64;10;5M";
    assert.deepEqual(splitTerminalSequences(`${wheel}${wheel}`), [wheel, wheel]);
  });

  test("普通文本与序列相邻时互不吞并", () => {
    assert.deepEqual(splitTerminalSequences(`ab${press(1, 1)}cd`), [
      "ab",
      press(1, 1),
      "cd",
    ]);
  });

  test("中文等多字节字符按字符切开，不破坏内容", () => {
    assert.deepEqual(splitTerminalSequences("场景一"), ["场景一"]);
    assert.deepEqual(splitTerminalSequences(`场${press(1, 1)}景`), [
      "场",
      press(1, 1),
      "景",
    ]);
  });

  test("粘贴内容里的正文（含换行）不被当作序列切开", () => {
    const paste = "\x1b[200~## 场景\n一行一步\x1b[201~";
    assert.deepEqual(splitTerminalSequences(paste), ["\x1b[200~", "## 场景\n一行一步", "\x1b[201~"]);
  });

  test("OSC 序列里的正文（如超链接标题）不会被 ESC 误切", () => {
    const link = "\x1b]8;;https://example.com\x07文字\x1b]8;;\x07";
    assert.deepEqual(splitTerminalSequences(link), [
      "\x1b]8;;https://example.com\x07",
      "文字",
      "\x1b]8;;\x07",
    ]);
  });

  test("Alt+键（ESC 加一个字符）是一条两字节序列", () => {
    assert.deepEqual(splitTerminalSequences("\x1bc"), ["\x1bc"]);
  });

  test("chunk 边界截断的序列不吞掉后面的正常文本", () => {
    // 半截 CSI：无法判定终止字节，原样交出去（库会当成键盘输入丢掉，但不会连带吞掉下一段）
    assert.deepEqual(splitTerminalSequences("\x1b[<0;3"), ["\x1b[<0;3"]);
  });

  test("空字符串返回空数组", () => {
    assert.deepEqual(splitTerminalSequences(""), []);
  });
});