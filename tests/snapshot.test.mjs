import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseSnapshotRefs } from "../dist/locator.js";
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
