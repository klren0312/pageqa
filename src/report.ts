import { t } from "./i18n.js";

export interface AssertionResult {
  expectation: string;
  verdict: "pass" | "fail";
  evidence?: string;
}

/** 一次运行的 LLM token 用量汇总（跨多轮对话累加）。 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  /** 端点给出的 totalTokens 之和（缺失时按 input+output+缓存 计算）。 */
  total: number;
  /** LLM 调用次数（assistant 消息条数）。 */
  calls: number;
}

export interface TestReport {
  /**
   * 场景结论。`cancelled` 是第三种终态：用户在交互模式里主动中止了该场景。
   * 它既不是通过也不是失败——不计入退出码，也不写入回放脚本（半截轨迹录进去
   * 会让回放跑半个用例还可能报 PASS，见 ADR-0002 决策五）。
   */
  status: "pass" | "fail" | "cancelled";
  /** 被中止时的说明（`status === "cancelled"` 时存在）。 */
  cancelReason?: string;
  /** 运行模式：`llm`（自然语言解析，默认，旧报告无此字段）或 `replay`（零模型回放）。 */
  mode?: "llm" | "replay";
  /** 回放脚本路径（回放模式为所用脚本，LLM 模式为生成的脚本）。 */
  script?: string;
  /** 回放中因「元素未找到」被跳过的步骤（不算失败，但必须让人看见）。 */
  skipped?: string[];
  assertions: AssertionResult[];
  summary?: string;
  transcript: string;
  /** token 消耗，渲染在报告末尾；旧结构仍可用（可选字段）。 */
  usage?: TokenUsage;
  /** 执行轨迹（工具调用 + agent 的步骤自述），用于在报告里定位卡在哪一步。 */
  trace?: string[];
  /** 用例的步骤清单（按行编号），用于把「第 k 步」映射回用例原文。 */
  steps?: string[];
  /** 套件模式下的逐场景明细（含各自的 steps/trace），便于 CI 侧做失败归因。 */
  scenarios?: ScenarioDetail[];
}

/** 套件模式下的单个场景明细（写进 JSON 报告，供机器消费）。 */
export interface ScenarioDetail {
  name: string;
  status: "pass" | "fail" | "cancelled";
  steps: string[];
  trace: string[];
  assertions: AssertionResult[];
  /** 场景来源标注（用例文件路径，或「追加」）；批处理模式不设此字段。 */
  origin?: string;
}

/** 单次 LLM 调用的原始用量（pi-ai 的 `Usage`，字段允许缺失）。 */
export interface RawUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
}

/** 尚未发生 LLM 调用时的零用量。 */
export function emptyUsage(): TokenUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
    calls: 0,
  };
}

/** 累加一次 LLM 调用的用量。 */
export function addUsage(acc: TokenUsage, usage: RawUsage): TokenUsage {
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  return {
    input: acc.input + input,
    output: acc.output + output,
    cacheRead: acc.cacheRead + cacheRead,
    cacheWrite: acc.cacheWrite + cacheWrite,
    reasoning: acc.reasoning + (usage.reasoning ?? 0),
    total:
      acc.total + (usage.totalTokens ?? input + output + cacheRead + cacheWrite),
    calls: acc.calls + 1,
  };
}

/** 合并两份用量（多场景套件汇总用）。 */
export function mergeUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    total: a.total + b.total,
    calls: a.calls + b.calls,
  };
}

/**
 * 渲染成一行文本（报告末行）。
 * 端点未返回 usage 时如实标注，避免把「0 token」误读成真实消耗。
 */
export function formatUsage(usage?: TokenUsage, mode?: TestReport["mode"]): string {
  // 回放模式没有也不该有 token 消耗：直接写明「未调用大模型」，
  // 否则「合计 0」会被误读成端点没返回 usage。
  if (mode === "replay") return t("report.usage.replay");
  if (!usage) return t("report.usage.unavailable");
  const line = t("report.usage.line", {
    in: usage.input,
    out: usage.output,
    cr: usage.cacheRead,
    cw: usage.cacheWrite,
    total: usage.total,
    calls: usage.calls,
  });
  return usage.calls > 0 && usage.total === 0
    ? line + t("report.usage.noUsage")
    : line;
}

/**
 * 组装报告。
 *
 * 断言以 `assert_text` 工具的**结构化结果**为准（`toolAssertions`）：工具返回的
 * 「期望值 + 成立/不成立 + 证据」是确定性的，而模型自述的措辞千变万化——它常写成
 * 「…，断言成立。」，既没有期望值，也无法可靠解析，据此计数会把一条**全部通过**的
 * 用例报成「用例中的断言全部执行（实际 0/3）」的假失败。
 *
 * 只有在拿不到工具结果时（旧调用方、回放、纯文本输入）才退回解析结论文本，
 * 并沿用原有的关键字降级判定。
 */
export function buildReport(
  input: string,
  transcript: string,
  toolAssertions?: AssertionResult[],
  opts: { cancelled?: boolean } = {},
): TestReport {
  const assertions: AssertionResult[] =
    toolAssertions && toolAssertions.length > 0
      ? toolAssertions.map((a) => ({ ...a }))
      : parseAssertions(transcript);
  const { steps } = numberSteps(input);
  const trace = extractTrace(transcript);
  const lastNote = lastStepNote(trace);

  let status: "pass" | "fail";
  if (assertions.length > 0) {
    status = assertions.every((a) => a.verdict === "pass") ? "pass" : "fail";
  } else {
    // 无结构化断言：依据关键字与「不成立/失败」判定
    const negative = /不成立|未找到|失败|不存在|not found|fail|missing/.test(
      transcript,
    );
    status = negative ? "fail" : "pass";
  }

  // 被用户中止：不做完整性校验。
  // 下面两条校验（「断言全部执行」「全部步骤执行完成」）是为「正常跑完但没跑满」设计的，
  // 中止时它们必然不成立——塞进来就等于把「我不想等了」记成「这条用例挂了」，
  // 让退出码与报告一起说谎（ADR-0002 决策五）。
  if (opts.cancelled) {
    const progress = parseProgress(transcript);
    return {
      status: "cancelled",
      cancelReason: progress
        ? t("report.cancelWithProgress", {
            done: progress.done,
            total: progress.total,
          })
        : t("report.cancel"),
      assertions,
      summary: extractSummary(transcript),
      transcript,
      trace,
      steps,
    };
  }

  // 完整性校验：用例里写了 N 条断言，就应当看到 N 条结果；
  // 少了解析结果说明 agent 只跑了其中一部分（长流程最容易半途结束）。
  const expected = countAssertions(input);
  if (expected > 0 && assertions.length < expected) {
    status = "fail";
    assertions.push({
      expectation: t("report.assertIncomplete", {
        got: assertions.length,
        expected,
      }),
      verdict: "fail",
      evidence: [
        t("report.assertIncompleteEvidence1"),
        lastNote ? t("report.assertIncompleteEvidence2", { note: lastNote }) : null,
        tailTextOf(trace, 3),
      ]
        .filter(Boolean)
        .join("；"),
    });
  }

  // agent 自报的步骤进度未跑满，同样判失败；并指出「下一步该做哪一步」，便于据此改用例。
  const progress = parseProgress(transcript);
  if (progress && progress.done < progress.total) {
    status = "fail";
    const nextStep =
      steps.length === progress.total ? steps[progress.done] : undefined;
    assertions.push({
      expectation: t("report.stepsIncomplete", {
        done: progress.done,
        total: progress.total,
      }),
      verdict: "fail",
      evidence: [
        t("report.stepsIncompleteEvidence1"),
        lastNote ? t("report.stepsIncompleteEvidence2", { note: lastNote }) : null,
        nextStep
          ? t("report.stepsIncompleteEvidence3", {
              next: progress.done + 1,
              total: progress.total,
              step: nextStep,
            })
          : null,
        tailTextOf(trace, 3),
      ]
        .filter(Boolean)
        .join("；"),
    });
  }

  const summary = extractSummary(transcript);
  return { status, assertions, summary, transcript, trace, steps };
}

/** 统计用例（自然语言测试步骤）中的断言数量，用于校验执行完整性。
 *
 * 只统计「断言 <描述>」这类真正的断言行，排除「断言」被当作讨论对象的叙述用法
 * （如「断言失败时记录日志」「请检查断言结果」「断言的写法」）。
 *
 * 早期实现直接统计「断言」二字出现次数，会把叙述性文字也算成断言，
 * 使期望断言数虚高，进而把实际已全部通过的正常用例误判为
 * 「用例中的断言全部执行（实际 N/M）」，造成假失败。
 */
export function countAssertions(script: string): number {
  return (script.match(ASSERTION_PATTERN) ?? []).length;
}

/**
 * 断言行匹配：命中「断言」但排除其后紧跟叙述性词汇的用法。
 * 排除词覆盖「断言失败/未通过/未成立/不成立/结果/的/写法/类型/覆盖/次数/用于」等
 * 把「断言」当作被讨论对象的语境；未列出的普通描述（如「断言页面包含 A」）仍计入。
 */
const ASSERTION_PATTERN =
  /断言(?!失败|未通过|未成立|不成立|结果|的|写法|类型|覆盖|次数|用于)/g;

/**
 * 把用例按非空行编号，得到确定性的步骤序列（`### 步骤 k：<原文>`）。
 *
 * 以往步骤号由模型自己数，报告里只有「23/42」这样的数字，无法对应到用例的哪一行，
 * 出了错也不知道该改哪一句。改由 pageqa 统一编号后再交给 agent 后，模型输出的
 * 「步骤完成：k/n」即可直接映射回用例原文，报告就能指出「停在哪一步、下一步是什么」。
 *
 * 标题（`#`）与引用说明（`>`）行会被忽略，避免把文档性文字当成步骤。
 */
export function numberSteps(script: string): {
  numbered: string;
  steps: string[];
} {
  const steps = script
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith(">"));
  const numbered = steps.map((s, i) => `### 步骤 ${i + 1}：${s}`).join("\n");
  return { numbered, steps };
}

/**
 * 抽取执行轨迹：工具调用（`[tool]` / `[tool-ok]` / `[tool-error]`）、续跑与 agent 错误标记，
 * 以及 agent 的步骤自述（「第 k 步…」「步骤完成：k/n」）。
 * 用于在报告里还原「跑到哪一步、卡在哪一步」，而不是只给一个失败结论。
 */
export function extractTrace(transcript: string): string[] {
  const trace: string[] = [];
  for (const raw of transcript.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\[(?:tool|tool-ok|tool-error|continue|agent-error)\b/.test(line)) {
      trace.push(clip(line));
      continue;
    }
    // agent 常把多步写在同一行，按「第 k 步」切分后逐条保留
    for (const part of line.split(/(?=第\s*\d+\s*步)/)) {
      const p = part.trim();
      if (/第\s*\d+\s*步/.test(p) || /步骤完成\s*[:：]/.test(p)) {
        trace.push(clip(p));
      }
    }
  }
  return trace;
}

/** 最后一条 agent 的步骤自述（「第 k 步…」），用于说明卡点位置。 */
export function lastStepNote(trace: string[]): string | null {
  const notes = trace.filter((l) => /第\s*\d+\s*步/.test(l));
  return notes.at(-1) ?? null;
}

/** 轨迹末尾若干条，拼成「轨迹末尾：…」的说明文本。 */
function tailTextOf(trace: string[], n: number): string | null {
  if (trace.length === 0) return null;
  return t("report.traceTail", { tail: trace.slice(-n).join(" → ") });
}

/** 截断过长的一行，避免报告被单条长文本撑爆。 */
function clip(text: string, max = 160): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/**
 * 解析 agent 的进度声明「步骤完成：M/N」。
 * 取最后一次声明：续跑时 agent 会输出多条进度，只有最后一条代表当前状态。
 */
export function parseProgress(
  text: string,
): { done: number; total: number } | null {
  const re = /步骤完成\s*[:：]\s*(\d+)\s*[/／]\s*(\d+)/g;
  const matches = [...text.matchAll(re)];
  const m = matches.at(-1);
  if (!m) return null;
  const done = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0)
    return null;
  return { done, total };
}

export function parseAssertions(text: string): AssertionResult[] {
  const results: AssertionResult[] = [];
  // 预处理：
  //   1) 去掉 markdown 加粗标记（agent 常输出「…：**成立**」）
  //   2) 把「成立/不成立」前的换行折回同一行
  const cleaned = text
    .replace(/\*\*|__/g, "")
    .replace(/[ \t]*\n[ \t]*(?=(?:成立|不成立))/g, "");
  // 匹配两种常见句式（描述里可含「」/引号等标点）：
  //   断言 X：成立/不成立。证据...
  //   断言「X」成立。证据...
  const re = /断言\s*(.+?)\s*(?:[:：]\s*)?(不成立|成立)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const expectation = stripEdges(m[1]);
    const verdict = m[2] === "成立" ? "pass" : "fail";
    const after = cleaned.slice(m.index + m[0].length).split("\n")[0];
    const evidence = stripEdges(after);
    results.push({ expectation, verdict, evidence: evidence || undefined });
  }
  return results;
}

/** 去掉首尾的连接符/标点噪声（agent 常写「…：**成立**，证据…」「…」——成立）。 */
function stripEdges(text: string): string {
  return text
    .replace(/^[\s,，。、;；:：]+/, "")
    .replace(/[\s,，。、;；:：\-—]+$/, "")
    .trim();
}

function extractSummary(text: string): string {
  // 取最后一段非空文本作为摘要
  const paras = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return paras.at(-1) ?? "";
}

// ───────────────────────── 报告渲染与套件汇总 ─────────────────────────
// 渲染与汇总放在报告模块里：LLM 运行（agent.ts）与零模型回放（replay.ts）共用同一份实现，
// 保证两种模式输出的报告结构、行文、汇总口径完全一致。

/** 套件报告里每个场景最多回放多少条执行轨迹（末尾优先），避免报告过长。 */
export const TRACE_TAIL_LINES = 25;

/** 套件成员：一个场景的运行结果与用量（LLM 运行或回放结果都满足该结构）。 */
export interface SuiteMember {
  name: string;
  report: TestReport;
  usage: TokenUsage;
  /**
   * 场景来源标注（用例文件路径，或「追加」）。
   *
   * 一次交互会话可以混合多个用例文件与手敲的场景，「跑 FAIL 的这个场景来自哪里」
   * 与「卡在第几步」是同一类定位信息——尤其当来源是运行中 `/run` 进来的，
   * 用户手里根本没打开那个文件（见 ADR-0005 决策四）。
   */
  origin?: string;
}

function verdictTag(v: "pass" | "fail"): string {
  return v === "pass" ? "PASS" : "FAIL";
}

/**
 * 场景结论标签。
 * 中止刻意用中文：它不是 PASS/FAIL 这个二选一里的第三项，写成「CANCELLED」
 * 很容易被当成某种失败的同义词。
 */
export function statusTag(s: "pass" | "fail" | "cancelled"): string {
  return s === "pass" ? "PASS" : s === "fail" ? "FAIL" : t("common.cancelled");
}

/** 渲染一条断言：`  - [PASS] 期望 (证据)`。 */
export function assertionLine(a: AssertionResult): string {
  const ev = a.evidence ? " (" + a.evidence + ")" : "";
  return "  - [" + verdictTag(a.verdict) + "] " + a.expectation + ev;
}

/** 渲染单场景文本报告。 */
export function renderText(r: TestReport): string {
  const lines: string[] = [];
  lines.push(t("report.title"));
  if (r.mode === "replay") lines.push(t("report.modeReplay"));
  lines.push(t("report.conclusion", { status: statusTag(r.status) }));
  if (r.cancelReason) lines.push(t("report.cancelled", { reason: r.cancelReason }));
  lines.push(t("report.assertCount", { n: r.assertions.length }));
  for (const a of r.assertions) lines.push(assertionLine(a));
  // 跳过必须显式列出：它不计入失败，但「哪些步骤没按脚本执行」是判断回放可信度的关键
  if (r.skipped?.length) {
    lines.push(t("report.skipped", { n: r.skipped.length }));
    for (const s of r.skipped) lines.push("  - " + s);
  }
  if (r.summary) lines.push(t("report.summary", { text: r.summary }));
  if (r.script) lines.push(t("report.script", { path: r.script }));
  lines.push("---");
  lines.push(r.transcript.trim());
  lines.push("---");
  lines.push(formatUsage(r.usage, r.mode));
  return lines.join("\n");
}

/**
 * 汇总多个场景：任一场景失败则整体失败。
 * 断言前缀场景名、保留逐场景 `steps/trace` 明细，CI 侧可直接定位失败场景的卡点步骤。
 */
export function summarizeSuite(members: SuiteMember[]): TestReport {
  const passed = members.filter((m) => m.report.status === "pass").length;
  const cancelled = members.filter((m) => m.report.status === "cancelled").length;
  const failed = members.filter((m) => m.report.status === "fail").length;
  // 中止不计入退出码：整体失败只由真正失败（含断言不成立）的场景决定。
  // 一个都没跑成（全部中止）则整体也是「已取消」，而不是伪装成通过。
  const overall: TestReport["status"] =
    failed > 0
      ? "fail"
      : passed === 0 && cancelled > 0
        ? "cancelled"
        : "pass";
  const usage = members.reduce(
    (acc, m) => mergeUsage(acc, m.usage),
    emptyUsage(),
  );
  return {
    status: overall,
    assertions: members.flatMap((m) =>
      m.report.assertions.map((a) => ({
        ...a,
        expectation: "[" + m.name + "] " + a.expectation,
      })),
    ),
    summary:
      t("report.suiteSummaryBase", { n: members.length, passed }) +
      // 只在真有场景被中止时才追加：没有中止时输出与历史报告逐字一致。
      (cancelled > 0
        ? t("report.suiteSummaryCancelled", { cancelled })
        : ""),
    transcript: members
      .map((m) => "## " + m.name + "\n" + m.report.transcript.trim())
      .join("\n\n"),
    scenarios: members.map((m) => ({
      name: m.name,
      status: m.report.status,
      steps: m.report.steps ?? [],
      trace: m.report.trace ?? [],
      assertions: m.report.assertions,
      // 只有调用方给出了来源才写这个字段：批处理模式的 JSON 与历史逐字一致。
      ...(m.origin ? { origin: m.origin } : {}),
    })),
    usage,
  };
}

/** 渲染套件文本报告：逐场景断言 + 执行轨迹（末尾若干条）+ 最终汇总。 */
export function renderSuiteText(
  summary: TestReport,
  members: { report: TestReport; usage: TokenUsage }[],
  scenarios: { name: string; origin?: string }[],
): string {
  const lines: string[] = [];
  lines.push(t("report.titleSuite"));
  if (summary.mode === "replay") lines.push(t("report.modeReplay"));
  lines.push(t("report.overall", { status: statusTag(summary.status) }));
  lines.push(t("report.scenarioCount", { n: members.length }));
  members.forEach((m, i) => {
    const scenario = scenarios[i];
    lines.push("");
    lines.push(
      t("report.scenarioHeader", {
        i: i + 1,
        n: members.length,
        // 来源跟在场景名之后（带「来源：」前缀，避免与后面的 [PASS] 混成两组方括号），
        // 绝不挤掉场景名：一次会话可能来自多个用例文件，「这个名字是哪个文件里的」
        // 是定位失败场景的前提（见 ADR-0005 决策四）。
        name: scenario?.origin
          ? scenario.name +
            t("report.scenarioOrigin", { origin: scenario.origin })
          : (scenario?.name ?? ""),
        status: statusTag(m.report.status),
      }),
    );
    if (m.report.cancelReason) lines.push("  " + m.report.cancelReason);
    for (const a of m.report.assertions) lines.push(assertionLine(a));
    if (m.report.skipped?.length) {
      lines.push(t("report.skippedSuite", { n: m.report.skipped.length }));
    }
    if (m.report.summary) lines.push("  " + t("report.summary", { text: m.report.summary }));
    // 执行轨迹：套件模式下不再只给一个「23/42」，把工具调用与步骤自述还原出来，
    // 使用者才能判断「卡在用例的哪一步、该改哪一句」。
    const trace = m.report.trace ?? [];
    if (trace.length > 0) {
      const shown = trace.slice(-TRACE_TAIL_LINES);
      lines.push(t("report.traceTitle", { shown: shown.length, total: trace.length }));
      for (const step of shown) lines.push("    " + step);
    }
    lines.push("  " + formatUsage(m.usage, m.report.mode ?? summary.mode));
  });
  lines.push("");
  lines.push(t("report.summaryLine", { text: summary.summary ?? "" }));
  if (summary.script) lines.push(t("report.script", { path: summary.script }));
  lines.push("---");
  lines.push(formatUsage(summary.usage, summary.mode));
  return lines.join("\n");
}
