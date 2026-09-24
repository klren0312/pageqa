/**
 * bsk 快照瘦身：把长快照裁剪成「可交互/可引用节点 + 关键文本」再喂给模型。
 *
 * 为什么要瘦身：bsk 快照是整棵 aria 树 + 可见文本，长页面一次几千至上万字符。
 * 它同时进入模型上下文与代价最高的位置（每步一次 snapshot，长流程里累积几十次），
 * 直接决定推理时间与「上下文被裁剪/超限」的风险。
 *
 * 瘦身必须**不改变定位**，因此规则是保守的、可解释的：
 * - 带 `@eN` 的行**永不截断**：模型靠它点击，录制/回放两侧的语义定位符也靠它解析 role / name。
 * - `@eN` 行的**祖先链**永不丢弃（祖先路径是同名元素消歧的唯一依据，见 locator.ts）。
 * - 元信息行（`@vom` / `@view` / `@layers` / `L1 page`）保留，很短且能说明页面与视口。
 * - 其余文本行：超长才截断（保留开头）；仍超预算时从最长的非关键行开始省略，
 *   短文本（标题/标签/状态提示）优先保留。
 *   注意：瘦身文本只喂模型上下文；assert_text 的字面匹配用瘦身前完整原文
 *   （tools.ts 的 ensureRawSnapshot），避免长文本被截断造成假未命中。
 * - 原文不超过阈值时**原样返回**：小页面不折腾，避免无谓的行为差异。
 *
 * **同名折叠**（唯一会挪动 `@eN` 行的操作）：上面两条「永不丢弃」让 20k 预算在
 * 可交互元素超过约 210 个的页面上必然击穿（实测 684 元素的 Element Plus 表格页
 * 瘦身后仍 65k 字符，且 100% 是不可再削的关键行）。而这些元素里大量是**同角色同名**
 * 的重复项（表格每行的 "Select this row"、每个 demo 区块的「Edit on GitHub」），
 * 一行一个实在太贵。于是当瘦身后仍超预算时，把同名**叶子**元素折进首行行尾的
 * `[xN: @eA @eB …]` 标记：引用号仍在（仍可寻址），角色/名字一致，
 * 实测 65,437 → 39,012 字符（×0.60）、450 元素页 35,688 → 21,028（×0.59），
 * 且**每个元素的定位符都能折回原引用**（684/684 命中、0 指错）。
 * 折叠只针对「子树里没有其它元素」的叶子 —— 删掉一个还挂着别的元素的容器行，
 * 会连带毁掉那些后代的祖先路径。容器行一律原样保留。
 * 代价要写清楚：成员继承 host 行的祖先路径，跨区域的同名叶子（分属不同行的复选框）
 * 因此失去「按区域消歧」，只能靠同名序号 `nth`。序号本身不会错位
 * （`parseSnapshotRefs` 折叠前后都按 `@eN` 文档序返回，见 locator.ts），
 * 但「同名元素个数变了」这类页面改动会更早让回放置身错位——这是省上下文的对价。
 */
import {
  indentWidth,
  isSnapshotMetaLine,
  parseRoleName,
} from "./locator.js";

/** 原文不超过该长度时原样返回（小页面不折腾）。 */
const SLIM_TRIGGER_CHARS = 8_000;
/** 非关键文本行保留的长度，超出即截断。 */
const TEXT_LINE_MAX = 160;
/** 超预算时非关键行进一步收紧到的长度。 */
const TEXT_LINE_TIGHT = 80;
/** 瘦身后仍允许的最大字符数。 */
const SLIM_BUDGET_CHARS = 20_000;
/** 祖先行保留的长度（承载区域信息，也可能是「整页文本」这种超长可访问名）。 */
const ANCESTOR_LINE_MAX = 160;
/**
 * 祖先行里可访问名的截断长度。
 *
 * 必须大于 locator 的路径名截断长度（`PATH_NAME_MAX = 60`）：祖先路径两侧都取
 * 「前 60 字符」比较，只要截断点在其之后，路径仍完全一致，消歧能力不受影响。
 */
const ANCESTOR_NAME_MAX = 120;

export interface SlimSnapshotResult {
  text: string;
  before: number;
  after: number;
  /** 是否真的做了裁剪（未超阈值、或无需裁剪时为 false，此时 text 与输入相同）。 */
  applied: boolean;
  /** 被截断的长文本行数。 */
  truncatedLines: number;
  /** 因超预算被整行省略的非关键行数。 */
  droppedLines: number;
  /** 因超预算被折叠的同名组数（每组一行 host + 若干成员引用号）。 */
  foldedGroups: number;
  /** 被折进 host 行尾的同名元素数（不含 host 自己）。 */
  foldedRefs: number;
}

type LineKind = "meta" | "ref" | "text" | "empty";

interface Line {
  raw: string;
  body: string;
  indent: number;
  kind: LineKind;
  /** 关键行：可交互/可引用节点、其祖先链、元信息行——一律保留。 */
  keep: boolean;
  /** ref 行的引用号（如 `@e12`），其余行为 null。 */
  ref: string | null;
  role: string;
  name: string;
}

interface Rendered {
  line: Line;
  text: string;
}

/** 一组同名折叠：host 行下标 + 被折成员（含 host）的总数与引用号列表。 */
interface FoldPlan {
  drop: Set<number>;
  hosts: Map<number, string[]>;
}

const NO_FOLD: FoldPlan = { drop: new Set(), hosts: new Map() };

function classify(raw: string): Line {
  const body = raw.trim();
  const base = { raw, body };
  if (!body) {
    return { ...base, indent: 0, kind: "empty", keep: false, ref: null, role: "", name: "" };
  }
  const indent = indentWidth(raw);
  if (isSnapshotMetaLine(body)) {
    return { ...base, indent, kind: "meta", keep: true, ref: null, ...parseRoleName(body) };
  }
  const refMatch = body.match(/^@(e\d+)\b\s*(.*)$/);
  if (refMatch) {
    return {
      ...base,
      indent,
      kind: "ref",
      keep: true,
      ref: "@" + refMatch[1],
      ...parseRoleName(refMatch[2]),
    };
  }
  return { ...base, indent, kind: "text", keep: false, ref: null, ...parseRoleName(body) };
}

/**
 * 祖先行截断：保留缩进与 role，name 截断后**重建引号结构**。
 *
 * 直接按字符 slice 会把 name 的闭合引号切掉，`parseRoleName` 便取不到名字
 * （它的正则需要成对引号），这一层的祖先路径会凭空消失——同名元素消歧能力随之下降。
 */
function clipAncestor(line: Line): string {
  const indent = line.raw.slice(0, line.raw.length - line.raw.trimStart().length);
  const { role, name } = parseRoleName(line.body);
  if (!name) return `${line.raw.slice(0, ANCESTOR_LINE_MAX)}…`;
  const clipped =
    name.length > ANCESTOR_NAME_MAX
      ? name.slice(0, ANCESTOR_NAME_MAX) + "…"
      : name;
  return `${indent}${role ? role + " " : ""}${JSON.stringify(clipped)}`;
}

/** 该行子树里是否还挂着**别组**的 ref（是则不能删这行，会毁掉后代的祖先路径）。 */
function hasForeignRefBelow(lines: Line[], index: number, group: Set<number>): boolean {
  for (let j = index + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.kind === "empty") continue;
    if (l.indent <= lines[index].indent) return false;
    if (l.kind === "ref" && !group.has(j)) return true;
  }
  return false;
}

/**
 * 制定同名折叠计划：按 `role + name` 全局分组，同名叶子折进首组第一行。
 *
 * 只在「瘦身后仍超预算」时调用，所以小页面完全不受影响。
 * 跨区块也合并（而不是只并兄弟节点）是实测的选择：表格页每行的 "Select this row"
 * 分属不同 `<tr>`，按兄弟分组几乎折不动（42k），全局折叠才能到 39k。
 */
function planFolding(lines: Line[]): FoldPlan {
  const groups = new Map<string, number[]>();
  lines.forEach((line, i) => {
    if (line.kind !== "ref" || !line.ref) return;
    // 没有角色也没有名字的引用行：折不进任何组，也无从按名解析，原样保留
    if (!line.role && !line.name) return;
    const key = line.role + "\u0000" + line.name;
    const bucket = groups.get(key);
    if (bucket) bucket.push(i);
    else groups.set(key, [i]);
  });

  const drop = new Set<number>();
  const hosts = new Map<number, string[]>();
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    const group = new Set(idxs);
    const leaves = idxs.filter((i) => !hasForeignRefBelow(lines, i, group));
    if (leaves.length < 2) continue;
    const [host, ...members] = leaves;
    for (const i of members) drop.add(i);
    hosts.set(
      host,
      leaves.map((i) => lines[i].ref as string),
    );
  }
  return { drop, hosts };
}

/** 统计渲染后文本的总字符数（含行间换行，用于预算判断）。 */
function totalChars(items: Rendered[]): number {
  return items.reduce((n, i) => n + i.text.length + 1, 0);
}

/** 按瘦身规则渲染每一行：关键行保留，其余超长截断；折叠成员并入 host 行尾。 */
function renderLines(lines: Line[], fold: FoldPlan): { items: Rendered[]; truncated: number } {
  let truncated = 0;
  const items: Rendered[] = [];
  lines.forEach((line, i) => {
    if (line.kind === "empty" || fold.drop.has(i)) return;
    let rendered = line.raw;
    if (line.kind === "ref") {
      // 可交互节点行原样保留：模型靠它点击，任何截断都可能让 name 与页面失配
      const members = fold.hosts.get(i);
      if (members) {
        rendered = `${line.raw} [x${members.length}: ${members.slice(1).join(" ")}]`;
      }
    } else if (line.raw.length > (line.keep ? ANCESTOR_LINE_MAX : TEXT_LINE_MAX)) {
      if (line.keep) {
        rendered = clipAncestor(line);
      } else {
        truncated += 1;
        rendered = `${line.raw.slice(0, TEXT_LINE_MAX)}…（已截断 ${
          line.raw.length - TEXT_LINE_MAX
        } 字符）`;
      }
    }
    items.push({ line, text: rendered });
  });
  return { items, truncated };
}

/** 预算兜底：先收紧非关键长行，再从最长的非关键行开始整行省略。 */
function fitBudget(items: Rendered[]): { tightened: number; dropped: number } {
  let tightened = 0;
  let dropped = 0;
  let total = totalChars(items);
  if (total > SLIM_BUDGET_CHARS) {
    for (const item of items) {
      if (item.line.keep || item.text.length <= TEXT_LINE_TIGHT) continue;
      item.text = item.text.slice(0, TEXT_LINE_TIGHT) + "…";
      tightened += 1;
    }
    total = totalChars(items);
  }
  if (total > SLIM_BUDGET_CHARS) {
    const droppable = items
      .filter((i) => !i.line.keep)
      .sort((a, b) => b.text.length - a.text.length);
    for (const item of droppable) {
      if (total <= SLIM_BUDGET_CHARS) break;
      total -= item.text.length + 1;
      item.text = "";
      dropped += 1;
    }
  }
  return { tightened, dropped };
}

/** 跑一遍完整瘦身规则（折叠是其中唯一可选的一档）。 */
function slimPass(lines: Line[], fold: FoldPlan) {
  const { items, truncated } = renderLines(lines, fold);
  const budget = fitBudget(items);
  return { items, truncated: truncated + budget.tightened, dropped: budget.dropped };
}

/**
 * 瘦身快照。纯函数：不依赖 bsk、不触碰网络，便于单测。
 */
export function slimSnapshot(text: string): SlimSnapshotResult {
  const before = text.length;
  const untouched: SlimSnapshotResult = {
    text,
    before,
    after: before,
    applied: false,
    truncatedLines: 0,
    droppedLines: 0,
    foldedGroups: 0,
    foldedRefs: 0,
  };
  if (before <= SLIM_TRIGGER_CHARS) return untouched;

  const lines = text.split(/\r?\n/).map(classify);

  // 标记关键行：ref 行本身保留，并把它所在的祖先链一并保留。
  // 祖先链是「这个元素在哪个区域下」的唯一来源，丢了它，同名元素只能靠序号猜。
  const stack: Line[] = [];
  for (const line of lines) {
    if (line.kind === "empty") continue;
    while (stack.length > 0 && stack[stack.length - 1].indent >= line.indent) {
      stack.pop();
    }
    if (line.kind === "ref") for (const ancestor of stack) ancestor.keep = true;
    stack.push(line);
  }

  let { items, truncated, dropped } = slimPass(lines, NO_FOLD);
  let foldedGroups = 0;
  let foldedRefs = 0;

  // 常规瘦身仍然超预算 —— 说明剩下的全是不可再削的关键行，只能对 `@eN` 行下手
  if (totalChars(items) > SLIM_BUDGET_CHARS) {
    const fold = planFolding(lines);
    if (fold.hosts.size > 0) {
      // 从原文重跑一遍：折叠与截断/省略是同一套规则，只是多了一份折叠计划
      ({ items, truncated, dropped } = slimPass(lines, fold));
      foldedGroups = fold.hosts.size;
      foldedRefs = fold.drop.size;
    }
  }

  // 没有任何实质裁剪时保持原文（含空行），不做无意义的改写
  if (truncated === 0 && dropped === 0 && foldedGroups === 0) return untouched;

  const body = items
    .filter((i) => i.text)
    .map((i) => i.text)
    .join("\n");
  const after = body.length;
  // 末尾写明做了什么：模型据此知道「哪些内容没看到」，而不是以为页面就这么点内容
  const notice =
    `[pageqa] 快照已瘦身：${before} → ${after} 字符` +
    `（截断 ${truncated} 处长文本、省略 ${dropped} 行非关键文本` +
    (foldedRefs
      ? `、${foldedRefs} 个同名元素折进所在组首行的 [xN: @eA @eB …] 标记`
      : "") +
    `；可交互元素的引用号全部保留、均可按 @eN 寻址，纯文本内容可能不完整）`;
  return {
    text: `${body}\n${notice}`,
    before,
    after,
    applied: true,
    truncatedLines: truncated,
    droppedLines: dropped,
    foldedGroups,
    foldedRefs,
  };
}
