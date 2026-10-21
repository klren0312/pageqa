import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  displayWidth,
  pageText,
  pagerCandidates,
  shouldPage,
  takePage,
} from "../../dist/help-pager.js";

describe("帮助分页器", () => {
  test("只在 TTY 且未禁用时分页", () => {
    assert.equal(shouldPage(true, false, {}), true);
    assert.equal(shouldPage(false, false, {}), false);
    assert.equal(shouldPage(true, true, {}), false);
    assert.equal(shouldPage(true, false, { PAGEQA_NO_PAGER: "1" }), false);
  });

  test("只有显式 PAGER 才用外部分页器", () => {
    assert.deepEqual(pagerCandidates({}), []);
    assert.deepEqual(pagerCandidates({ PAGER: "less -R" }), [
      { command: "less -R", args: [], shell: true },
    ]);
    assert.deepEqual(pagerCandidates({ PAGER: "   " }), []);
  });

  test("外部分页器不可用时回退失败", async () => {
    const paged = await pageText("hello\n", [
      { command: "__pageqa_missing_pager__", args: [] },
    ]);
    assert.equal(paged, false);
  });

  test("外部 PAGER 可用时写完文本后返回成功", async () => {
    const paged = await pageText("hello\n", [
      { command: process.execPath, args: ["-e", "process.exit(0)"] },
    ]);
    assert.equal(paged, true);
  });

  test("显示宽度：CJK 占两列", () => {
    assert.equal(displayWidth("abc"), 3);
    assert.equal(displayWidth("中文"), 4);
    assert.equal(displayWidth("A中B"), 4);
  });

  test("按显示高度分页：给提示行留两行，长行按换行计高", () => {
    assert.deepEqual(takePage(["a", "b", "c", "d"], 0, 4, 80), {
      lines: ["a", "b"],
      next: 2,
    });
    assert.deepEqual(takePage(["a", "b", "c", "d"], 2, 4, 80), {
      lines: ["c", "d"],
      next: 4,
    });
    // 160 个 ASCII 字符在 80 列里占两行；maxHeight=2 时一页只放这一行。
    assert.deepEqual(takePage(["x".repeat(160), "after"], 0, 4, 80), {
      lines: ["x".repeat(160)],
      next: 1,
    });
    // 40 个 CJK 字符正好 80 列，占一行。
    assert.deepEqual(takePage(["中".repeat(40), "next"], 0, 3, 80), {
      lines: ["中".repeat(40)],
      next: 1,
    });
  });
});
