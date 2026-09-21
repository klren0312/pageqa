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
  status: "pass" | "fail";
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
  status: "pass" | "fail";
  steps: string[];
  trace: string[];
  assertions: AssertionResult[];
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
  if (mode === "replay") return "Token 消耗: 未调用大模型（回放模式）";
  if (!usage) return "Token 消耗: 不可用（未采集到用量）";
  const line =
    "Token 消耗: 输入 " +
    usage.input +
    " / 输出 " +
    usage.output +
    " / 缓存读 " +
    usage.cacheRead +
    " / 缓存写 " +
    usage.cacheWrite +
    " / 合计 " +
    usage.total +
    "（LLM 调用 " +
    usage.calls +
    " 次）";
  return usage.calls > 0 && usage.total === 0
    ? line + "（端点未返回 usage）"
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

  // 完整性校验：用例里写了 N 条断言，就应当看到 N 条结果；
  // 少了解析结果说明 agent 只跑了其中一部分（长流程最容易半途结束）。
  const expected = countAssertions(input);
  if (expected > 0 && assertions.length < expected) {
    status = "fail";
    assertions.push({
      expectation: `用例中的断言全部执行（实际 ${assertions.length}/${expected}）`,
      verdict: "fail",
      evidence: [
        "解析到的断言少于用例中的断言数量，疑似步骤未执行完就结束",
        lastNote ? `最后进展：${lastNote}` : null,
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
      expectation: `全部步骤执行完成（${progress.done}/${progress.total}）`,
      verdict: "fail",
      evidence: [
        "agent 自报的步骤完成度不足",
        lastNote ? `最后进展：${lastNote}` : null,
        nextStep
          ? `未执行到的步骤（第 ${progress.done + 1}/${progress.total} 步）：${nextStep}`
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
  return `轨迹末尾：${trace.slice(-n).join(" → ")}`;
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
}

function verdictTag(v: "pass" | "fail"): string {
  return v === "pass" ? "PASS" : "FAIL";
}

/** 渲染一条断言：`  - [PASS] 期望 (证据)`。 */
export function assertionLine(a: AssertionResult): string {
  const ev = a.evidence ? " (" + a.evidence + ")" : "";
  return "  - [" + verdictTag(a.verdict) + "] " + a.expectation + ev;
}

/** 渲染单场景文本报告。 */
export function renderText(r: TestReport): string {
  const lines: string[] = [];
  lines.push("=== 页面测试报告 ===");
  if (r.mode === "replay") lines.push("模式: 回放（未调用大模型）");
  lines.push("结论: " + (r.status === "pass" ? "PASS" : "FAIL"));
  lines.push("断言数: " + r.assertions.length);
  for (const a of r.assertions) lines.push(assertionLine(a));
  // 跳过必须显式列出：它不计入失败，但「哪些步骤没按脚本执行」是判断回放可信度的关键
  if (r.skipped?.length) {
    lines.push(`跳过 ${r.skipped.length} 步（元素未找到，当前页面状态下不需要该步）:`);
    for (const s of r.skipped) lines.push("  - " + s);
  }
  if (r.summary) lines.push("摘要: " + r.summary);
  if (r.script) lines.push("回放脚本: " + r.script);
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
  const overall = members.every((m) => m.report.status === "pass")
    ? "pass"
    : "fail";
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
      "共 " +
      members.length +
      " 个场景，通过 " +
      members.filter((m) => m.report.status === "pass").length +
      " 个",
    transcript: members
      .map((m) => "## " + m.name + "\n" + m.report.transcript.trim())
      .join("\n\n"),
    scenarios: members.map((m) => ({
      name: m.name,
      status: m.report.status,
      steps: m.report.steps ?? [],
      trace: m.report.trace ?? [],
      assertions: m.report.assertions,
    })),
    usage,
  };
}

/** 渲染套件文本报告：逐场景断言 + 执行轨迹（末尾若干条）+ 最终汇总。 */
export function renderSuiteText(
  summary: TestReport,
  members: { report: TestReport; usage: TokenUsage }[],
  scenarios: { name: string }[],
): string {
  const lines: string[] = [];
  lines.push("=== 页面测试套件报告 ===");
  if (summary.mode === "replay") lines.push("模式: 回放（未调用大模型）");
  lines.push("整体结论: " + (summary.status === "pass" ? "PASS" : "FAIL"));
  lines.push("场景数: " + members.length);
  members.forEach((m, i) => {
    lines.push("");
    lines.push(
      "--- 场景 " +
        (i + 1) +
        "：" +
        (scenarios[i]?.name ?? "") +
        " [" +
        (m.report.status === "pass" ? "PASS" : "FAIL") +
        "] ---",
    );
    for (const a of m.report.assertions) lines.push(assertionLine(a));
    if (m.report.skipped?.length) {
      lines.push(`  跳过 ${m.report.skipped.length} 步（元素未找到，详见执行轨迹）`);
    }
    if (m.report.summary) lines.push("  摘要: " + m.report.summary);
    // 执行轨迹：套件模式下不再只给一个「23/42」，把工具调用与步骤自述还原出来，
    // 使用者才能判断「卡在用例的哪一步、该改哪一句」。
    const trace = m.report.trace ?? [];
    if (trace.length > 0) {
      const shown = trace.slice(-TRACE_TAIL_LINES);
      lines.push(`  执行轨迹（末尾 ${shown.length}/${trace.length} 条）:`);
      for (const t of shown) lines.push("    " + t);
    }
    lines.push("  " + formatUsage(m.usage, m.report.mode ?? summary.mode));
  });
  lines.push("");
  lines.push("汇总: " + summary.summary);
  if (summary.script) lines.push("回放脚本: " + summary.script);
  lines.push("---");
  lines.push(formatUsage(summary.usage, summary.mode));
  return lines.join("\n");
}
