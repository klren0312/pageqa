/**
 * 原型 · ref 行瘦身：真代码验收（不需要浏览器、不调模型）
 *
 *   node docs/prototype/ref-slim.verify.mjs
 *
 * 对 docs/prototype/corpus/*.txt（真实抓的 bsk 快照）逐份检查：
 * 1) 瘦身后可寻址元素数不变（一个 @eN 都不许丢）；
 * 2) 每个元素「用原文建定位符 -> 在瘦身后文本里解析」必须回到自己（0 指错 / 0 未命中）；
 * 3) 字符收益。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { slimSnapshot } from "../../dist/snapshot.js";
import { buildLocator, parseSnapshotRefs, resolveLocator } from "../../dist/locator.js";

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = ["element-plus-table.txt", "element-plus-form.txt", "smoke-page.txt"];

let bad = 0;
for (const file of CORPUS) {
  const raw = readFileSync(join(here, "corpus", file), "utf8").replace(/\r\n/g, "\n");
  const slim = slimSnapshot(raw);
  const want = parseSnapshotRefs(raw);
  const got = parseSnapshotRefs(slim.text);
  const items = [];
  const seen = new Set();
  for (const r of want) {
    if (seen.has(r.ref)) continue;
    seen.add(r.ref);
    items.push({ ref: r.ref, loc: buildLocator(r.ref, raw) });
  }
  let drift = 0;
  let miss = 0;
  for (const it of items) {
    const hit = resolveLocator(it.loc, slim.text);
    if (hit === it.ref) continue;
    if (hit === null) miss++;
    else drift++;
  }
  const cnt = (v) => (v ? `  ${v}` : "");
  const ok = drift === 0 && miss === 0 && got.length === want.length;
  if (!ok) bad++;
  console.log(
    `${ok ? "✓" : "✗"} ${file.padEnd(24)} ` +
      `${String(raw.length).padStart(7)} -> ${String(slim.after).padStart(7)} 字符` +
      `（折叠 ${slim.foldedGroups} 组 / ${slim.foldedRefs} 成员，截断 ${slim.truncatedLines}，省略 ${slim.droppedLines}）` +
      `  ref ${want.length} -> ${got.length}${cnt(drift ? `指错 ${drift}` : "")}${cnt(miss ? `未命中 ${miss}` : "")}`,
  );
}
console.log(bad ? `\n${bad} 份语料未通过` : "\n全部通过：瘦身未改变任何元素的定位");
process.exit(bad ? 1 : 0);
