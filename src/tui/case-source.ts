/**
 * 运行时加载用例文件：把用户给的「路径或关键字」解析成确切要加载的那个文件。
 *
 * 解析分三层，确定性优先（见 ADR-0005 决策三）：
 * 1. 精确命中一个已存在的文件 → 就是它，不再自作聪明；
 * 2. 命中一个目录 → 取该目录下的全部用例文件（`.md`/`.txt`）；
 * 3. 其余按关键字做「相对 cwd 的路径片段」子串匹配。
 *
 * 刻意**不**全量枚举 cwd 下所有 `.md`：那会把 README.md 与 docs/adr/*.md 一起塞进
 * 候选，模型挑错的概率比挑对高——而它挑错时用户是看不出来的（照跑，跑的是另一个文件）。
 * 也刻意不给 agent 加读文件工具：内容一旦绕过 pageqa 直接进模型上下文，步骤编号、
 * 用例原文映射、写回与录制对应关系整条链全断（见 ADR-0005 决策三）。
 */
import { readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 一次 `/run` 最多给出多少候选：再多也不适合让人挑，只报「还有 N 个」。 */
export const MAX_CANDIDATES = 20;

/** 递归查找时跳过的目录：里面不可能有用例，却可能让遍历慢几个数量级。 */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", "vendor"]);

/** 递归深度上限：用例文件通常在仓库浅层，往深处挖只会捞到无关文件。 */
const MAX_DEPTH = 6;

/** 用例文件的扩展名（与 CLI 的 `looksLikeScriptFile` 保持一致）。 */
const CASE_EXT = /\.(md|txt)$/i;

/** 从资源管理器/聊天工具粘来的路径常夹带不可见的 Bidi 控制符或零宽字符。 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export type CaseFileResolution =
  /** 唯一命中，可以直接加载。 */
  | { kind: "one"; path: string }
  /** 多个候选：调用方决定交给模型挑，还是弹选择器让用户挑。 */
  | { kind: "many"; candidates: string[]; truncated: number }
  /** 没有任何匹配。 */
  | { kind: "none" };

/** 清洗用户给的关键字：去不可见字符、去成对引号、去 `file://` 前缀、统一分隔符。 */
export function cleanHint(raw: string): string {
  let s = raw.replace(INVISIBLE, "").trim();
  const quoted = s.match(/^(["'])([\s\S]*)\1$/);
  if (quoted) s = quoted[2].replace(INVISIBLE, "").trim();
  if (/^file:\/\//i.test(s)) {
    try {
      s = fileURLToPath(s);
    } catch {
      // 非法 file URL：保持原样，后续按「找不到」处理
    }
  }
  return s.replace(/\\/g, "/");
}

/** 候选与提示里展示用的路径：cwd 下的用相对路径，便于阅读。 */
export function displayPath(p: string, cwd = process.cwd()): string {
  const rel = relative(cwd, p).replace(/\\/g, "/");
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : p;
}

function statOrNull(p: string): { isFile: boolean; isDir: boolean } | null {
  try {
    const st = statSync(p);
    return { isFile: st.isFile(), isDir: st.isDirectory() };
  } catch {
    return null;
  }
}

/** 递归收集用例文件；`pattern` 为空表示全收，否则要求相对路径（小写）含该子串。 */
function collect(
  root: string,
  cwd: string,
  pattern: string,
  out: string[],
  depth: number,
): void {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    // 点目录（.git/.github/.cache…）一律跳过：用例不会藏在里面。
    if (e.name.startsWith(".")) continue;
    const full = join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collect(full, cwd, pattern, out, depth + 1);
      continue;
    }
    if (!e.isFile() || !CASE_EXT.test(e.name)) continue;
    const rel = relative(cwd, full).replace(/\\/g, "/");
    if (pattern === "" || rel.toLowerCase().includes(pattern)) out.push(full);
  }
}

/** 浅层优先（用例通常在仓库表层），同层按路径字典序，保证候选顺序稳定可预期。 */
function byDepthThenPath(a: string, b: string): number {
  const da = a.split(/[\\/]/).length;
  const db = b.split(/[\\/]/).length;
  return da - db || a.localeCompare(b);
}

function pack(found: string[]): CaseFileResolution {
  const sorted = [...new Set(found)].sort(byDepthThenPath);
  if (sorted.length === 0) return { kind: "none" };
  if (sorted.length === 1) return { kind: "one", path: sorted[0] };
  return {
    kind: "many",
    candidates: sorted.slice(0, MAX_CANDIDATES),
    truncated: Math.max(0, sorted.length - MAX_CANDIDATES),
  };
}

/** 解析一次 `/run` 的输入。 */
export function resolveCaseFile(
  hint: string,
  cwd = process.cwd(),
): CaseFileResolution {
  const cleaned = cleanHint(hint);
  if (!cleaned) return { kind: "none" };
  const direct = isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
  const st = statOrNull(direct);
  // 1) 点到具体文件：用户既然指名，就直接用它。
  if (st?.isFile) return { kind: "one", path: direct };
  // 2) 点到目录：取该目录下的全部用例文件。
  if (st?.isDir) {
    const all: string[] = [];
    collect(direct, cwd, "", all, 0);
    return pack(all);
  }
  // 3) 关键字：按「相对 cwd 的路径片段」匹配（`examples/smoke` 也能命中）。
  const pattern = cleaned.replace(/^\.\//, "").toLowerCase();
  const all: string[] = [];
  collect(cwd, cwd, pattern, all, 0);
  if (all.length > 0) return pack(all);
  // 退一步：只用文件名匹配（应对 `examples//smoke`、带盘符的怪输入等）。
  const name = basename(cleaned).toLowerCase().replace(CASE_EXT, "");
  if (!name || name === pattern) return pack(all);
  const byName: string[] = [];
  collect(cwd, cwd, name, byName, 0);
  return pack(byName);
}

/**
 * 让模型从候选里挑一个：**只给它文件名，不给文件内容**。
 *
 * 这是「让 AI 自行查找」的边界——模型负责语义匹配（「跑一下 github-star 那个用例」
 * → `examples/github-star.md`），读取与编排仍归 pageqa。
 */
export function buildPickPrompt(
  hint: string,
  candidates: string[],
  cwd = process.cwd(),
): string {
  return [
    "用户想运行一个已有的页面测试用例文件，但没有给出确切路径。",
    `用户输入：${hint}`,
    "候选文件（相对路径）：",
    ...candidates.map((p, i) => `${i + 1}. ${displayPath(p, cwd)}`),
    "请只回答你选中的那一个候选的序号，不要输出任何解释；都不匹配就回答 0。",
  ].join("\n");
}

/** 解析模型的回答：只接受候选范围内的序号，其余（含 0、超范围、废话）一律当作挑不出来。 */
export function parsePick(
  answer: string,
  candidates: string[],
): string | undefined {
  const digits = answer.trim().match(/\d+/)?.[0];
  if (digits === undefined) return undefined;
  const n = Number(digits);
  if (!Number.isInteger(n) || n < 1 || n > candidates.length) return undefined;
  return candidates[n - 1];
}
