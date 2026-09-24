/**
 * 原型 · ref 行瘦身：构建 + 离线判决（不需要浏览器、不调模型）
 *
 *   node docs/prototype/ref-slim.build.mjs
 *
 * 1) 把 docs/prototype/corpus/*.txt（真实抓的 bsk 快照）注进模板，产出可直接双击打开的
 *    ref-slim.prototype.html。
 * 2) 从模板里抽出「纯逻辑模块」，在 Node 里跑完整策略矩阵，打印字符收益与定位符命中判决。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { slimSnapshot } from "../../dist/snapshot.js";

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = [
  ["element-plus Table（重 · 684 引用）", "element-plus-table.txt"],
  ["element-plus Form（中 · 450 引用）", "element-plus-form.txt"],
  ["冒烟页（本地 · 轻）", "smoke-page.txt"],
];

const tplPath = join(here, "ref-slim.prototype.tpl.html");
const tpl = readFileSync(tplPath, "utf8");

const data = {};
for (const [name, file] of CORPUS) {
  const raw = readFileSync(join(here, "corpus", file), "utf8").replace(/\r\n/g, "\n");
  data[name] = { raw, prodChars: slimSnapshot(raw).after };
}

// ---- 注入数据，产出可双击的 HTML ----
const marker = "window.SNAPS = __DATA__;";
if (!tpl.includes(marker)) throw new Error("模板里找不到数据注入点");
writeFileSync(join(here, "ref-slim.prototype.html"), tpl.replace(marker, "window.SNAPS = " + JSON.stringify(data) + ";"), "utf8");
console.log("已生成 ref-slim.prototype.html（双击即可，数据已内联）\n");

// ---- 抽出纯模块，离线跑判决矩阵 ----
const between = tpl.slice(tpl.indexOf("// ===== BEGIN PURE MODULE")).split("// ===== END PURE MODULE")[0];
const P = new Function(between + "\n;return PROTO_API;")();

const COMBOS = [
  ["现状（复刻生产规则）", []],
  ["①折叠·同区块", ["foldRegion"]],
  ["①+③剥标注", ["foldRegion", "ctx"]],
  ["②折叠·跨区块", ["foldGlobal"]],
  ["②+③剥标注", ["foldGlobal", "ctx"]],
  ["②+③+④补路径", ["foldGlobal", "ctx", "path"]],
  ["②+③+⑤降级(丢引用号)", ["foldGlobal", "ctx", "degrade"]],
  ["②+③+⑤+⑥压块 @20k", ["foldGlobal", "ctx", "degrade", "dropGroups"]],
];
const BUDGETS = [20000, 40000];

for (const [name, file] of CORPUS) {
  const raw = data[name].raw;
  const items = [];
  const seen = new Set();
  for (const r of P.parseRefs(raw)) {
    if (seen.has(r.ref)) continue;
    seen.add(r.ref);
    items.push({ loc: P.buildLocator(r.ref, raw), want: r.ref });
  }
  const cnt = {};
  for (const it of items) cnt[it.loc.role + "\u0000" + it.loc.name] = (cnt[it.loc.role + "\u0000" + it.loc.name] || 0) + 1;
  for (const it of items) it.dup = cnt[it.loc.role + "\u0000" + it.loc.name] > 1;
  console.log(`\n### ${name}  原始 ${raw.length.toLocaleString()} 字符 / ${items.length} 个可寻址元素 / 生产实测瘦身 ${data[name].prodChars.toLocaleString()}`);
  console.log("策略".padEnd(24) + "字符".padStart(9) + "  vs生产瘦身".padStart(12) + "  ref行".padStart(7) + "  可寻址".padStart(7) + "   命中/指错/未命中   同名组命中   @20k @40k");
  for (const [label, stages] of COMBOS) {
    const r = P.slim(raw, new Set(stages), 20_000);
    const r40 = P.slim(raw, new Set(stages), 40_000);
    for (const it of items) {
      const got = P.resolveLocator(it.loc, r.text);
      it.v = got === it.want ? "hit" : got === null ? "miss" : "drift";
    }
    const g = (v, a = items) => a.filter((i) => i.v === v).length;
    const dup = items.filter((i) => i.dup);
    const prod = data[name].prodChars;
    console.log(
      label.padEnd(22) + r.chars.toLocaleString().padStart(9) +
      ("×" + (prod ? (r.chars / prod).toFixed(2) : "-")).padStart(12) +
      String(r.refLines).padStart(8) + String(r.refs).padStart(9) +
      `   ${String(g("hit")).padStart(4)}/${String(g("drift")).padStart(3)}/${String(g("miss")).padStart(3)}` +
      `        ${(dup.length ? (100 * g("hit", dup) / dup.length).toFixed(1) : "100.0")}%` +
      `      ${r.chars <= 20000 ? "✓" : "✗"}   ${r40.chars <= 40000 ? "✓" : "✗"}`,
    );
  }
}
