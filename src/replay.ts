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
  parseAssertions,
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
    throw new Error(`找不到回放脚本：${path}`);
  }
  let parsed: ReplayScript;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as ReplayScript;
  } catch (err) {
    throw new Error(
      `回放脚本不是合法 JSON：${path}（${err instanceof Error ? err.message : String(err)}）`,
    );
  }
  if (parsed?.format !== REPLAY_FORMAT) {
    throw new Error(
      `不是 pageqa 回放脚本（format=${String(parsed?.format)}）：${path}`,
    );
  }
  if (typeof parsed.version !== "number" || parsed.version > REPLAY_VERSION) {
    throw new Error(
      `回放脚本版本不支持（脚本 v${String(parsed.version)}，当前支持到 v${REPLAY_VERSION}）：${path}`,
    );
  }
  if (!Array.isArray(parsed.scenarios) || parsed.scenarios.length === 0) {
    throw new Error(`回放脚本没有可执行的场景：${path}`);
  }
  // 空脚本（例如录制时模型一步都没成功执行）必须明确拒绝：
  // 否则回放会「0 步全部通过」，把无效脚本伪装成一次成功的回归。
  const total = parsed.scenarios.reduce(
    (n, s) => n + (Array.isArray(s.steps) ? s.steps.length : 0),
    0,
  );
  if (total === 0) {
    throw new Error(
      `回放脚本不含任何可执行步骤（录制时模型未成功执行浏览器操作）：${path}\n` +
        "请先跑一次自然语言用例使其通过，再用 --emit-script 重新生成。",
    );
  }
  // 旧版本生成的脚本可能在定位符/用例原文里残留录制当次写死的取值；加载时就地还原，
  // 免去「为一个字段重跑一次十几分钟的 LLM 用例」。
  const normalized = normalizePlaceholderLiterals(parsed);
  if (normalized.length > 0) {
    info(
      `[pageqa] 已把脚本里写死的录制取值还原为占位符（回放时重新展开）：${normalized.join("，")}`,
    );
  }
  return parsed;
}

/** 形如 `${name}` 或 `${name:fmt}` 的运行时变量占位符。 */
const PLACEHOLDER_TOKEN = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::[^}]*)?\}/;

/**
 * 从「占位符写法 + 录制当次字面量」的成对字段里反推出替换表。
 *
 * `fill.value` / `assert_text.expectation` 与它们各自的 `recorded*` 字段就是这样一对
 * （如 `自动化测试产品${timestamp}` 与 `自动化测试产品202609211103`）。
 * 把占位符两侧的固定部分对齐，剩下那段就是当次展开出的取值。
 */
function deriveSubstitutions(script: ReplayScript): Map<string, string> {
  const map = new Map<string, string>();
  const consider = (placeholderized?: string, literal?: string): void => {
    if (!placeholderized || !literal) return;
    const m = placeholderized.match(PLACEHOLDER_TOKEN);
    if (!m || m.index === undefined) return;
    const prefix = placeholderized.slice(0, m.index);
    const suffix = placeholderized.slice(m.index + m[0].length);
    if (!literal.startsWith(prefix) || !literal.endsWith(suffix)) return;
    const token = literal.slice(prefix.length, literal.length - suffix.length);
    // 太短的取值替换起来容易误伤页面里的无关数字
    if (token.length < 4) return;
    map.set(token, m[0]);
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
  if (!existsSync(path)) return `源用例已不存在：${path}`;
  const current = scriptHash(readFileSync(path, "utf8"));
  if (current !== hash) {
    return `源用例内容已变更（${path}）：脚本基于录制时的版本，建议重新用 LLM 跑一次并重新生成`;
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
  const parts = [`回放第 ${index} 步（${step.kind}）`];
  if (step.step && step.step >= 1 && step.step <= caseSteps.length) {
    parts.push(`对应用例第 ${step.step} 步：${caseSteps[step.step - 1]}`);
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
        ? `；当前页面中名字相近的 ${role} 元素：${hint.items.join("、")}`
        : hint.kind === "role-only"
          ? `；当前页面有 ${hint.roleCount} 个 role=${role} 元素` +
            `（${hint.items.join("、")}），但没有名字含「${wanted.name.slice(0, 2)}」的` +
            `——多半是点到了另一个同名菜单/按钮`
          : `；当前页面中没有 role=${role} 的可见元素，说明该菜单/弹窗此刻并未打开`;
    throw new LocatorMissError(
      `无法在当前页面重新定位元素：${describeLocator(locator)}（录制时为 ${target}）${detail}`,
    );
  }
  if (!isRef(target)) return expand(target);
  throw new LocatorMissError(
    `无法在当前页面重新定位元素：${target}（引用已失效，且录制时未拿到语义定位符）`,
  );
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
      const parsed = parseAssertions(out)[0];
      return {
        text: out,
        assertion: parsed ?? {
          expectation,
          verdict: "fail",
          evidence: `无法解析断言结果：${out}`,
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
        `[replay-retry] #${index} ${step.kind}（第 ${attempt}/${attempts} 次失败）：${reason}`,
      );
      debugLog(`[replay] 第 ${index} 步失败，准备重试：${reason}`);
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
    const startedAt = Date.now();
    info(`[pageqa] ▶ ${label} …`);
    try {
      const out = await runStepWithRetry(
        ops,
        step,
        opts.expand,
        outcome.trace,
        index,
        attempts,
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
            "该断言在录制时靠 Jev 语义判断成立（字面不含期望文本），字符串匹配必然不成立——可加 --semantic 重试";
        }
        outcome.assertions.push(out.assertion);
      }
      info(
        `[pageqa] ✓ ${label} ${cost}ms` +
          (out.assertion
            ? `（断言${out.assertion.verdict === "pass" ? "成立" : "不成立"}）`
            : ""),
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
        info(`[pageqa] ⚠ ${label} ${cost}ms 元素未找到，已跳过并继续：${reason}`);
        continue;
      }

      outcome.failed += 1;
      outcome.trace.push(`[replay-error] ${label}：${reason}`);
      info(`[pageqa] ✗ ${label} ${cost}ms：${reason}`);
      const giveUp = step.kind === "navigate" || opts.failFast === true;
      outcome.assertions.push({
        expectation: `${context} 成功`,
        verdict: "fail",
        evidence:
          `${reason}；已尝试 ${attempts} 次仍失败` +
          (giveUp
            ? `，回放在此停止` +
              (index < scenario.steps.length
                ? `；未执行到的步骤：回放第 ${index + 1}~${scenario.steps.length} 步`
                : "")
            : "，已跳过该步并继续执行剩余步骤"),
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
    info(`[pageqa] 回放 session=${session}（场景：${name}）`);

    const jev = opts.semantic
      ? new JevClient(loadConfig().jev, opts.debug ?? false)
      : undefined;
    if (opts.semantic && !jev?.enabled) {
      info(
        "[pageqa] --semantic 已指定，但 Jev 未启用（缺 enabled/apiKey），断言退回字符串匹配",
      );
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
      `回放 ${scenario.steps.length} 步，执行 ${outcome.executed} 步`,
      skipped.length ? `跳过 ${skipped.length} 步（元素未找到）` : null,
      outcome.failed ? `失败 ${outcome.failed} 步` : null,
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
  };
  info(
    `[pageqa] 场景回放结束：${status === "pass" ? "PASS" : "FAIL"}` +
      `（执行 ${outcome.executed}/${scenario.steps.length} 步` +
      (skipped.length ? `，跳过 ${skipped.length} 步` : "") +
      (outcome.failed ? `，失败 ${outcome.failed} 步` : "") +
      "）",
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
    `[pageqa] 回放脚本：${opts.scriptPath ?? "(内存)"}，共 ${scenarios.length} 个场景，` +
      `零模型执行${opts.semantic ? "（断言使用 Jev 语义判断）" : ""}`,
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
      info(
        `[pageqa] 注意：脚本中有 ${semanticAssertions} 条断言在录制时靠 Jev 语义判断成立` +
          `（字面不含期望文本），回放默认用字符串包含匹配必然不成立；需要语义判断请加 --semantic`,
      );
    }
  }

  if (scenarios.length === 1) {
    return (await replayScenario(scenarios[0].name, scenarios[0], opts)).result;
  }

  const outcomes: ScenarioOutcome[] = [];
  for (const [i, sc] of scenarios.entries()) {
    info(`[pageqa] ═══ 场景 ${i + 1}/${scenarios.length}：${sc.name} ═══`);
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
  summary.mode = "replay";
  summary.script = opts.scriptPath;
  const text = renderSuiteText(
    summary,
    outcomes.map((o) => ({ report: o.result.report, usage: o.result.usage })),
    scenarios.map((s) => ({ name: s.name, body: "" })),
  );
  info(`[pageqa] 回放汇总：${summary.summary}`);
  return {
    report: summary,
    text,
    json: JSON.stringify(summary, null, 2),
    transcript: summary.transcript,
    usage: summary.usage ?? emptyUsage(),
  };
}
