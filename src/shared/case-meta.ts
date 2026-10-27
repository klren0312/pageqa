/**
 * 用例文件头（frontmatter）：把「这份用例跑哪个小程序项目」写进用例里，
 * 而不是每次去改 `~/.pageqa/config.json`。
 *
 * 支持的最小 YAML 子集（刻意不引入 YAML 依赖）：
 *
 * ```
 * ---
 * miniprogram:
 *   cliPath: "D:\\Apps\\微信web开发者工具\\cli.bat"
 *   projectPath: "D:\\1project\\yudao-ui-admin-uniapp"
 * ---
 * ```
 *
 * 也接受扁平写法 `miniprogram.projectPath: ...`。
 *
 * 优先级：用例 frontmatter > 环境变量 `PAGEQA_MINIPROGRAM_*` > 配置文件。
 * 用例只覆盖它显式写了的字段，其余仍由环境变量/配置文件决定。
 */
import { readFileSync } from "node:fs";
import type { MiniProgramConfig } from "../config/config.js";

/** 用例头里能影响运行行为的东西（目前只有小程序驱动配置）。 */
export interface CaseMeta {
  miniprogram?: Partial<MiniProgramConfig>;
}

/** `splitFrontmatter` 的结果。 */
export interface SplitCase {
  meta: CaseMeta;
  /** 去掉 frontmatter 之后的用例正文。 */
  body: string;
  /** 是否真的解析出一个闭合的 frontmatter 块。 */
  found: boolean;
}

const FM_LINE = "---";

/**
 * 把文件开头的 frontmatter 块与正文分开。
 *
 * 没闭合的 `---` 不算 frontmatter（按普通文本处理）：用例里偶尔会出现 `---`
 * 分隔线，宁可当正文让它自然报错，也不要吞掉半份用例。
 */
export function splitFrontmatter(text: string): SplitCase {
  const normalized = text.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  let start = 0;
  // 允许开头有若干空行（编辑器保存时偶尔会带）。
  while (start < lines.length && lines[start].trim() === "") start++;
  if (lines[start]?.trim() !== FM_LINE) {
    return { meta: {}, body: normalized, found: false };
  }
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === FM_LINE) {
      end = i;
      break;
    }
  }
  if (end < 0) return { meta: {}, body: normalized, found: false };
  const yaml = lines.slice(start + 1, end).join("\n");
  const body = lines.slice(end + 1).join("\n");
  return { meta: parseCaseMeta(yaml), body, found: true };
}

/**
 * 把 frontmatter 逐行换成空行，**保持行号不变**。
 *
 * 给 lint 用：它把行号报给用户，剥掉 frontmatter 后行号整体前移会让定位错位。
 */
export function maskFrontmatter(text: string): string {
  const normalized = text.replace(/^\uFEFF/, "");
  const { body, found } = splitFrontmatter(normalized);
  if (!found) return normalized;
  const consumed = normalized.length - body.length;
  const prefix = normalized.slice(0, consumed);
  const newlines = (prefix.match(/\n/g) ?? []).length;
  return "\n".repeat(newlines) + body;
}

/** 读取一个用例文件并解析其 frontmatter（不存在/读不了时返回空 meta）。 */
export function readCaseMeta(path: string): CaseMeta {
  try {
    return splitFrontmatter(readFileSync(path, "utf8")).meta;
  } catch {
    return {};
  }
}

/** 用例级配置覆盖在全局配置之上：只覆盖显式给出的字段。 */
export function mergeMiniprogramConfig(
  base: MiniProgramConfig | undefined,
  override?: Partial<MiniProgramConfig>,
): MiniProgramConfig {
  if (!override) return base ?? {};
  const b = base ?? {};
  return {
    cliPath: override?.cliPath ?? b.cliPath,
    projectPath: override?.projectPath ?? b.projectPath,
    platform: override?.platform ?? b.platform,
    timeout: override?.timeout ?? b.timeout,
    port: override?.port ?? b.port,
    account: override?.account ?? b.account,
  };
}

/** 解析最小 YAML 子集：只认 `miniprogram` 段下的字段。 */
function parseCaseMeta(yaml: string): CaseMeta {
  const mp: Record<string, string> = {};
  let section: string | null = null;
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = (line.match(/^\s*/)?.[0] ?? "").length;
    const kv = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const value = kv[2].trim();
    if (indent === 0) {
      // 扁平写法：miniprogram.projectPath: ...
      if (key.startsWith("miniprogram.")) {
        mp[key.slice("miniprogram.".length)] = unquote(value);
        section = "miniprogram";
        continue;
      }
      section = key;
      continue;
    }
    if (section === "miniprogram") mp[key] = unquote(value);
  }
  const config = toMiniProgramConfig(mp);
  return config ? { miniprogram: config } : {};
}

function toMiniProgramConfig(
  mp: Record<string, string>,
): Partial<MiniProgramConfig> | undefined {
  const out: Partial<MiniProgramConfig> = {};
  if (mp.cliPath) out.cliPath = mp.cliPath;
  if (mp.projectPath) out.projectPath = mp.projectPath;
  if (mp.platform === "ios" || mp.platform === "android") out.platform = mp.platform;
  const timeout = Number(mp.timeout);
  if (Number.isFinite(timeout) && timeout > 0) out.timeout = timeout;
  const port = Number(mp.port);
  if (Number.isFinite(port) && port > 0) out.port = port;
  if (mp.account) out.account = mp.account;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 去掉值两侧的引号。
 *
 * 只有双引号内才处理 `\\` → `\` 的转义（YAML 双引号字符串的约定）；
 * 单引号与裸值按字面处理——Windows 路径写成 `D:\1project` 或 `D:\\1project`
 * 都能用，UNC 路径 `\\server\share` 也不会被误折成一个反斜杠。
 */
function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}
