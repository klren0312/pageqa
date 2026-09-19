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
  assertions: AssertionResult[];
  summary?: string;
  transcript: string;
  /** token 消耗，渲染在报告末尾；旧结构仍可用（可选字段）。 */
  usage?: TokenUsage;
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
export function formatUsage(usage?: TokenUsage): string {
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
 * 从 agent 的结论文本中解析断言结果。agent 会以「成立/不成立」给出每个断言，
 * 并用「断言「X」：成立。证据...」句式。无法解析时降级为基于 PASS/FAIL 关键字的整体判断。
 */
export function buildReport(input: string, transcript: string): TestReport {
  const assertions = parseAssertions(transcript);

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
      evidence: "解析到的断言少于用例中的断言数量，疑似步骤未执行完就结束",
    });
  }

  // agent 自报的步骤进度未跑满，同样判失败。
  const progress = parseProgress(transcript);
  if (progress && progress.done < progress.total) {
    status = "fail";
    assertions.push({
      expectation: `全部步骤执行完成（${progress.done}/${progress.total}）`,
      verdict: "fail",
      evidence: "agent 自报的步骤完成度不足",
    });
  }

  const summary = extractSummary(transcript);
  return { status, assertions, summary, transcript };
}

/** 统计用例（自然语言测试步骤）中的断言数量，用于校验执行完整性。 */
export function countAssertions(script: string): number {
  return (script.match(/断言/g) ?? []).length;
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
