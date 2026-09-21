/**
 * 元素定位符（Locator）：把「这次点的是哪个元素」表达成跨快照可复用的语义描述。
 *
 * 背景：bsk 的 `@eN` 引用只在**产生它的那次快照**内有效，下一次 snapshot 编号会重排，
 * 因此回放脚本不能直接存 `@eN`。bsk 快照文本是一棵缩进的 aria 树，每个可交互节点形如：
 *
 *     @e1 link "Learn more" [→ iana.org]
 *
 * 其中的「角色 + 可访问名」（role + name）才是稳定的语义信息：页面微调后仍能重新命中。
 * 本模块负责在**录制时**把 target 解析成定位符，并在**回放时**用新的快照把它解析回 `@eN`。
 *
 * 定位符不保证唯一：同名元素可能有多个（列表每行都有「操作」按钮、页面级与区域级各有一个
 * 「操作」下拉）。因此还记录两样东西：
 * - `nth`：录制时在所有同名候选中排第几；
 * - `path`：录制时该节点的**祖先路径**（只保留有名字的祖先）。
 * 回放时优先用祖先路径消歧——「同名第几个」在页面里同类元素数量变化后会指错，
 * 而「在哪个区域下」是更强、更抗漂移的信号。
 */

/** bsk 快照中带有 `@eN` 引用的一行。 */
export interface SnapshotRef {
  /** 引用本身，形如 `@e1`。 */
  ref: string;
  /** 角色（link / button / textbox …），取不到时为空串。 */
  role: string;
  /** 可访问名（按钮文案、链接文字等），取不到时为空串。 */
  name: string;
  /** 祖先路径（从浅到深，只保留有名字的祖先），如 `tabpanel "结构"`。 */
  path: string[];
}

/**
 * 元素定位符：语义定位（role + name + 祖先路径 + 同名序号）+ 录制时的原始 target 作为兜底。
 */
export interface Locator {
  role: string;
  name: string;
  /** 在所有 role+name 相同的候选中排第几（0 起）；无法判定时为 -1。 */
  nth: number;
  /** 录制时的原始 target（`@eN` 或 CSS 选择器）。 */
  target: string;
  /** 录制时的祖先路径，用于同名元素消歧。 */
  path: string[];
}

/** 是否为 bsk 快照引用（`@e1` 或 `e1`）。回放时引用必须重新解析，CSS 选择器则可直接用。 */
export function isRef(target: string): boolean {
  return /^@?e\d+$/.test(target.trim());
}

/** 归一化引用写法：`e1` -> `@e1`。 */
export function normalizeRef(target: string): string {
  const t = target.trim();
  return t.startsWith("@") ? t : "@" + t;
}

/** 缩进宽度（tab 按 2 空格计，bsk 用空格缩进，这里只是保险）。 */
export function indentWidth(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 2;
    else break;
  }
  return n;
}

/** 取出 `role "name"` 形式的角色与可访问名。 */
export function parseRoleName(text: string): { role: string; name: string } {
  const roleMatch = text.match(/^([A-Za-z][A-Za-z0-9_-]*)/);
  const nameMatch = text.match(/"([^"]*)"/);
  return {
    role: roleMatch ? roleMatch[1] : "",
    name: nameMatch ? nameMatch[1] : "",
  };
}

/**
 * 是否为快照里的元信息行（`@vom` / `@view` / `@layers` / `L1 page`），这类行不参与层级树。
 *
 * 导出给快照瘦身（snapshot.ts）共用：两侧必须用同一条判定，否则瘦身会把它当成
 * 普通文本行处理，而层级解析又跳过它，两边的祖先链就对不上了。
 */
export function isSnapshotMetaLine(body: string): boolean {
  return (
    body.startsWith("@vom") ||
    body.startsWith("@view") ||
    body.startsWith("@layers") ||
    /^L\d+\b/.test(body)
  );
}

/**
 * 路径条目的两个边界。
 *
 * 有些节点的可访问名是**整页文本**（如 `main "Dropdown 下拉菜单 将动作或菜单折叠到…"`），
 * 直接存进脚本既撑大体积，又因为页面改一个字就失配而毫无消歧价值。
 * 因此名字截断、层数只留最深的几层——深层（menu / tabpanel / dialog）才是真正区分区域的信息。
 * 截断在录制与回放两侧执行同一套规则，所以比较依旧有效。
 */
const PATH_NAME_MAX = 60;
const PATH_DEPTH_MAX = 3;

/** 路径节点（有名字的祖先）的可读写法。 */
function pathLabel(role: string, name: string): string {
  const shown =
    name.length > PATH_NAME_MAX
      ? name.slice(0, PATH_NAME_MAX - 3) + "..."
      : name;
  return `${role || "?"} ${JSON.stringify(shown)}`;
}

/**
 * 解析 bsk 快照文本里所有带引用的行，得到「引用 -> 角色/可访问名/祖先路径」。
 *
 * 缩进即层级：维护一个缩进栈，遇到更浅或同级的新行就弹出更深/同级的节点，
 * 因此每个引用都能拿到「它在哪个区域（tabpanel / dialog / 某个标题）之下」。
 * `@vom` / `@view` / `@layers` / `L1 page` 等元信息行不参与树。
 */
export function parseSnapshotRefs(snapshotText: string): SnapshotRef[] {
  const refs: SnapshotRef[] = [];
  const stack: { indent: number; label: string | null }[] = [];

  for (const line of snapshotText.split(/\r?\n/)) {
    const body = line.trim();
    if (!body) continue;
    if (isSnapshotMetaLine(body)) continue;
    const indent = indentWidth(line);

    const refMatch = body.match(/^@e(\d+)\b\s*(.*)$/);
    const { role, name } = parseRoleName(refMatch ? refMatch[2] : body);

    // 弹出所有「缩进 >= 当前」的节点，剩下的就是本行的祖先
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    if (refMatch) {
      refs.push({
        ref: `@e${refMatch[1]}`,
        role,
        name,
        path: stack
          .map((e) => e.label)
          .filter((l): l is string => l !== null)
          .slice(-PATH_DEPTH_MAX),
      });
    }
    stack.push({
      indent,
      label: name ? pathLabel(role, name) : null,
    });
  }
  return refs;
}

/**
 * 录制时构造定位符：从当时的快照里查出该引用对应的角色/可访问名、同名序号与祖先路径。
 *
 * target 是 CSS 选择器（或快照里查不到的引用）时，定位符退化为「只有 target 兜底」，
 * 回放时直接按原 target 操作。
 */
export function buildLocator(target: string, snapshotText: string): Locator {
  const original = target.trim();
  const bare: Locator = {
    role: "",
    name: "",
    nth: -1,
    target: original,
    path: [],
  };
  if (!isRef(original)) return bare;
  const ref = normalizeRef(original);
  const refs = parseSnapshotRefs(snapshotText);
  const self = refs.find((r) => r.ref === ref);
  // 快照里查不到（例如模型用了一次更早快照的引用）：没有语义信息可用，只能留 target 兜底
  if (!self) return bare;
  if (!self.role && !self.name) return bare;
  const same = refs.filter((r) => r.role === self.role && r.name === self.name);
  const nth = same.findIndex((r) => r.ref === ref);
  return {
    role: self.role,
    name: self.name,
    nth,
    target: original,
    path: self.path,
  };
}

/**
 * 祖先路径的匹配度：从最深一级往上数，连续相同的层数。
 * 只比尾部——页面结构微调通常发生在中间层，根节点往往没变。
 */
function pathScore(want: string[], got: string[]): number {
  let score = 0;
  const depth = Math.min(want.length, got.length);
  for (let i = 1; i <= depth; i++) {
    if (want[want.length - i] !== got[got.length - i]) break;
    score += 1;
  }
  return score;
}

/**
 * 回放时用**新的**快照把定位符解析回 `@eN`。
 *
 * 匹配策略逐级放宽，都不中则返回 null（由调用方决定退回 target 还是报错）：
 *   1. role + name 全等（最常见，页面没变时必然命中）
 *   2. role 相同且 name 包含（文案被加了前后缀，如「操作」→「操作 更多」）
 *   3. 只看 name（角色被前端改过，如 button 变 a）
 *
 * 命中多个候选时，先按**祖先路径**消歧（「结构」tab 下的「操作」与产品级的「操作」
 * 名字完全一样，只有所属区域能区分），路径也无法区分时才退回录制的同名序号 `nth`。
 */
export function resolveLocator(
  locator: Locator,
  snapshotText: string,
): string | null {
  const name = locator.name;
  const role = locator.role;
  if (!name && !role) return null;
  const refs = parseSnapshotRefs(snapshotText);
  const exact = refs.filter((r) => r.role === role && r.name === name);
  const fuzzy = exact.length
    ? exact
    : refs.filter(
        (r) => r.role === role && name.length > 0 && r.name.includes(name),
      );
  const pool = fuzzy.length
    ? fuzzy
    : refs.filter((r) => name.length > 0 && r.name === name);
  if (!pool.length) return null;
  if (pool.length === 1) return pool[0].ref;

  const path = locator.path ?? [];
  if (path.length > 0) {
    const scored = pool
      .map((r) => ({ ref: r.ref, score: pathScore(path, r.path) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored.length > 0) {
      const best = scored[0].score;
      const top = scored.filter((c) => c.score === best);
      if (top.length === 1) return top[0].ref;
      return top[locator.nth >= 0 && locator.nth < top.length ? locator.nth : 0]
        .ref;
    }
  }

  const idx = locator.nth >= 0 && locator.nth < pool.length ? locator.nth : 0;
  return pool[idx].ref;
}

/** 定位失败时给出的线索类型。 */
export interface LocatorHint {
  /** similar-name：有名字相近的同角色元素；role-only：有该角色元素但名字都不同；no-role：该角色元素一个都没有。 */
  kind: "similar-name" | "role-only" | "no-role";
  /** 可读的候选元素（最多若干个）。 */
  items: string[];
  /** 页面上该角色的元素总数。 */
  roleCount: number;
}

/**
 * 定位不到时给出「当前页面里有什么」的线索。
 *
 * 「元素未找到」本身是条死路，用户只知道某步挂了。区分三种情况后，报告能直接回答
 * 「是弹窗没打开」「是菜单点错了一个」还是「元素改名了」，用户据此就能判断该改脚本还是改用例。
 */
export function locatorHint(
  locator: Locator,
  snapshotText: string,
  limit = 3,
): LocatorHint {
  const refs = parseSnapshotRefs(snapshotText);
  const sameRole = refs.filter((r) => r.role === locator.role);
  const head = locator.name.slice(0, 2);
  const similar = head
    ? sameRole.filter((r) => r.name.includes(head))
    : [];
  if (similar.length > 0) {
    return {
      kind: "similar-name",
      items: similar.slice(0, limit).map((r) => pathLabel(r.role, r.name)),
      roleCount: sameRole.length,
    };
  }
  if (sameRole.length === 0) {
    return { kind: "no-role", items: [], roleCount: 0 };
  }
  return {
    kind: "role-only",
    items: sameRole
      .filter((r) => r.name)
      .slice(0, limit)
      .map((r) => pathLabel(r.role, r.name)),
    roleCount: sameRole.length,
  };
}

/** 定位符的可读描述，用于报告与日志（说明「当时点的是什么、在哪个区域」）。 */
export function describeLocator(locator: Locator | null): string {
  if (!locator) return "无定位符";
  const parts: string[] = [];
  if (locator.role) parts.push(`role=${locator.role}`);
  if (locator.name) parts.push(`name=${JSON.stringify(locator.name)}`);
  if (locator.nth > 0) parts.push(`第 ${locator.nth + 1} 个同名元素`);
  const area = locator.path?.at(-1);
  if (area) parts.push(`位于 ${area} 之下`);
  return parts.length ? parts.join(" ") : `target=${locator.target}`;
}
