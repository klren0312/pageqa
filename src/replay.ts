/**
 * 回放脚本（Replay Script）：把一次成功的自然语言运行固化为**可零模型重放**的步骤序列。
 *
 * 为什么需要它：自然语言用例每次执行都要经过 LLM 解析，慢、贵、且同一用例两次跑法可能不同。
 * 一旦某条用例被 LLM 跑通，它的具体操作序列（点击哪个元素、填什么值、断言什么）就是确定的，
 * 把它存成脚本后就能反复快速回放，只在用例/页面变更时再回到 LLM 重新生成。
 *
 * 设计要点：
 * - **元素定位不存 `@eN`**：引用只在产生它的那次快照内有效，存下来回放必挂。
 *   改为存语义定位符（role + name + 同名序号），回放时用新快照重新解析（见 locator.ts）。
 * - **默认不调用任何模型**：断言走字符串包含；`--semantic` 才启用 Jev 语义判断。
 * - **占位符保持可复用**：`${timestamp}` 这类占位符按占位符形式存，回放时重新展开，
 *   这样「创建 产品${timestamp}」这类用例回放仍不会撞名。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pollUntil } from "./bsk/condition.js";
import {
  closeSession,
  createBskOps,
  ensureBskReady,
  ensureSession,
  type BskOps,
} from "./bsk/tools.js";
import { loadConfig } from "./config.js";
import {
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  downloadExpectation,
  flushDownloadCleanup,
} from "./downloads.js";
import { t } from "./i18n.js";
import { JevClient } from "./jev.js";
import {
  describeLocator,
  inspectRegion,
  isRef,
  locatorHint,
  resolveLocator,
  type Locator,
  type RegionState,
} from "./locator.js";
import { debugLog, info } from "./log.js";
import {
  emptyUsage,
  renderSuiteText,
  renderText,
  summarizeSuite,
  type AssertionResult,
  type ScenarioDetail,
  type TestReport,
  type TokenUsage,
} from "./report.js";
import { TimingCollector, renderTiming } from "./timing.js";
import { expandVars } from "./vars.js";

export const REPLAY_FORMAT = "pageqa-replay";
export const REPLAY_VERSION = 1;

/**
 * 回放步骤的类型。`snapshot` 不在其中：它只服务于模型的「观察」，回放不需要。
 *
 * `wait_for` 是唯一一次「新增步骤类型而不升 `REPLAY_VERSION`」：判断依据是脚本格式里
 * 本来就有针对它的闸门——加载时的**逐步类型校验**（`REPLAY_STEP_KINDS`）会在读到不认识的
 * 类型时当场报 `badStepKind`，说清楚是哪个步骤、哪个文件。升版本号会把「只含 click/fill 的
 * 新脚本」也一起拒掉（旧 pageqa 读到任何 version>1 都直接拒绝），代价更大而精度更低。
 */
export type ReplayStepKind =
  | "navigate"
  | "click"
  | "fill"
  | "upload"
  | "download"
  | "hover"
  | "scroll"
  | "wait"
  | "wait_for"
  | "assert_text";

/** 需要定位元素的步骤（click/hover/scroll 共用）。 */
export interface ReplayTargetStep {
  kind: "click" | "hover" | "scroll";
  /** 尽力映射到的用例步骤号（1 起）；映射不到为 null。 */
  step: number | null;
  /** 录制时模型给出的 target（`@eN` 或 CSS）。 */
  target: string;
  /** 语义定位符；target 是 CSS 或快照中查不到时为 null。 */
  locator: Locator | null;
}

export interface ReplayFillStep {
  kind: "fill";
  step: number | null;
  target: string;
  /** 填入值（已把运行时变量还原成占位符写法）。 */
  value: string;
  /** 占位符被还原时，记录录制当次真正填入的具体值，便于人工核对。 */
  recordedValue?: string;
  locator: Locator | null;
}

export interface ReplayUploadStep {
  kind: "upload";
  step: number | null;
  file: string;
  target?: string;
  locator: Locator | null;
}

/**
 * 下载步骤：点击触发元素 → 捕获一次下载 → 落盘 → 产出一条断言。
 *
 * 与 upload 同构（都由工具自己点触发元素），差别在于它**同时是断言**：
 * 捕获不到就是 FAIL，不像普通动作那样可以跳过。
 */
export interface ReplayDownloadStep {
  kind: "download";
  step: number | null;
  /** 触发下载的元素（录制时模型给出的 target）。 */
  target: string;
  locator: Locator | null;
  /** 显式落盘路径（已还原成占位符写法）；未给则用下载目录 + 时间戳 + 服务器建议名。 */
  out?: string;
  /** 文件名通配期望（如 `*.xlsx`）。 */
  expectName?: string;
  /** 等待上限（毫秒）；未给用默认值——写死默认值会让「改默认」失效。 */
  timeoutMs?: number;
}

export interface ReplayNavigateStep {
  kind: "navigate";
  step: number | null;
  url: string;
}

export interface ReplayWaitStep {
  kind: "wait";
  step: number | null;
  ms: number;
}

/**
 * 条件等待步骤：回放时**重新等同一个条件**，条件达成立刻继续。
 *
 * 与 `wait` 的关系：录制时模型如果知道自己在等什么，就会走 `wait_for`，脚本里留下的是条件
 * 而不是秒数；等到的东西一到就走，等不到则等满 `timeoutMs`（默认 `DEFAULT_WAIT_FOR_TIMEOUT_MS`）。
 * 三个条件互斥，由加载校验与工具层共同保证。
 */
export interface ReplayWaitForStep {
  kind: "wait_for";
  step: number | null;
  /** 等到页面可见文本出现。 */
  text?: string;
  /** 等到该 CSS 选择器命中元素。 */
  selector?: string;
  /** 等到该 CSS 选择器不再命中元素（如 loading 遮罩消失）。 */
  gone?: string;
  /** 等待上限（毫秒）；未给用当前默认值。 */
  timeoutMs?: number;
}

export interface ReplayAssertStep {
  kind: "assert_text";
  step: number | null;
  /** 断言期望（已把运行时变量还原成占位符写法）。 */
  expectation: string;
  /** 占位符被还原时，记录录制当次实际用的字面量。 */
  recordedExpectation?: string;
  /** 录制时该断言由 Jev 语义判断得出（字符串匹配可能误报，回放失败时会给出提示）。 */
  semantic?: boolean;
}

export type ReplayStep =
  | ReplayTargetStep
  | ReplayFillStep
  | ReplayUploadStep
  | ReplayDownloadStep
  | ReplayNavigateStep
  | ReplayWaitStep
  | ReplayWaitForStep
  | ReplayAssertStep;

/** 一个场景的录制结果（套件模式下每个 `## 场景` 一条）。 */
export interface ScenarioRecording {
  name: string;
  /** 用例原文步骤（忽略 `#`/`>` 行），用于把回放步骤映回「用例第 k 步」。 */
  caseSteps: string[];
  steps: ReplayStep[];
  /**
   * 该场景归属的用例文件——回放脚本按它分组（见 ADR-0005 决策七）。
   * 无落点的追加场景没有归属文件；批处理模式不必设置（只有一个来源）。
   */
  sourcePath?: string;
}

/**
 * 按来源把录制分组：一组 = 一个用例文件 = 一份回放脚本。
 *
 * 为什么拆而不合并：`ReplayScript.source` 是**脚本级单值** `{ path, hash }`，而一次
 * 交互会话可以加载多个用例文件。升级脚本格式（`sources[]`）会让一份脚本有两种可能的
 * 结构，读取端、漂移检测、占位符还原全要双分支；而脚本是会被长期保存、丢进 git、
 * 在 CI 里零模型重跑的对外契约，不值得为「一份脚本装多来源」这个几乎用不到的写法动它。
 *
 * `null` 组是从没加载过任何文件、纯内存追加的场景（默认写到 cwd 的 `pageqa.replay.json`）。
 */
export function groupRecordingsBySource(
  recordings: ScenarioRecording[],
): Map<string | null, ScenarioRecording[]> {
  const groups = new Map<string | null, ScenarioRecording[]>();
  for (const r of recordings) {
    const key = r.sourcePath ?? null;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  return groups;
}

/** 回放脚本文件结构。 */
export interface ReplayScript {
  format: typeof REPLAY_FORMAT;
  version: number;
  recordedAt: string;
  source: {
    /** 源用例文件路径；内联文本时为 null。 */
    path: string | null;
    /** 源用例内容哈希，用于回放时提示「源用例已变更」。 */
    hash: string | null;
  };
  scenarios: ReplayScenario[];
}

export interface ReplayScenario {
  name: string;
  caseSteps: string[];
  steps: ReplayStep[];
}

/** 源用例内容哈希（sha256 前 16 位十六进制，够用且便于人眼比对）。 */
export function scriptHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** 把录制结果组装成脚本对象（不含文件 IO，便于单测）。 */
export function buildReplayScript(
  recordings: ScenarioRecording[],
  meta: { sourcePath?: string | null; sourceText?: string | null } = {},
): ReplayScript {
  return {
    format: REPLAY_FORMAT,
    version: REPLAY_VERSION,
    recordedAt: new Date().toISOString(),
    source: {
      path: meta.sourcePath ?? null,
      hash: meta.sourceText ? scriptHash(meta.sourceText) : null,
    },
    scenarios: recordings.map((r) => ({
      name: r.name,
      caseSteps: r.caseSteps,
      steps: r.steps,
    })),
  };
}

/** 写入回放脚本文件（自动创建父目录）。 */
export function writeReplayScript(path: string, script: ReplayScript): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(script, null, 2) + "\n", "utf8");
}

/** 读取并校验回放脚本文件；结构不合法时抛出可读错误（而不是回放中途才崩）。 */
export function loadReplayScript(path: string): ReplayScript {
  if (!existsSync(path)) {
    throw new Error(t("replay.err.notFound", { path }));
  }
  let parsed: ReplayScript;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as ReplayScript;
  } catch (err) {
    throw new Error(
      t("replay.err.invalidJson", {
        path,
        msg: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  if (parsed?.format !== REPLAY_FORMAT) {
    throw new Error(
      t("replay.err.badFormat", { format: String(parsed?.format), path }),
    );
  }
  if (typeof parsed.version !== "number" || parsed.version > REPLAY_VERSION) {
    throw new Error(
      t("replay.err.badVersion", {
        version: String(parsed.version),
        supported: REPLAY_VERSION,
        path,
      }),
    );
  }
  if (!Array.isArray(parsed.scenarios) || parsed.scenarios.length === 0) {
    throw new Error(t("replay.err.noScenarios", { path }));
  }
  // 空脚本（例如录制时模型一步都没成功执行）必须明确拒绝：
  // 否则回放会「0 步全部通过」，把无效脚本伪装成一次成功的回归。
  const total = parsed.scenarios.reduce(
    (n, s) => n + (Array.isArray(s.steps) ? s.steps.length : 0),
    0,
  );
  if (total === 0) {
    throw new Error(t("replay.err.empty", { path }));
  }
  // 不认识的步骤类型在加载时就拒绝：脚本是对外契约，带病加载只会在回放中途
  // 以更难懂的方式崩掉（例如 switch 静默落空、步骤「执行成功」却什么都没做）。
  for (const sc of parsed.scenarios) {
    for (const st of sc.steps ?? []) {
      if (!REPLAY_STEP_KINDS.has(st?.kind)) {
        throw new Error(
          t("replay.err.badStepKind", { kind: String(st?.kind), path }),
        );
      }
      // 条件等待必须**恰好**带一个条件：三个都给或一个都不给都会在回放中途变成一个
      // 无意义的「等 3 秒」或空转，宁可在加载时就说清楚（与类型校验同一条理由）。
      if (st?.kind === "wait_for") {
        const given = [st.text, st.selector, st.gone].filter(
          (v) => typeof v === "string" && v.length > 0,
        ).length;
        if (given !== 1) {
          throw new Error(t("replay.err.badWaitFor", { path }));
        }
      }
    }
  }
  // 旧版本生成的脚本可能在定位符/用例原文里残留录制当次写死的取值；加载时就地还原，
  // 免去「为一个字段重跑一次十几分钟的 LLM 用例」。
  const normalized = normalizePlaceholderLiterals(parsed);
  if (normalized.length > 0) {
    info(t("replay.normalized", { items: normalized.join("，") }));
  }
  return parsed;
}

/** 已知的回放步骤类型（loadReplayScript 校验用）。 */
const REPLAY_STEP_KINDS: ReadonlySet<string> = new Set<ReplayStepKind>([
  "navigate",
  "click",
  "fill",
  "upload",
  "download",
  "hover",
  "scroll",
  "wait",
  "wait_for",
  "assert_text",
]);

/** 形如 `${name}` 或 `${name:fmt}` 的运行时变量占位符。 */
const PLACEHOLDER_TOKEN = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::[^}]*)?\}/;

/** 带捕获组的全局版：split 后奇数位是各占位符原文（按出现顺序）。 */
const PLACEHOLDER_SPLIT = new RegExp(`(${PLACEHOLDER_TOKEN.source})`, "g");

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 从「占位符写法 + 录制当次字面量」的成对字段里反推出替换表。
 *
 * `fill.value` / `assert_text.expectation` 与它们各自的 `recorded*` 字段就是这样一对
 * （如 `自动化测试产品${timestamp}` 与 `自动化测试产品202609211103`）。
 * 把占位符两侧的固定部分对齐，剩下那段就是当次展开出的取值。
 * 一处写法里可能有**多个**占位符（如 `${date}-${time}`），每个都要各对上一段。
 */
function deriveSubstitutions(script: ReplayScript): Map<string, string> {
  const map = new Map<string, string>();
  const consider = (placeholderized?: string, literal?: string): void => {
    if (!placeholderized || !literal) return;
    // split 带捕获组：[固定段, 占位符, 固定段, …, 固定段]
    const parts = placeholderized.split(PLACEHOLDER_SPLIT);
    const tokens: string[] = [];
    const segments: string[] = [];
    for (const [i, part] of parts.entries()) {
      if (i % 2 === 0) segments.push(part);
      else tokens.push(part);
    }
    if (tokens.length === 0) return;
    // 把固定段转义后拼成 ^seg(.+?)seg(.+?)seg$，各捕获组即占位符当次的取值。
    const pattern = new RegExp(
      "^" +
        segments
          .map((seg, i) =>
            i < tokens.length
              ? escapeRegExp(seg) + "(.+?)"
              : escapeRegExp(seg),
          )
          .join("") +
        "$",
    );
    const m = literal.match(pattern);
    if (!m) return;
    for (const [i, placeholder] of tokens.entries()) {
      const token = m[i + 1] ?? "";
      // 太短的取值替换起来容易误伤页面里的无关数字
      if (token.length < 4) continue;
      map.set(token, placeholder);
    }
  };
  for (const sc of script.scenarios) {
    for (const st of sc.steps) {
      if (st.kind === "fill") consider(st.value, st.recordedValue);
      else if (st.kind === "assert_text") {
        consider(st.expectation, st.recordedExpectation);
      }
    }
  }
  return map;
}

/**
 * 把脚本里**写死的录制取值**还原成占位符，返回实际发生的替换（供日志）。
 *
 * 为什么需要：`locator.name`（列表里点「刚创建的那条」）与 `caseSteps` 里都可能残留
 * 录制当次的具体时间戳，回放时新时间戳对不上，这一步必然定位失败。
 * 新录制的脚本已经不会再写死（录制时就还原了），但**旧脚本不必重跑 LLM 重录**——
 * 脚本自己带着 `recorded*` 证据，加载时即可就地修好。
 *
 * 只改写已知会承载「动态名称」的字段：用例原文、定位符名、填入值、断言期望。
 * 刻意不动 `file`（本地文件路径必须原样存在）与 `target`/`url`（可能是有意的字面量）。
 */
export function normalizePlaceholderLiterals(script: ReplayScript): string[] {
  const map = deriveSubstitutions(script);
  if (map.size === 0) return [];
  let changed = 0;
  const apply = (text: string): string => {
    let out = text;
    for (const [literal, placeholder] of map) {
      if (!out.includes(literal)) continue;
      changed += 1;
      out = out.split(literal).join(placeholder);
    }
    return out;
  };
  const applyLocator = (step: { locator: Locator | null }): void => {
    if (!step.locator) return;
    step.locator = {
      ...step.locator,
      name: apply(step.locator.name),
      // 祖先路径里同样可能带动态名字（如「产品库 (自动化测试产品202609211103)」）
      path: (step.locator.path ?? []).map(apply),
    };
  };

  for (const sc of script.scenarios) {
    sc.caseSteps = sc.caseSteps.map(apply);
    for (const st of sc.steps) {
      switch (st.kind) {
        case "fill":
          st.value = apply(st.value);
          applyLocator(st);
          break;
        case "assert_text":
          st.expectation = apply(st.expectation);
          break;
        case "wait_for":
          // 条件文本里同样可能残留录制当次写死的动态值（例如等「刚创建的那条产品」出现）：
          // 还原成占位符，回放时才能重新展开新时间戳（与 locator.name 同一条规则）。
          if (st.text) st.text = apply(st.text);
          break;
        case "click":
        case "hover":
        case "scroll":
        case "upload":
        case "download":
          applyLocator(st);
          break;
        default:
          break;
      }
    }
  }
  if (changed === 0) return [];
  return [...map].map(([literal, placeholder]) => `${literal} → ${placeholder}`);
}

/**
 * 检查源用例是否已变更：变更时返回提示文本（由调用方决定如何处理）。
 * 只警告不失败——用例文案变了不代表页面行为变了，硬失败会天天误报。
 */
export function sourceDriftNotice(script: ReplayScript): string | null {
  const { path, hash } = script.source;
  if (!path || !hash) return null;
  if (!existsSync(path)) return t("replay.drift.missing", { path });
  let current: string;
  try {
    current = scriptHash(readFileSync(path, "utf8"));
  } catch (err) {
    // 读不了（权限/占用）不该让整个回放崩掉：如实说明并跳过漂移检测。
    return t("replay.drift.unreadable", {
      path,
      msg: err instanceof Error ? err.message : String(err),
    });
  }
  if (current !== hash) {
    return t("replay.drift.changed", { path });
  }
  return null;
}

export interface ReplayOptions {
  session?: string;
  /** 启用 Jev 语义断言（默认关闭，保证回放不调用任何模型）。 */
  semantic?: boolean;
  debug?: boolean;
  /** 脚本路径，写进报告便于追溯。 */
  scriptPath?: string;
  /** 回放时刻，用于重新展开 `${...}` 占位符（同一次回放共用一个时刻）。 */
  now?: Date;
  /** 任一失败（含元素未找到）即停止该场景，不跑完剩余步骤。 */
  failFast?: boolean;
  /**
   * `--settle-waits`：把脚本里的 `wait` 步骤执行成「**等页面稳定，上限为记下的毫秒数**」。
   *
   * 为什么值得做：录制时模型给出的 `wait(2000)` 是它对「给页面一点时间」的**猜测**，回放却把
   * 这个猜测当成了事实——固定等待在每一次回放里都照付。实测一份 6 场景的脚本里，
   * `wait` 步骤占了墙钟的 47%（`--settle-waits` 之前 11s / 23s）。而回放真正需要的是
   * 「等到页面不再变化」，不是「等满 2 秒」。
   *
   * **默认关闭，且明确标注风险**：如果那次等待是为**页面之外**的事情留的（服务端正在生成
   * 导出文件、后台排队等），页面其实早已稳定，提前放行会让紧随其后的断言/下载假失败。
   * 因此这是显式开关：打开后轨迹里的 wait 行会如实写出实际等待（`页面已稳定（等待 120ms…）`），
   * 一旦出现「wait 变快之后紧跟的断言挂了」，就能一眼看到是这个开关造成的。
   */
  settleWaits?: boolean;
  /**
   * `--locate-timeout <ms>`：定位符**所在区域整体缺失**时，等页面就绪的上限
   * （默认 `DEFAULT_LOCATE_TIMEOUT_MS`，0 = 不等待）。
   *
   * 为什么默认要等：SPA 在 `load` 之后还要一两秒才渲染内容，而回放是**零思考时间**连着跑的
   * （录制时模型每步之间的思考时间顺带给了页面喘息）。实测事故：navigate 返回时页面只有 5 行的
   * 空壳，旧逻辑 1 秒内三次尝试全部落空，把「页面还没就绪」报成了「元素未找到 / 菜单点错了」。
   *
   * 边界很清楚：只在**区域也一起缺失**时等；区域在、或区域是没打开的浮层时立刻判定，
   * 因此「元素真的不存在」的常见情形不会被拖慢（详见 DEFAULT_LOCATE_TIMEOUT_MS）。
   */
  locateTimeoutMs?: number;
}

export interface ReplayRunResult {
  report: TestReport;
  text: string;
  json: string;
  transcript: string;
  usage: TokenUsage;
}

/** 单场景回放结果 + 套件汇总所需的明细。 */
interface ScenarioOutcome {
  result: ReplayRunResult;
  detail: ScenarioDetail;
}

/** 把回放步骤的可读标签与被映射到的用例步骤原文拼给报告用。 */
function stepContext(
  step: ReplayStep,
  index: number,
  caseSteps: string[],
): string {
  const parts = [t("replay.step.label", { index, kind: step.kind })];
  if (step.step && step.step >= 1 && step.step <= caseSteps.length) {
    parts.push(
      t("replay.step.caseRef", {
        step: step.step,
        text: caseSteps[step.step - 1],
      }),
    );
  }
  return parts.join("，");
}

/**
 * 当前页面里找不到要操作的元素。
 *
 * 单独区分出来，是因为它与「操作失败」不是一回事：元素不存在说明**当前页面状态下这一步不需要**
 * ——最典型的是录制期模型顺手点的「取 消」这类补救/清理动作（提交后弹窗没关，模型点取消补一下），
 * 回放时页面更顺利、弹窗早已关闭，那个按钮根本不存在。
 * 这类步骤按「跳过」处理并继续，而不是让一条 65 步的长流程在第 12 步整条报废。
 */
export class LocatorMissError extends Error {}

/**
 * 等过一轮「页面就绪」之后仍然找不到。
 *
 * 单独一类是为了**不再叠加重试**：那轮等待（默认 8s）已经把「等一等就会到」这件事做完了，
 * 再重试三轮等于把同一个等待重复三遍（旧逻辑里 1 秒 × 3 次白等的正是这笔账）。
 * 它依旧是 LocatorMissError，因此失败语义不变：记为跳过并继续。
 */
export class LocatorWaitTimeoutError extends LocatorMissError {}

/**
 * 定位不到时「等页面就绪」的默认上限（`--locate-timeout`）。
 *
 * 只在**定位符所在区域整体缺失**时才会用上（判据见 locator.inspectRegion）——那时页面多半
 * 还在渲染：SPA 在 `load` 之后还要一两秒才画出内容（实测本机：navigate 1.7s 返回时快照只有
 * 5 行（空壳），3.9s 才有 236 行的筛选表单）。区域在、或区域是没打开的浮层，一律立刻判定。
 *
 * 代价必须写明，否则就是在偷偷拖慢回放：当某元素**真的**不存在、而它所在区域也一起不存在时
 * （例如整个表单都不在该页面上），这一步会等满上限才报「未找到」。觉得慢用 `--locate-timeout 0`
 * 关掉等待，退回「立刻判定」的旧行为。
 */
export const DEFAULT_LOCATE_TIMEOUT_MS = 8_000;

/** 轮询间隔：每次轮询是一次快照往返，250ms 够密到不错过就绪瞬间，也不至于把 daemon 打满。 */
const LOCATE_POLL_MS = 250;

/** 一次定位解析的等待参数。 */
interface LocateOptions {
  /** 结构未就绪时的轮询上限（毫秒）；0 表示不等待、立刻判定失败。 */
  timeoutMs: number;
  /** 轮询间隔（毫秒）；单测会调小。 */
  pollMs: number;
  /** 回放轨迹：等待过程写进去，报告里能看到这一步为什么贵。 */
  trace: string[];
  /** 步骤标签，如 `#2 click`。 */
  label: string;
}

/** 快照行数（证据用：5 行的空壳与 236 行的完整页面一眼可辨）。 */
const countSnapshotLines = (text: string): number =>
  text.split(/\r?\n/).filter((l) => l.trim().length > 0).length;

/** 快照行数的变化写成一行可读证据，如 `5 → 5 → 236`（超过 6 次只留首尾各三次，中间用 `…`）。 */
function describeLineTrajectory(lines: readonly number[]): string {
  if (lines.length === 0) return "0";
  // 行数不可能是负数，-1 只做「省略」的哨兵
  const parts =
    lines.length <= 6
      ? [...lines]
      : [...lines.slice(0, 3), -1, ...lines.slice(-3)];
  return parts.map((n) => (n < 0 ? "…" : String(n))).join(" → ");
}

/**
 * 定位失败的报错：先说**所在区域在不在**（最决定性的一条），再说「页面上现在有什么」。
 *
 * 旧的写法只给后半句，于是「页面还没渲染出筛选表单」被报成了「多半是点到了另一个同名菜单/按钮」
 * 与「该菜单/弹窗此刻并未打开」——用户照着这句去查菜单，方向全错（事故经过见 inspectRegion）。
 * 现在把区域判定放在前面：区域缺失就是「页面还没就绪」，区域在才轮到「元素本身变了」。
 */
function locateMissError(
  wanted: Locator,
  target: string,
  snapshot: string,
  region: RegionState,
): LocatorMissError {
  const role = wanted.role || "?";
  const hint = locatorHint(wanted, snapshot);
  const nearby =
    hint.kind === "similar-name"
      ? t("replay.locate.similar", { role, items: hint.items.join("、") })
      : hint.kind === "role-only"
        ? t("replay.locate.roleOnly", {
            count: hint.roleCount,
            role,
            items: hint.items.join("、"),
            prefix: wanted.name.slice(0, 2),
          })
        : t("replay.locate.noRole", { role });
  const area =
    region.kind === "present"
      ? t("replay.locate.regionPresent", { region: region.label })
      : region.kind === "missing-overlay"
        ? t("replay.locate.regionOverlay", { region: region.label })
        : "";
  return new LocatorMissError(
    t("replay.locate.miss", {
      desc: describeLocator(wanted),
      target,
      detail: area + nearby,
    }),
  );
}

/**
 * 等页面把定位符所在的区域渲染出来，再解析一次。
 *
 * 与 `wait_for` 同一条思路：等的是**真正需要的那件东西**，不是「页面稳定」这个代理指标，
 * 因此不存在提前放行的风险——解析到才继续，解析不到就按上限报错。
 * 每次轮询都用 `fresh` 强制取新快照，否则会连续几次拿到同一份旧快照（见 BskOps.snapshot）。
 */
async function resolveByWaiting(
  ops: BskOps,
  wanted: Locator,
  target: string,
  region: { label: string },
  initialLines: number,
  locate: LocateOptions,
): Promise<string> {
  info(
    t("replay.log.waitReady", {
      label: locate.label,
      region: region.label,
      limit: locate.timeoutMs,
    }),
  );
  // 轨迹以「区域已缺失」的那次快照开头：它确实被观察到了，证据要完整
  const lines: number[] = [initialLines];
  const outcome = await pollUntil<{ ref: string | null }>({
    timeoutMs: locate.timeoutMs,
    intervalMs: locate.pollMs,
    sleep,
    now: Date.now,
    sample: async () => {
      const text = await ops.snapshot(undefined, { fresh: true });
      lines.push(countSnapshotLines(text));
      return { ref: resolveLocator(wanted, text) };
    },
    isHit: (sample) => sample.ref !== null,
  });
  const ref = outcome.hit ? (outcome.last?.ref ?? null) : null;
  const linesText = describeLineTrajectory(lines);
  if (ref) {
    locate.trace.push(
      t("replay.wait.trace", {
        label: locate.label,
        waited: outcome.waitedMs,
        polls: outcome.polls,
        lines: linesText,
        ref,
      }),
    );
    return ref;
  }
  throw new LocatorWaitTimeoutError(
    t("replay.locate.missWaiting", {
      desc: describeLocator(wanted),
      target,
      waited: outcome.waitedMs,
      polls: outcome.polls,
      lines: linesText,
      region: region.label,
      limit: locate.timeoutMs,
    }),
  );
}

/**
 * 解析这一步该操作哪个元素。
 *
 * 优先用语义定位符在当前快照里重新解析（页面微调也能命中）；解析不到时按**所在区域**分流：
 * - 区域整体缺失（页面还没渲染到那一步）→ 等页面就绪（上限见 DEFAULT_LOCATE_TIMEOUT_MS）；
 * - 区域在、或区域是没打开的浮层 → 立刻判定「找不到」，交给上层重试/跳过。
 *
 * 退回 target 的规则不变：CSS 选择器还能直接用，`@eN` 则已失效。
 */
async function resolveStepTarget(
  ops: BskOps,
  target: string,
  locator: Locator | null,
  expand: (text: string) => string,
  locate: LocateOptions,
): Promise<string> {
  if (locator && (locator.role || locator.name)) {
    const wanted: Locator = { ...locator, name: expand(locator.name) };
    const snapshot = await ops.snapshot();
    const ref = resolveLocator(wanted, snapshot);
    if (ref) return ref;
    // CSS target 还能直接试（不依赖快照编号）
    if (!isRef(target)) return expand(target);
    const region = inspectRegion(wanted, snapshot);
    if (region.kind === "missing-structure" && locate.timeoutMs > 0) {
      return await resolveByWaiting(
        ops,
        wanted,
        target,
        region,
        countSnapshotLines(snapshot),
        locate,
      );
    }
    throw locateMissError(wanted, target, snapshot, region);
  }
  if (!isRef(target)) return expand(target);
  throw new LocatorMissError(t("replay.locate.missRef", { target }));
}

/** 执行单个回放步骤；断言步骤额外返回解析好的断言结果。 */
async function runStep(
  ops: BskOps,
  step: ReplayStep,
  expand: (text: string) => string,
  settleWaits: boolean,
  locate: LocateOptions,
): Promise<{ text: string; assertion?: AssertionResult }> {
  switch (step.kind) {
    case "navigate":
      return { text: await ops.navigate(expand(step.url)) };
    case "click":
      return {
        text: await ops.click(
          await resolveStepTarget(ops, step.target, step.locator, expand, locate),
        ),
      };
    case "hover":
      return {
        text: await ops.hover(
          await resolveStepTarget(ops, step.target, step.locator, expand, locate),
        ),
      };
    case "scroll":
      return {
        text: await ops.scroll(
          await resolveStepTarget(ops, step.target, step.locator, expand, locate),
        ),
      };
    case "fill":
      return {
        text: await ops.fill(
          await resolveStepTarget(ops, step.target, step.locator, expand, locate),
          expand(step.value),
        ),
      };
    case "upload": {
      const target = step.target
        ? await resolveStepTarget(
            ops,
            step.target,
            step.locator,
            expand,
            locate,
          )
        : undefined;
      return { text: await ops.upload(target, expand(step.file)) };
    }
    case "download": {
      const expectation = downloadExpectation(step.expectName);
      let target: string;
      try {
        target = await resolveStepTarget(
          ops,
          step.target,
          step.locator,
          expand,
          locate,
        );
      } catch (err) {
        // 触发元素找不到**不按 skip 处理**：这一步承载断言，跳过等于把「该下载却没下载」
        // 洗成通过（普通动作的 skip 规则见 LocatorMissError，这里刻意不适用）。
        if (!(err instanceof LocatorMissError)) throw err;
        const reason = err instanceof Error ? err.message : String(err);
        const evidence = t("replay.download.triggerMissing", { reason });
        return { text: evidence, assertion: { expectation, verdict: "fail", evidence } };
      }
      const out = await ops.download(
        target,
        step.out ? expand(step.out) : undefined,
        step.expectName,
        step.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
      );
      // 与 assert_text 同一条规则：结论以工具的结构化结果为准（成立/不成立 + 证据），
      // 再对返回文本做一次解析等于把报告准源绑死在文案措辞上。
      const outcome = ops.lastAssert();
      return {
        text: out,
        assertion: outcome
          ? {
              expectation: outcome.expectation,
              verdict: outcome.pass ? "pass" : "fail",
              evidence: outcome.evidence,
            }
          : {
              expectation,
              verdict: "fail",
              evidence: t("replay.assert.unparsed", { out }),
            },
      };
    }
    case "wait":
      // `--settle-waits`：把这一步记下的秒数当作**上限**，页面稳定就提前放行（见 ReplayOptions）。
      return { text: settleWaits ? await ops.settle(step.ms) : await ops.wait(step.ms) };
    case "wait_for":
      // 与录制时同一条路径（ADR-0001）：等的是**条件**，达成即走，不达成等满上限。
      return {
        text: await ops.waitFor(
          {
            ...(step.text ? { text: expand(step.text) } : {}),
            ...(step.selector ? { selector: expand(step.selector) } : {}),
            ...(step.gone ? { gone: expand(step.gone) } : {}),
          },
          step.timeoutMs,
        ),
      };
    case "assert_text": {
      const expectation = expand(step.expectation);
      const out = await ops.assertText(expectation);
      // 结论以结构化结果为准：assertText 返回的文本是给人/模型看的，
      // 再对它做一次文本解析等于把报告准源绑死在那段文案的措辞上。
      const outcome = ops.lastAssert();
      return {
        text: out,
        assertion: outcome
          ? {
              expectation: outcome.expectation,
              verdict: outcome.pass ? "pass" : "fail",
              evidence: outcome.evidence,
            }
          : {
              expectation,
              verdict: "fail",
              evidence: t("replay.assert.unparsed", { out }),
            },
      };
    }
  }
}

/**
 * 执行一步并重试（默认最多 3 次，两次尝试之间等页面稳定）。
 *
 * 重试的理由有两类：bsk 侧的时序抖动（el-upload 首次触发可能返回
 * `did not activate a file input`，重试即成功），以及页面动画/弹窗延迟导致元素晚出现。
 * 定位每次都会重新取快照，所以对「稍后才出现」有效。
 *
 * 间隔从**固定 500ms** 换成了 `ops.settle()`（见 settle.ts）：固定的那 500ms 在
 * 「页面上根本没有这个元素」时纯属浪费——实测里这类 miss 占绝大多数（录制时模型顺手点的
 * 补救按钮，回放时弹窗早关了），而它本来只要重新取一次快照就能立刻得出同样结论。
 * settle 在页面已稳定时同步返回（一次 evaluate 往返），只在真的在加载/播动画时才等，
 * 上限 800ms。于是：真·缺失的步骤从 ~1s 降到毫秒级，动画中的步骤反而比原来更耐心。
 *
 * navigate 不适用这套逻辑（调用方传 attempts=1）：目标不可达时重试是纯浪费——
 * 连接被拒绝/域名解析失败不会因为等一下再试就变得可达，诊断文本里也是这么说的。
 *
 * `LocatorWaitTimeoutError` 也不重试：它已经是**等过一轮页面就绪**之后的结果
 * （见 resolveStepTarget 与 DEFAULT_LOCATE_TIMEOUT_MS），重复三轮只是把等待做三遍。
 */
async function runStepWithRetry(
  ops: BskOps,
  step: ReplayStep,
  expand: (text: string) => string,
  trace: string[],
  index: number,
  attempts: number,
  settleWaits: boolean,
  locate: LocateOptions,
): Promise<{ text: string; assertion?: AssertionResult }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await runStep(ops, step, expand, settleWaits, locate);
    } catch (err) {
      lastError = err;
      if (err instanceof LocatorWaitTimeoutError) break;
      if (attempt >= attempts) break;
      const reason = err instanceof Error ? err.message : String(err);
      trace.push(
        t("replay.retry.trace", { index, kind: step.kind, attempt, attempts, reason }),
      );
      debugLog(t("replay.retry.debug", { index, reason }));
      await ops.settle();
    }
  }
  throw lastError;
}

/**
 * 场景结论：**任一断言不成立、任一失败步骤、或中途中止** → fail。
 *
 * 单独抽成纯函数是因为它曾经写错过一次：只统计「抛出的步骤失败」而漏掉
 * 「断言返回不成立」，结果一条带 FAIL 断言的用例报了 PASS 与非零之外的退出码——
 * 假通过比报错危险得多，这里用单测钉死。
 * 跳过（元素未找到）不影响结论：页面真的退化时，后续步骤或断言会暴露出来。
 */
export function replayScenarioStatus(outcome: {
  failed: number;
  aborted: string | null;
  assertions: AssertionResult[];
}): "pass" | "fail" {
  const assertionFailed = outcome.assertions.some((a) => a.verdict === "fail");
  return outcome.failed > 0 || outcome.aborted !== null || assertionFailed
    ? "fail"
    : "pass";
}

/** 单场景的步骤执行结果（纯执行结果，不含 session 生命周期与报告组装）。 */
export interface ReplayStepOutcome {
  trace: string[];
  assertions: AssertionResult[];
  outputs: string[];
  /** 因「元素未找到」被跳过的步骤描述（不算失败，但必须让人看见）。 */
  skipped: string[];
  /** 已成功执行的最后一步序号。 */
  executed: number;
  /** 失败（不含跳过）的步骤数。 */
  failed: number;
  /** 中止时的步骤标签；未中止为 null。 */
  aborted: string | null;
  /**
   * 每步（含重试与等待在内）的耗时明细，按步骤类型聚合。
   *
   * 回放的墙钟就是「步数 × 每步命令耗时」，而每步的耗时只有在这里量得到（含重试）；
   * 汇总后写进日志，用来回答「回放慢在哪一类命令上」——见 timing.ts。
   */
  timing: TimingCollector;
}

export interface ReplayStepOptions {
  /** 展开 `${...}` 占位符。 */
  expand: (text: string) => string;
  /** 本次回放是否启用了 Jev 语义断言。 */
  jevActive: boolean;
  /** 任一失败即停止该场景（默认关：跑完才能给出完整健康报告）。 */
  failFast?: boolean;
  /** 单步重试次数（默认 3）。 */
  attempts?: number;
  /** `wait` 步骤是否按「等页面稳定、上限为记下的毫秒数」执行（见 ReplayOptions.settleWaits）。 */
  settleWaits?: boolean;
  /**
   * 定位符所在区域整体缺失时，等页面就绪的上限（毫秒，默认 DEFAULT_LOCATE_TIMEOUT_MS）。
   * `0` 表示不等待，立刻判定「元素未找到」（旧行为）。
   */
  locateTimeoutMs?: number;
  /** 轮询间隔（毫秒，默认 250）。单测把它调小，免得测试真的等下去。 */
  locatePollMs?: number;
}

/**
 * 按顺序执行一个场景的全部步骤（不碰 session 生命周期，便于单测）。
 *
 * 失败语义：
 * - **元素未找到** → 记为「跳过」并继续。这是「当前页面状态下这一步不需要」，
 *   而非页面退化的证据；真正的退化会由后续步骤或断言暴露出来。
 * - **其它失败**（元素找到了但操作报错、断言不成立）→ 记为失败并继续，跑完给出全貌。
 * - **navigate 失败** → 后续步骤已无意义，直接中止。
 * 失败一律不会被吞掉：都会变成报告里的一条 FAIL 断言 + 非零退出码。
 */
export async function executeReplaySteps(
  ops: BskOps,
  scenario: ReplayScenario,
  opts: ReplayStepOptions,
): Promise<ReplayStepOutcome> {
  const outcome: ReplayStepOutcome = {
    trace: [],
    assertions: [],
    outputs: [],
    skipped: [],
    executed: 0,
    failed: 0,
    aborted: null,
    timing: new TimingCollector(),
  };
  const attempts = opts.attempts ?? 3;

  for (const [i, step] of scenario.steps.entries()) {
    const index = i + 1;
    const label = `#${index} ${step.kind}`;
    // navigate 不重试：目标不可达时 500ms 后再试一次也不会变得可达（理由见 runStepWithRetry）。
    const stepAttempts = step.kind === "navigate" ? 1 : attempts;
    // 定位等待参数带步骤标签（轨迹与报错里要能指回具体哪一步），因此逐步骤构造
    const locate: LocateOptions = {
      timeoutMs: opts.locateTimeoutMs ?? DEFAULT_LOCATE_TIMEOUT_MS,
      pollMs: opts.locatePollMs ?? LOCATE_POLL_MS,
      trace: outcome.trace,
      label,
    };
    const startedAt = Date.now();
    info(t("replay.log.step", { label }));
    try {
      const out = await runStepWithRetry(
        ops,
        step,
        opts.expand,
        outcome.trace,
        index,
        stepAttempts,
        opts.settleWaits ?? false,
        locate,
      );
      outcome.executed = index;
      const cost = Date.now() - startedAt;
      // cost 覆盖了这一步的全部尝试与等待（含重试），正是「这一步有多贵」的口径。
      outcome.timing.noteCommand(step.kind, cost);
      outcome.trace.push(`[replay-ok] ${label} ${cost}ms`);
      if (out.text) outcome.outputs.push(out.text);
      if (out.assertion) {
        // 录制时靠 Jev 语义复核才成立的断言（字面不含期望文本），在零模型的
        // 字符串匹配下必然不成立；失败时点明原因并给出可执行的下一步，
        // 而不是让人盯着「不成立」猜。
        if (
          out.assertion.verdict === "fail" &&
          !opts.jevActive &&
          step.kind === "assert_text" &&
          step.semantic
        ) {
          out.assertion.evidence =
            (out.assertion.evidence ? out.assertion.evidence + "；" : "") +
            t("replay.assert.semanticHint");
        }
        outcome.assertions.push(out.assertion);
      }
      info(
        t("replay.log.ok", {
          label,
          cost,
          assert: out.assertion
            ? t(
                out.assertion.verdict === "pass"
                  ? "replay.log.okAssertPass"
                  : "replay.log.okAssertFail",
              )
            : "",
        }),
      );
      continue;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const cost = Date.now() - startedAt;
      const context = stepContext(step, index, scenario.caseSteps);

      // 元素不存在 = 当前页面状态下不需要这一步，跳过并继续（但要在报告里点名）
      if (err instanceof LocatorMissError && !opts.failFast) {
        outcome.skipped.push(`${context}：${reason}`);
        // 跳过也照记耗时：它跑了完整的重试（每次都要重新取快照），
        // 而「元素不存在」这一类正是最值得从统计里看出来的浪费。
        outcome.timing.noteCommand(step.kind, cost);
        outcome.trace.push(`[replay-skip] ${label}：${reason}`);
        info(t("replay.log.skip", { label, cost, reason }));
        continue;
      }

      outcome.failed += 1;
      outcome.timing.noteCommand(step.kind, cost, true);
      outcome.trace.push(`[replay-error] ${label}：${reason}`);
      info(t("replay.log.fail", { label, cost, reason }));
      const giveUp = step.kind === "navigate" || opts.failFast === true;
      outcome.assertions.push({
        expectation: t("replay.assert.stepOk", { context }),
        verdict: "fail",
        evidence:
          t("replay.evidence.attempts", { reason, attempts: stepAttempts }) +
          (giveUp
            ? t("replay.evidence.aborted") +
              (index < scenario.steps.length
                ? t("replay.evidence.remaining", {
                    from: index + 1,
                    to: scenario.steps.length,
                  })
                : "")
            : t("replay.evidence.continued")),
      });
      if (giveUp) {
        outcome.aborted = label;
        break;
      }
    }
  }
  return outcome;
}

/** 回放一个场景：自带 session 生命周期，逐步执行并在失败处停止。 */
async function replayScenario(
  name: string,
  scenario: ReplayScenario,
  opts: ReplayOptions,
): Promise<ScenarioOutcome> {
  const now = opts.now ?? new Date();
  const startedAt = Date.now();
  const expand = (text: string) => expandVars(text, now);
  let session: string | undefined;
  let outcome: ReplayStepOutcome = {
    trace: [],
    assertions: [],
    outputs: [],
    skipped: [],
    executed: 0,
    failed: 0,
    aborted: null,
    timing: new TimingCollector(),
  };

  try {
    await ensureBskReady();
    session = await ensureSession(opts.session);
    info(t("replay.log.session", { session, name }));

    const jev = opts.semantic
      ? new JevClient(loadConfig().jev, opts.debug ?? false)
      : undefined;
    if (opts.semantic && !jev?.enabled) {
      info(t("replay.log.semanticOff"));
    }
    outcome = await executeReplaySteps(createBskOps(session, jev), scenario, {
      expand,
      jevActive: Boolean(jev?.enabled),
      failFast: opts.failFast ?? false,
      settleWaits: opts.settleWaits ?? false,
      locateTimeoutMs: opts.locateTimeoutMs,
    });
  } finally {
    // 回放同样在场景收尾统一清理下载产物（与带模型跑同一条规则，见 downloads.ts）。
    flushDownloadCleanup();
    if (session) await closeSession(session);
  }

  const { trace, assertions, skipped } = outcome;
  const status = replayScenarioStatus(outcome);
  // 耗时构成（墙钟 = 建 session + 逐步执行）：回放零模型，所以只会出现命令与「其它」两类。
  // 与录制路径一样只写日志，不写 stdout 报告（ADR-0002）。
  const wallMs = Date.now() - startedAt;
  for (const line of renderTiming(outcome.timing.summary(wallMs))) info(line);
  const report: TestReport = {
    mode: "replay",
    script: opts.scriptPath,
    status,
    assertions,
    skipped,
    summary: [
      t("replay.summary.executed", {
        total: scenario.steps.length,
        executed: outcome.executed,
      }),
      skipped.length
        ? t("replay.summary.skipped", { count: skipped.length })
        : null,
      outcome.failed
        ? t("replay.summary.failed", { count: outcome.failed })
        : null,
    ]
      .filter(Boolean)
      .join("，"),
    transcript: [
      ...trace,
      ...outcome.outputs.map((o) => "    " + o.trim()),
    ].join("\n"),
    trace,
    steps: scenario.caseSteps,
    usage: emptyUsage(),
    durationMs: Date.now() - startedAt,
  };
  info(
    t("replay.log.scenarioEnd", {
      status: status === "pass" ? "PASS" : "FAIL",
      executed: outcome.executed,
      total: scenario.steps.length,
      extra:
        (skipped.length
          ? t("replay.log.scenarioEnd.skip", { count: skipped.length })
          : "") +
        (outcome.failed
          ? t("replay.log.scenarioEnd.fail", { count: outcome.failed })
          : ""),
    }),
  );

  const result: ReplayRunResult = {
    report,
    text: renderText(report),
    json: JSON.stringify(report, null, 2),
    transcript: report.transcript,
    usage: report.usage ?? emptyUsage(),
  };
  return {
    result,
    detail: {
      name,
      status: report.status,
      steps: scenario.caseSteps,
      trace,
      assertions,
    },
  };
}

/**
 * 回放整个脚本：单场景按单份报告输出；多场景逐个回放（各自独立 session/窗口）并汇总，
 * 汇总语义与 `--suite` 一致——任一场景失败则整体失败、退出码非零。
 */
export async function runReplayScript(
  script: ReplayScript,
  opts: ReplayOptions = {},
): Promise<ReplayRunResult> {
  const scenarios = script.scenarios;
  info(
    t("replay.log.scriptStart", {
      path: opts.scriptPath ?? "(内存)",
      count: scenarios.length,
      semantic: opts.semantic ? t("replay.log.scriptStart.semantic") : "",
    }),
  );
  // `--settle-waits` 改变了 wait 步骤的语义（不再等满，而是等到稳定）：先说清它会影响几步、
  // 以及失败时该看哪里——这个开关的风险正好落在「提前放行」上，不能让人事后猜。
  if (opts.settleWaits) {
    const waitSteps = scenarios.reduce(
      (n, sc) => n + sc.steps.filter((s) => s.kind === "wait").length,
      0,
    );
    info(t("replay.log.settleWaits", { count: waitSteps }));
  }
  // 录制时靠 Jev 语义复核才成立的断言（如「检出成功」「标题包含 Example」这类
  // 字面不出现在页面上的措辞），默认的字符串包含匹配必然判为不成立。
  // 开始前就说清楚，别等跑到一半才让人猜。
  if (!opts.semantic) {
    const semanticAssertions = scenarios.reduce(
      (n, sc) =>
        n +
        sc.steps.filter((s) => s.kind === "assert_text" && s.semantic).length,
      0,
    );
    if (semanticAssertions > 0) {
      info(t("replay.log.semanticWarn", { count: semanticAssertions }));
    }
  }

  if (scenarios.length === 1) {
    return (await replayScenario(scenarios[0].name, scenarios[0], opts)).result;
  }

  const outcomes: ScenarioOutcome[] = [];
  // 多场景套件的墙钟起点（单场景路径保留场景自身的 durationMs，不需要这里）。
  const suiteStartedAt = Date.now();
  for (const [i, sc] of scenarios.entries()) {
    info(
      t("replay.log.suiteScenario", {
        index: i + 1,
        total: scenarios.length,
        name: sc.name,
      }),
    );
    const outcome = await replayScenario(sc.name, sc, opts);
    outcomes.push(outcome);
  }

  const summary = summarizeSuite(
    outcomes.map((o) => ({
      name: o.detail.name,
      report: o.result.report,
      usage: o.result.usage,
    })),
  );
  summary.durationMs = Date.now() - suiteStartedAt;
  summary.mode = "replay";
  summary.script = opts.scriptPath;
  const text = renderSuiteText(
    summary,
    outcomes.map((o) => ({ report: o.result.report, usage: o.result.usage })),
    scenarios.map((s) => ({ name: s.name, body: "" })),
  );
  info(t("replay.log.suiteSummary", { summary: summary.summary ?? "" }));
  return {
    report: summary,
    text,
    json: JSON.stringify(summary, null, 2),
    transcript: summary.transcript,
    usage: summary.usage ?? emptyUsage(),
  };
}
