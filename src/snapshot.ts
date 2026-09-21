/**
 * bsk 快照瘦身：把长快照裁剪成「可交互/可引用节点 + 关键文本」再喂给模型。
 *
 * 为什么要瘦身：bsk 快照是整棵 aria 树 + 可见文本，长页面一次几千至上万字符。
 * 它同时进入模型上下文与代价最高的位置（每步一次 snapshot，长流程里累积几十次），
 * 直接决定推理时间与「上下文被裁剪/超限」的风险。
 *
 * 瘦身必须**不改变定位**，因此规则是保守的、可解释的：
 * - 带 `@eN` 的行**永不截断、永不丢弃**：模型靠它点击，录制/回放两侧的语义定位符
 *   也靠它解析 role / name。
 * - `@eN` 行的**祖先链**永不丢弃（祖先路径是同名元素消歧的唯一依据，见 locator.ts）。
 * - 元信息行（`@vom` / `@view` / `@layers` / `L1 page`）保留，很短且能说明页面与视口。
 * - 其余文本行：超长才截断（保留开头）；仍超预算时从最长的非关键行开始省略，
 *   短文本（标题/标签/状态提示）优先保留。
 *   注意：瘦身文本只喂模型上下文；assert_text 的字面匹配用瘦身前完整原文
 *   （tools.ts 的 ensureRawSnapshot），避免长文本被截断造成假未命中。
 * - 原文不超过阈值时**原样返回**：小页面不折腾，避免无谓的行为差异。
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
}

type LineKind = "meta" | "ref" | "text" | "empty";

interface Line {
  raw: string;
  body: string;
  indent: number;
  kind: LineKind;
  /** 关键行：可交互/可引用节点、其祖先链、元信息行——一律保留。 */
  keep: boolean;
}

interface Rendered {
  line: Line;
  text: string;
}

function classify(raw: string): Line {
  const body = raw.trim();
  if (!body) return { raw, body, indent: 0, kind: "empty", keep: false };
  const indent = indentWidth(raw);
  if (isSnapshotMetaLine(body)) {
    return { raw, body, indent, kind: "meta", keep: true };
  }
  if (/^@e\d+\b/.test(body)) {
    return { raw, body, indent, kind: "ref", keep: true };
  }
  return { raw, body, indent, kind: "text", keep: false };
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

/** 统计渲染后文本的总字符数（含行间换行，用于预算判断）。 */
function totalChars(items: Rendered[]): number {
  return items.reduce((n, i) => n + i.text.length + 1, 0);
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
  };
  if (before <= SLIM_TRIGGER_CHARS) return untouched;

  const lines = text.split(/\r?\n/).map(classify);

  // 1) 标记关键行：ref 行本身保留，并把它所在的祖先链一并保留。
  //    祖先链是「这个元素在哪个区域下」的唯一来源，丢了它，同名元素只能靠序号猜。
  const stack: Line[] = [];
  for (const line of lines) {
    if (line.kind === "empty") continue;
    while (stack.length > 0 && stack[stack.length - 1].indent >= line.indent) {
      stack.pop();
    }
    if (line.kind === "ref") for (const ancestor of stack) ancestor.keep = true;
    stack.push(line);
  }

  // 2) 渲染：关键行保留；其余行超长即截断（保留开头，断言目标通常很短）。
  let truncated = 0;
  let dropped = 0;
  const items: Rendered[] = [];
  for (const line of lines) {
    if (line.kind === "empty") continue;
    let rendered = line.raw;
    if (line.raw.length > (line.keep ? ANCESTOR_LINE_MAX : TEXT_LINE_MAX)) {
      if (line.kind === "ref") {
        // 可交互节点行原样保留：模型靠它点击，任何截断都可能让 name 与页面失配
        rendered = line.raw;
      } else if (line.keep) {
        rendered = clipAncestor(line);
      } else {
        truncated += 1;
        rendered = `${line.raw.slice(0, TEXT_LINE_MAX)}…（已截断 ${
          line.raw.length - TEXT_LINE_MAX
        } 字符）`;
      }
    }
    items.push({ line, text: rendered });
  }

  // 3) 预算兜底：仍超预算时先收紧非关键长行，再从最长的非关键行开始整行省略。
  let total = totalChars(items);
  if (total > SLIM_BUDGET_CHARS) {
    for (const item of items) {
      if (item.line.keep || item.text.length <= TEXT_LINE_TIGHT) continue;
      item.text = item.text.slice(0, TEXT_LINE_TIGHT) + "…";
      truncated += 1;
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

  // 没有任何实质裁剪时保持原文（含空行），不做无意义的改写
  if (truncated === 0 && dropped === 0) return untouched;

  const body = items
    .filter((i) => i.text)
    .map((i) => i.text)
    .join("\n");
  const after = body.length;
  // 末尾写明做了什么：模型据此知道「哪些内容没看到」，而不是以为页面就这么点内容
  const notice =
    `[pageqa] 快照已瘦身：${before} → ${after} 字符` +
    `（截断 ${truncated} 处长文本、省略 ${dropped} 行非关键文本；` +
    `可交互元素及其祖先区域、标题/状态文本均完整保留）`;
  return {
    text: `${body}\n${notice}`,
    before,
    after,
    applied: true,
    truncatedLines: truncated,
    droppedLines: dropped,
  };
}
