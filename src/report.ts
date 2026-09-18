export interface AssertionResult {
  expectation: string;
  verdict: "pass" | "fail";
  evidence?: string;
}

export interface TestReport {
  status: "pass" | "fail";
  assertions: AssertionResult[];
  summary?: string;
  transcript: string;
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
    const lowered = transcript.toLowerCase();
    const negative = /不成立|未找到|失败|不存在|not found|fail|missing/.test(transcript);
    status = negative ? "fail" : "pass";
  }

  const summary = extractSummary(transcript);
  return { status, assertions, summary, transcript };
}

function parseAssertions(text: string): AssertionResult[] {
  const results: AssertionResult[] = [];
  // 匹配两种常见句式：
  //   断言「X」：成立/不成立。证据...
  //   断言「X」成立。证据...
  const re = /断言[「"']?([^」"']+?)[""」]?\s*(?:[:：]\s*)?(成立|不成立)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const expectation = m[1].trim();
    const verdict = m[2] === "成立" ? "pass" : "fail";
    const after = text.slice(m.index + m[0].length).split("\n")[0].trim();
    const evidence = after.startsWith("。") ? after.slice(1).trim() : after;
    results.push({ expectation, verdict, evidence: evidence || undefined });
  }
  return results;
}

function extractSummary(text: string): string {
  // 取最后一段非空文本作为摘要
  const paras = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return paras.at(-1) ?? "";
}
