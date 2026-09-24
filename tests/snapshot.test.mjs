import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildLocator,
  parseSnapshotRefs,
  resolveLocator,
} from "../dist/locator.js";
import { slimSnapshot } from "../dist/snapshot.js";

// 纯单元测试：只依赖 dist/*，不需要 bsk / LLM。
//
// 瘦身的最高优先级不是「省了多少字符」，而是**不改变定位**：
// 只要「@eN 行 + 祖先链」在瘦身后解析出的 role/name/path 与原文完全一致，
// 录制与回放两侧的语义定位符就不受影响。

const SMALL_SNAPSHOT = [
  "@vom 1",
  "@view 1406x834",
  "@layers 1 focus=L1",
  "L1 page",
  '  RootWebArea "Example Domain"',
  '    heading "Example Domain"',
  '      StaticText "Example Domain"',
  "    paragraph",
  '      @e1 link "Learn more" [→ iana.org]',
].join("\n");

/** 生成一段超过瘦身阈值（8000 字符）的长页面快照。 */
function bigSnapshot({ fillerLines = 30, fillerLen = 300 } = {}) {
  const unit = "这是一段很长的可见文本。";
  const filler = unit.repeat(Math.ceil(fillerLen / unit.length));
  const lines = [
    "@vom 1",
    "@view 1406x834",
    "@layers 1 focus=L1",
    "L1 page",
    '  RootWebArea "Example Domain"',
  ];
  for (let i = 0; i < fillerLines; i++) {
    lines.push(`    textblock "第 ${i} 段 ${filler}"`);
  }
  lines.push("    paragraph");
  lines.push('      @e1 link "Learn more" [→ iana.org]');
  return lines.join("\n");
}

describe("快照瘦身（slimSnapshot）", () => {
  test("小快照原样返回，不做无谓改写", () => {
    const r = slimSnapshot(SMALL_SNAPSHOT);
    assert.equal(r.applied, false);
    assert.equal(r.text, SMALL_SNAPSHOT);
    assert.equal(r.truncatedLines, 0);
    assert.equal(r.droppedLines, 0);
    assert.equal(r.foldedGroups, 0);
    assert.equal(r.foldedRefs, 0);
  });

  test("瘦身后可交互节点与祖先链不变（定位不受影响）", () => {
    const raw = bigSnapshot();
    const r = slimSnapshot(raw);
    assert.equal(r.applied, true);
    assert.ok(r.after < r.before, `应显著变短：${r.before} -> ${r.after}`);
    // 关键保证：解析出的 refs（role/name/祖先路径）与原文完全一致
    assert.deepEqual(parseSnapshotRefs(r.text), parseSnapshotRefs(raw));
  });

  test("超长文本行被截断，并注明截断长度", () => {
    const raw = bigSnapshot();
    const r = slimSnapshot(raw);
    assert.match(r.text, /…（已截断 \d+ 字符）/);
    assert.ok(r.truncatedLines > 0);
    // 最长的那批文本行已不再是原样
    const longest = raw
      .split("\n")
      .reduce((a, b) => (b.length > a.length ? b : a), "");
    assert.ok(!r.text.includes(longest));
  });

  test("空行被省略（无语义，只占上下文）", () => {
    const raw = bigSnapshot().replace(
      '  RootWebArea "Example Domain"',
      '  RootWebArea "Example Domain"\n\n\n',
    );
    const r = slimSnapshot(raw);
    assert.ok(!/\n\s*\n/.test(r.text.split("[pageqa]")[0]));
  });

  test("超长祖先行截断后仍保留角色与可访问名（祖先路径不变）", () => {
    const longName = "整页文本".repeat(400); // 远超祖先名的保留长度
    const raw = [
      "@vom 1",
      "@view 1406x834",
      "L1 page",
      `  main "${longName}"`,
      ...Array.from(
        { length: 20 },
        () => `    textblock "${"补充说明".repeat(100)}"`,
      ),
      "    paragraph",
      '      @e1 button "确 定"',
    ].join("\n");
    assert.ok(raw.length > 8_000, "用例本身要超过瘦身阈值");
    const r = slimSnapshot(raw);
    assert.deepEqual(parseSnapshotRefs(r.text), parseSnapshotRefs(raw));
    assert.match(r.text, /main "/);
  });

  test("可交互节点行永不截断（哪怕它的可访问名极长）", () => {
    const hugeName = "长按钮名".repeat(200);
    const raw = [
      "@vom 1",
      "@view 1406x834",
      "L1 page",
      '  RootWebArea "Example Domain"',
      ...Array.from(
        { length: 40 },
        () => `    textblock "${"无关文本".repeat(80)}"`,
      ),
      "    paragraph",
      `      @e2 button "${hugeName}"`,
    ].join("\n");
    const r = slimSnapshot(raw);
    assert.ok(r.text.includes(hugeName), "@eN 行必须原样保留，否则模型点不到该元素");
    assert.deepEqual(parseSnapshotRefs(r.text), parseSnapshotRefs(raw));
  });

  test("超预算时省略非关键长文本，但可交互节点与祖先链仍完整", () => {
    const raw = bigSnapshot({ fillerLines: 300, fillerLen: 1000 });
    const r = slimSnapshot(raw);
    assert.ok(r.droppedLines > 0, "应触发整行省略");
    assert.ok(r.after < r.before);
    assert.deepEqual(parseSnapshotRefs(r.text), parseSnapshotRefs(raw));
  });

  test("末尾注明瘦身情况，让模型知道有些内容没看到", () => {
    const r = slimSnapshot(bigSnapshot());
    assert.match(r.text, /\[pageqa\] 快照已瘦身：\d+ → \d+ 字符/);
  });
});

/**
 * 同名折叠：瘦身后仍超预算时，把同角色同名的**叶子**元素折进首行行尾的
 * `[xN: @eA @eB …]`，一行换成一格。
 *
 * 这里守的是折叠的唯一底线：引用号一个都不能丢，且每个元素的定位符
 * 折前折后都指回自己（`@eN` 编号即文档序，同名序号因此不会错位）。
 */

/** 一张「每行一个同名复选框」的长表格：rows 行足够撑破 20k 预算。 */
function tableSnapshot(rows) {
  const lines = [
    "@vom 1",
    "@view 1406x834",
    "L1 page",
    '  RootWebArea "Data table"',
  ];
  for (let i = 1; i <= rows; i++) {
    lines.push("    row", `      @e${i} checkbox "Select this row"`);
  }
  return lines.join("\n");
}

describe("同名折叠（超预算时的最后一档）", () => {
  test("预算还够就不折：重复元素也一行一个原样留着", () => {
    const raw = tableSnapshot(200); // 每行 ~46 字符：9k 原文，关键行远未破 20k
    assert.ok(raw.length > 8_000, "用例本身要超过瘦身阈值");
    const r = slimSnapshot(raw);
    assert.equal(r.foldedGroups, 0);
    assert.equal(r.foldedRefs, 0);
    assert.deepEqual(parseSnapshotRefs(r.text), parseSnapshotRefs(raw));
  });

  test("超预算才折：同名叶子并进首行，行数与字符数显著下降", () => {
    const raw = tableSnapshot(600); // 27k 全是不可再削的关键行，必然破 20k 预算
    const r = slimSnapshot(raw);
    assert.ok(r.foldedRefs > 0, "应触发折叠");
    assert.equal(r.foldedGroups, 1, "全部同名，只应有一组");
    assert.match(r.text, /\[x600: @e2 @e3 /);
    assert.ok(r.after < 20_000, `折完应回到预算内：${r.after}`);
    // 成员行消失，但引用号仍在（在 host 行尾）
    assert.ok(!/^      @e7 checkbox/m.test(r.text));
    assert.equal(parseSnapshotRefs(r.text).length, 600);
  });

  test("折叠不改定位：每个元素的定位符都指回自己（含同名序号）", () => {
    const raw = tableSnapshot(600);
    const slim = slimSnapshot(raw).text;
    for (const ref of parseSnapshotRefs(raw)) {
      const loc = buildLocator(ref.ref, raw);
      assert.equal(
        resolveLocator(loc, slim),
        ref.ref,
        `${ref.ref}（第 ${loc.nth + 1} 个同名）在折叠后的快照里指错了`,
      );
    }
  });

  test("挂着别的元素的容器行不折：删它会毁掉后代的祖先路径", () => {
    const lines = ["@vom 1", "@view 1406x834", "L1 page", '  RootWebArea "x"'];
    let n = 0;
    for (let i = 0; i < 400; i++) {
      // 每行：同名容器（button "展开"）+ 它自己的孩子（link "详情"）
      lines.push(`    @e${++n} button "展开"`, `      @e${++n} link "详情" [→ a.com]`);
      lines.push(`    textblock "${"填充文本".repeat(30)}"`);
    }
    const raw = lines.join("\n");
    const r = slimSnapshot(raw);
    // 两组都超预算，但「展开」每个都挂着后代，只能折叶子「详情」
    assert.equal(r.foldedGroups, 1);
    assert.match(r.text, /\[x400: @e\d+ @e\d+ /);
    assert.ok(/^    @e1 button "展开"$/m.test(r.text), "容器行必须原样保留");
    assert.ok(
      !/^      @e4 link "详情"/m.test(r.text),
      "叶子成员应折进 host 行，不再独占一行",
    );
    assert.equal(parseSnapshotRefs(r.text).length, 800);
    for (const ref of parseSnapshotRefs(raw)) {
      assert.equal(
        resolveLocator(buildLocator(ref.ref, raw), r.text),
        ref.ref,
        `${ref.ref} 定位改变`,
      );
    }
  });

  test("末尾注明折叠了多少成员，模型才知道有元素被并走了", () => {
    const r = slimSnapshot(tableSnapshot(600));
    // 只取末行比对：整段快照太大，失败时刷屏
    const notice = r.text.split("\n").at(-1);
    assert.match(notice, /599 个同名元素折进所在组首行的 \[xN: @eA @eB …\] 标记/);
    assert.match(notice, /引用号全部保留、均可按 @eN 寻址/);
  });
});
