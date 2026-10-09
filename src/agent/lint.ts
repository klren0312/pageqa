/**
 * 用例格式静态校验（`pageqa lint` 子命令，以及每次跑用例之前的预检）。
 *
 * 「写法不统一」的代价全落在运行时：用例的三条硬约束（`## ` 分场景、一个非空行 = 一步、
 * 一条断言 = 一次断言工具调用）分别在 `splitScenarios` / `numberSteps` / `countAssertions`
 * 里，而错误只在**跑完之后**才以「断言数不足」「步骤未跑满」的形式暴露——验证一次要开浏览器、
 * 调模型、十几分钟，还常常表现为「假失败」，让人先去怀疑功能坏了。
 *
 * 这里把同一套口径搬到**开跑之前**：不开浏览器、不调模型，秒级给出「第几行、哪条规则、为什么」。
 * 步骤数与断言数一律复用 `report.ts` 的 `numberSteps` / `countAssertions`，
 * 保证 lint 说的和运行时做的是**同一件事**（不然就会出现「lint 说没事、一跑报断言不足」）。
 *
 * 规则分两级：`error` 会让用例跑错或跑不动，`warn` 只是写法不统一（建议统一，但不拦）。
 * 判定尽量只认**确定性**的特征（正则能命中的写法），宁可漏报也不误报——
 * 一条误报的告警会让人从此无视所有告警。
 */
import { countAssertions, numberSteps } from "../report/report.js";
import { t } from "../shared/i18n.js";

/** 问题级别：`error` 会让用例跑错/跑不动；`warn` 只是写法不统一。 */
export type LintSeverity = "error" | "warn";

export interface LintIssue {
  /** 规则 id（对应文案 key `lint.rule.<id>`）。 */
  rule: string;
  severity: LintSeverity;
  /** 所属场景名；位于任何 `## ` 之前、或整份用例没有场景头时为 null。 */
  scenario: string | null;
  /** 用例原文行号（1 起）。 */
  line: number;
  /** 该行原文（过长时截断）。 */
  text: string;
  /** 人类可读的说明（已按当前语种本地化）。 */
  message: string;
}

/** 用例规模：报告与 `--json` 都用它，口径与运行时一致。 */
export interface LintCounts {
  scenarios: number;
  steps: number;
  assertions: number;
  /** 含下载/导出捕获的步骤数（每一步都算一条断言，但行里没有「断言」二字）。 */
  downloads: number;
}

export interface LintResult {
  issues: LintIssue[];
  counts: LintCounts;
  errors: number;
  warnings: number;
}

/** 全部规则 id（测试用它保证 zh/en 两份文案都不缺）。 */
export const LINT_RULE_IDS = [
  "preambleText",
  "emptyScenario",
  "duplicateScenario",
  "snapshotRef",
  "urlScheme",
  "unknownPlaceholder",
  "uploadPath",
  "hardWait",
  "selectAsFill",
  "downloadExtraAssert",
  "vagueAssertion",
  "proseStep",
  "noAssertion",
] as const;

/** 运行时可展开的占位符名（与 vars.ts 的 PRESETS 保持一致）。 */
const KNOWN_PLACEHOLDERS = new Set(["timestamp", "date", "time", "datetime"]);

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]*)?\}/g;

/**
 * 步骤句里应当出现的意图动词。
 *
 * 只用来区分「操作步骤」与「说明性文字」——两者在运行时都会被当作步骤执行，
 * 所以放错位置的说明文字是最典型的一种「形式不统一」。刻意收窄词表：
 * 把「验证/校验/检查」这类既是动作又常出现在解释里的词排除在外，宁可漏报。
 */
const ACTION_VERB =
  /打开|访问|前往|跳转|进入|读取|截图|截屏|点击|点选|勾选|填写|输入|录入|选择|选中|上传|下载|导出|捕获|按下|按键|回车|提交|悬停|滚动|滚轮|拖动|等到|等待|断言|刷新|返回|关闭|展开|收起|获取|设置|切换/;

/** 「说明：…」「注意：…」这类更像注释而不是步骤的开头。 */
const NARRATION = /^(?:说明|注意|备注|前置|背景|理由|解释|提示)[：:]/;

/** 上传句里必须给**绝对**路径（相对路径会在 bsk 侧解析失败）。 */
const UPLOAD_INTENT = /上传(?:本地)?文件\s*(\S+)/;

const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

/** 行首的导航意图：`打开 <URL>`。 */
const NAV_INTENT = /^(?:打开|访问|前往|跳转到|进入)\s+/;

/**
 * `等待 3 秒` 这类固定等待（页面内的变化该写条件等待）。
 *
 * 单位后面不能跟 `\b`：`秒`/`毫秒` 不是 `\b` 眼里的「字」（它只认 ASCII 单词字符），
 * 紧跟中文标点时 `\b` 直接不成立——曾经因此整条规则静默失效，一条都没报出来。
 */
const HARD_WAIT =
  /^(?:等待|稍等|静候)\s*\d+(?:\.\d+)?\s*(?:秒|毫秒|分钟|ms|min|s)(?![0-9A-Za-z])/i;

/** 下拉框不是文本框：这里只挑「下拉 + 填写/填入」这一对确定矛盾的写法。 */
const DROPDOWN = /下拉(?:框|选择|列表|菜单)?/;
const FILL_WORD = /(?:填写|填入)/;

const DOWNLOAD_INTENT = /download|\bdownload\b/i;

/** 断言行里**可字面匹配的锚点**：用引号/书名号/反引号标出来的那段文本。 */
const QUOTED_ANCHOR = /[「『][^」』]+[」』]|"[^"]+"|'[^']+'|`[^`]+`/;

/**
 * 工具型断言：它们读的是**浏览器侧缓冲**，本来就没有「页面上的文本」可写，
 * 因此天然不带字面锚点，直接放行（控制台报错、网络请求）。
 */
const TOOL_BACKED_ASSERT = /控制台|console|报错|错误日志|网络|请求|接口|状态码/;

/** 「包含 / 出现 X」里的 X。 */
const EXPECT_CLAUSE =
  /(?:包含|含有|出现|已出现|显示|展示|存在|看到|可见)\s*([^\s，。；;、）)]+)/;

/**
 * 泛泛的状态名词：写进期望值里等于没写。
 *
 * 它们不是页面上的一段文字，模型只能自己去快照里挑一段**当前值**顶上——
 * 挑到的往往是「共 14 条」这种随数据变化的值，于是断言变成自证、回放还会随数据变红。
 */
const VAGUE_NOUN =
  /数据行|数据记录|数据|条数|记录|内容|弹框|弹窗|对话框|元素|提示信息|成功提示|错误提示|消息|状态/;

/** 去掉行内装饰（反引号、各类引号括号），便于按词匹配。 */
function plain(line: string): string {
  return line
    .replace(/[`「」『』【】"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 断言行是不是「没有可字面匹配的锚点」。
 *
 * `assert_text` 只做**字面包含**（必要时 Jev 语义复核），所以断言行里必须有一段页面上真实
 * 印着的文本：要么用引号/「」标出来，要么写成「包含 / 出现 X」。否则模型没有别的办法——
 * 它只能先 snapshot 把当前值读出来（如「共 14 条」），再拿这个值当期望。那条断言于是
 * **必然成立**（自证），而且这个值会被录进回放脚本（`record.ts`），数据一变就成了假失败。
 *
 * 这不是纸上谈兵：真实用例里「断言表格中存在数据行」就是这么变成 `assert_text("共 14 条")` 的。
 */
function isVagueAssertion(line: string, plainLine: string): boolean {
  // 工具型断言（控制台 / 网络）读的是浏览器缓冲，没有对应文本可写。
  if (TOOL_BACKED_ASSERT.test(plainLine)) return false;
  // 有引号锚点：`断言页面出现「保存成功」`、`断言标题包含 'IANA'`
  if (QUOTED_ANCHOR.test(line)) return false;
  // `包含 / 出现 X`，且 X 不像泛泛的状态名词
  const clause = plainLine.match(EXPECT_CLAUSE);
  if (clause && !VAGUE_NOUN.test(clause[1] ?? "")) return false;
  return true;
}

/** 该行是不是一步「捕获下载」。 */
function isDownloadStep(text: string): boolean {
  const p = plain(text);
  // 网络断言里也会带 `download-sample.txt` 这种字样，那是在断言请求，不是在下载。
  if (/断言请求|assert_network|返回\s*\d{3}|状态码/.test(p)) return false;
  if (DOWNLOAD_INTENT.test(p)) return true;
  return /捕获/.test(p) && /(?:下载|导出|文件)/.test(p);
}

function snippet(text: string): string {
  const s = text.trim();
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}

/**
 * 校验一份用例文本。
 *
 * `input` 应当是**未展开占位符**的原文：占位符合法性正是要检查的东西之一
 * （未知名字会被原样保留、静默失效），展开之后就看不出问题了。
 */
export function lintCase(input: string): LintResult {
  const issues: LintIssue[] = [];
  const lines = input.split(/\r?\n/);

  interface Entry {
    text: string;
    no: number;
  }
  interface Segment {
    /** 场景名；整份用例没有 `## ` 头时为 null（此时全部内容视为一个场景）。 */
    name: string | null;
    /** `## ` 那一行的行号（隐式场景为 0）。 */
    headerLine: number;
    entries: Entry[];
  }

  const segments: Segment[] = [];
  const preamble: Entry[] = [];
  let current: Segment | null = null;
  lines.forEach((raw, i) => {
    const m = raw.match(/^##\s+(.*)$/);
    if (m) {
      current = { name: m[1].trim(), headerLine: i + 1, entries: [] };
      segments.push(current);
      return;
    }
    const entry: Entry = { text: raw, no: i + 1 };
    if (current) current.entries.push(entry);
    else preamble.push(entry);
  });

  const hasScenarios = segments.length > 0;
  const scopes: Segment[] = hasScenarios
    ? segments
    : [{ name: null, headerLine: 0, entries: lines.map((raw, i) => ({ text: raw, no: i + 1 })) }];

  const push = (
    rule: string,
    severity: LintSeverity,
    scenario: string | null,
    line: number,
    text: string,
  ) => {
    issues.push({
      rule,
      severity,
      scenario,
      line,
      text: snippet(text),
      message: t(`lint.rule.${rule}`),
    });
  };

  // ── ① `## ` 之前的正文：整段被丢弃 ──
  // 这是最容易踩的坑：开场说明、前置条件写在第一个 `## ` 之前，人以为在描述用例，
  // 运行时其实一个字都没进模型视野。写成 `#`/`>` 注释行才既安全又说明得了问题。
  if (hasScenarios) {
    for (const e of preamble) {
      const s = e.text.trim();
      if (s.length === 0 || s.startsWith("#") || s.startsWith(">")) continue;
      push("preambleText", "warn", null, e.no, e.text);
    }
  }

  // ── ② 逐场景：结构规则 + 逐行规则 ──
  const seenNames = new Map<string, number>();
  let downloadSteps = 0;
  for (const seg of scopes) {
    if (seg.name !== null) {
      const prev = seenNames.get(seg.name);
      if (prev !== undefined) {
        push("duplicateScenario", "error", seg.name, seg.headerLine, `## ${seg.name}`);
      } else {
        seenNames.set(seg.name, seg.headerLine);
      }
    }

    // 有效步骤 = 非空且不是 `#`/`>` 注释（与 numberSteps 同一口径）
    const body = seg.entries.filter((e) => {
      const s = e.text.trim();
      return s.length > 0 && !s.startsWith("#") && !s.startsWith(">");
    });

    // 空场景会被 splitScenarios 静默丢掉：场景名在用例里写着，报告里却完全不存在。
    if (hasScenarios && body.length === 0) {
      push("emptyScenario", "error", seg.name, seg.headerLine, `## ${seg.name ?? ""}`);
      continue;
    }

    let assertions = 0;
    let downloads = 0;
    for (const e of body) {
      const line = e.text;
      const p = plain(line);

      // 快照编号：只在产生它的那一次快照里有效，下一个动作就失效
      if (/@e\d+/.test(line)) push("snapshotRef", "error", seg.name, e.no, line);

      // 导航地址必须完整
      if (NAV_INTENT.test(p)) {
        const target = p.replace(NAV_INTENT, "").split(" ")[0] ?? "";
        if (!/^https?:\/\//i.test(target)) {
          push("urlScheme", "error", seg.name, e.no, line);
        }
      }

      // 未知占位符会被原样保留（`${PATH}` 就字面打进了输入框）
      PLACEHOLDER.lastIndex = 0;
      let ph: RegExpExecArray | null;
      const unknown = new Set<string>();
      while ((ph = PLACEHOLDER.exec(line)) !== null) {
        const name = ph[1] ?? "";
        if (!KNOWN_PLACEHOLDERS.has(name)) unknown.add(name);
      }
      if (unknown.size > 0) {
        push(
          "unknownPlaceholder",
          "error",
          seg.name,
          e.no,
          line,
        );
      }

      // 上传必须给绝对路径
      if (/上传(?:本地)?文件/.test(p)) {
        const token = p.match(UPLOAD_INTENT)?.[1];
        if (token === undefined || !ABSOLUTE_PATH.test(token)) {
          push("uploadPath", "error", seg.name, e.no, line);
        }
      }

      // 固定等待：页面内的变化该写条件等待
      if (HARD_WAIT.test(p)) push("hardWait", "warn", seg.name, e.no, line);

      // 下拉框写成了「填写/填入」
      if (DROPDOWN.test(p) && FILL_WORD.test(p)) {
        push("selectAsFill", "warn", seg.name, e.no, line);
      }

      // 下载后又单写一行「断言文件名…」：会让期望断言数多一条。
      // 排除两类不该报的：同一行里已经有捕获下载的动作（那是推荐写法），
      // 以及「断言页面中已出现上传的文件名」这种说的其实是**上传**。
      if (
        /断言/.test(p) &&
        /(?:文件名|已下载|下载成功|下载完成)/.test(p) &&
        !/上传/.test(p) &&
        !/捕获/.test(p) &&
        !DOWNLOAD_INTENT.test(p)
      ) {
        push("downloadExtraAssert", "warn", seg.name, e.no, line);
      }

      // 断言里没有可字面匹配的文本：模型只能去快照里读一个当前值当期望
      if (/断言/.test(p) && isVagueAssertion(line, p)) {
        push("vagueAssertion", "warn", seg.name, e.no, line);
      }

      // 说明性文字被当成了步骤
      if (
        !ACTION_VERB.test(p) &&
        !/断言/.test(p) &&
        (NARRATION.test(p) || /[。.]$/.test(p))
      ) {
        push("proseStep", "warn", seg.name, e.no, line);
      }

      if (/断言/.test(p)) assertions++;
      if (isDownloadStep(p)) {
        downloads++;
        downloadSteps++;
      }
    }

    // 没有任何断言的场景：跑完也没有判定依据
    if (body.length > 0 && assertions === 0 && downloads === 0) {
      const at = seg.headerLine > 0 ? seg.headerLine : (body[0]?.no ?? 1);
      push(
        "noAssertion",
        "warn",
        seg.name,
        at,
        seg.headerLine > 0 ? `## ${seg.name ?? ""}` : (body[0]?.text ?? ""),
      );
    }
  }

  const steps = numberSteps(input).steps.length;
  const assertions = countAssertions(input);
  const errors = issues.filter((i) => i.severity === "error").length;

  return {
    issues,
    counts: {
      scenarios: hasScenarios ? segments.length : steps > 0 ? 1 : 0,
      steps,
      assertions,
      downloads: downloadSteps,
    },
    errors,
    warnings: issues.length - errors,
  };
}

/** 有没有 `error` 级问题（`pageqa lint` 的退出码与预检的醒目程度都由它决定）。 */
export function lintHasErrors(result: LintResult): boolean {
  return result.errors > 0;
}

/**
 * 渲染校验结果。`label` 是用例文件名；内联文本传 null。
 * `maxIssues` 用来在「跑用例前的预检」里截断——那里只需要提个醒，看全量走 `pageqa lint`。
 */
export function formatLintReport(
  label: string | null,
  result: LintResult,
  maxIssues: number = Number.POSITIVE_INFINITY,
): string {
  const out: string[] = [];
  out.push(label ? t("lint.header", { path: label }) : t("lint.headerInline"));
  out.push(
    t("lint.counts", {
      scenarios: result.counts.scenarios,
      steps: result.counts.steps,
      assertions: result.counts.assertions,
      downloads: result.counts.downloads,
    }),
  );
  if (result.issues.length === 0) {
    out.push(t("lint.clean"));
    return out.join("\n");
  }
  const shown = result.issues.slice(0, maxIssues);
  for (const issue of shown) {
    out.push(
      issue.scenario
        ? t("lint.lineScenario", {
            line: issue.line,
            rule: issue.rule,
            scenario: issue.scenario,
            message: issue.message,
          })
        : t("lint.line", {
            line: issue.line,
            rule: issue.rule,
            message: issue.message,
          }),
    );
    if (issue.text) out.push(t("lint.text", { text: issue.text }));
  }
  if (result.issues.length > shown.length) {
    out.push(t("lint.more", { n: result.issues.length - shown.length }));
  }
  out.push(
    t("lint.total", { errors: result.errors, warnings: result.warnings }),
  );
  return out.join("\n");
}
