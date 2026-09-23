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
import {
  closeSession,
  createBskOps,
  ensureBskReady,
  ensureSession,
  type BskOps,
} from "./bsk/tools.js";
import { loadConfig } from "./config.js";
import { t } from "./i18n.js";
import { JevClient } from "./jev.js";
import {
  describeLocator,
  isRef,
  locatorHint,
  resolveLocator,
  type Locator,
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
import { expandVars } from "./vars.js";

export const REPLAY_FORMAT = "pageqa-replay";
export const REPLAY_VERSION = 1;

/** 回放步骤的类型。`snapshot` 不在其中：它只服务于模型的「观察」，回放不需要。 */
export type ReplayStepKind =
  | "navigate"
  | "click"
  | "fill"
  | "upload"
  | "hover"
  | "scroll"
  | "wait"
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
  | ReplayNavigateStep
  | ReplayWaitStep
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
  "hover",
  "scroll",
  "wait",
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
        case "click":
        case "hover":
        case "scroll":
        case "upload":
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
 * 解析这一步该操作哪个元素。
 *
 * 优先用语义定位符在当前快照里重新解析（页面微调也能命中）；
 * 解析不到时退回录制时的 target——它是 CSS 选择器就还能用，是 `@eN` 则已失效。
 */
async function resolveStepTarget(
  ops: BskOps,
  target: string,
  locator: Locator | null,
  expand: (text: string) => string,
): Promise<string> {
  if (locator && (locator.role || locator.name)) {
    const snapshot = await ops.snapshot();
    const wanted: Locator = { ...locator, name: expand(locator.name) };
    const ref = resolveLocator(wanted, snapshot);
    if (ref) return ref;
    // CSS target 还能直接试；否则只能报错——但要顺带说清「页面上现在有什么」
    if (!isRef(target)) return expand(target);
    const role = wanted.role || "?";
    const hint = locatorHint(wanted, snapshot);
    const detail =
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
    throw new LocatorMissError(
      t("replay.locate.miss", {
        desc: describeLocator(locator),
        target,
        detail,
      }),
    );
  }
  if (!isRef(target)) return expand(target);
  throw new LocatorMissError(t("replay.locate.missRef", { target }));
}

/** 执行单个回放步骤；断言步骤额外返回解析好的断言结果。 */
async function runStep(
  ops: BskOps,
  step: ReplayStep,
  expand: (text: string) => string,
): Promise<{ text: string; assertion?: AssertionResult }> {
  switch (step.kind) {
    case "navigate":
      return { text: await ops.navigate(expand(step.url)) };
    case "click":
      return {
        text: await ops.click(
          await resolveStepTarget(ops, step.target, step.locator, expand),
        ),
      };
    case "hover":
      return {
        text: await ops.hover(
          await resolveStepTarget(ops, step.target, step.locator, expand),
        ),
      };
    case "scroll":
      return {
        text: await ops.scroll(
          await resolveStepTarget(ops, step.target, step.locator, expand),
        ),
      };
    case "fill":
      return {
        text: await ops.fill(
          await resolveStepTarget(ops, step.target, step.locator, expand),
          expand(step.value),
        ),
      };
    case "upload": {
      const target = step.target
        ? await resolveStepTarget(ops, step.target, step.locator, expand)
        : undefined;
      return { text: await ops.upload(target, expand(step.file)) };
    }
    case "wait":
      return { text: await ops.wait(step.ms) };
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
 * 执行一步并重试（默认最多 3 次，每次间隔 500ms）。
 *
 * 重试的理由有两类：bsk 侧的时序抖动（el-upload 首次触发可能返回
 * `did not activate a file input`，重试即成功），以及页面动画/弹窗延迟导致元素晚出现。
 * 定位每次都会重新取快照，所以对「稍后才出现」有效；代价是失败步骤多花约 1 秒，
 * 比把一条长流程判死划算。
 *
 * navigate 不适用这套逻辑（调用方传 attempts=1）：目标不可达时重试是纯浪费——
 * 连接被拒绝/域名解析失败不会因为 500ms 后再试一次就变得可达，诊断文本里也是这么说的。
 */
async function runStepWithRetry(
  ops: BskOps,
  step: ReplayStep,
  expand: (text: string) => string,
  trace: string[],
  index: number,
  attempts: number,
): Promise<{ text: string; assertion?: AssertionResult }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await runStep(ops, step, expand);
    } catch (err) {
      lastError = err;
      if (attempt >= attempts) break;
      const reason = err instanceof Error ? err.message : String(err);
      trace.push(
        t("replay.retry.trace", { index, kind: step.kind, attempt, attempts, reason }),
      );
      debugLog(t("replay.retry.debug", { index, reason }));
      await ops.wait(500);
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
  };
  const attempts = opts.attempts ?? 3;

  for (const [i, step] of scenario.steps.entries()) {
    const index = i + 1;
    const label = `#${index} ${step.kind}`;
    // navigate 不重试：目标不可达时 500ms 后再试一次也不会变得可达（理由见 runStepWithRetry）。
    const stepAttempts = step.kind === "navigate" ? 1 : attempts;
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
      );
      outcome.executed = index;
      const cost = Date.now() - startedAt;
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
        outcome.trace.push(`[replay-skip] ${label}：${reason}`);
        info(t("replay.log.skip", { label, cost, reason }));
        continue;
      }

      outcome.failed += 1;
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
    });
  } finally {
    if (session) await closeSession(session);
  }

  const { trace, assertions, skipped } = outcome;
  const status = replayScenarioStatus(outcome);
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
