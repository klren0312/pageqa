import { Agent } from "@earendil-works/pi-agent-core";
import { createLlmBackend } from "./llm.js";
import { createBskTools, ensureSession } from "./bsk/tools.js";
import { buildReport, type TestReport } from "./report.js";

export interface AgentOptions {
  session?: string;
  systemPrompt?: string;
}

export interface AgentRunResult {
  report: TestReport;
  text: string;
  json: string;
  transcript: string;
}

interface Scenario {
  name: string;
  body: string;
}

const DEFAULT_SYSTEM_PROMPT = [
  "你是「页面测试 agent」。你根据用户的自然语言测试意图，驱动浏览器完成端到端测试。",
  "",
  "可用工具：",
  "- navigate(url): 打开网页",
  "- snapshot(): 读取页面 aria 树与可见文本（标题、段落、链接、按钮等），并定位元素",
  "- click(target) / fill(target, value) / hover(target): 元素交互，target 用 @eN 引用或 CSS 选择器",
  "- scroll(target) / wait(ms): 滚动与等待",
  "- assert_text(expectation): 断言页面是否包含某文本，返回「成立/不成立」与证据",
  "",
  "工作流程：",
  "1. 若需要打开页面，先 navigate。",
  "2. 用 snapshot 读取当前内容并定位要操作的元素。",
  "3. 按用户意图逐步交互；每次交互后如需要可再次 snapshot 确认状态。",
  "4. 用 assert_text 校验关键结果，或在 snapshot 基础上自行判断文本/标题是否匹配。",
  "5. 最后用简洁中文给出结论：每个断言「成立/不成立」，并附证据（实际看到的标题或文本片段）。",
  "6. 不要编造未观察到的内容；若元素不存在或断言失败，明确说明。",
  "",
  "只输出测试结论与证据，不要输出多余解释。",
].join("\n");

/**
 * 用 pi-agent-core 编排一次自然语言页面测试：注入 bsk 工具，驱动浏览器执行，整理报告。
 */
export async function runAgent(input: string, opts: AgentOptions = {}): Promise<AgentRunResult> {
  const { models, model } = createLlmBackend();
  const session = ensureSession(opts.session);
  const tools = createBskTools({ session });

  const events: string[] = [];
  const agent = new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      model,
      tools,
    },
    streamFn: models.streamSimple.bind(models),
  });

  agent.subscribe((e) => {
    if (e.type === "tool_execution_start") events.push("[tool] " + e.toolName);
    else if (e.type === "tool_execution_end") events.push("[tool-ok] " + e.toolName);
    else if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      events.push(e.assistantMessageEvent.delta);
    }
  });

  await agent.prompt(input);
  await agent.waitForIdle();

  const transcript = events.join("");
  const report = buildReport(input, transcript);
  return {
    report,
    text: renderText(report),
    json: JSON.stringify(report, null, 2),
    transcript,
  };
}

/** 把一个脚本拆分为多个场景（按 `## ` 二级标题分隔）。无标题则整体作为一个场景。 */
export function splitScenarios(script: string): Scenario[] {
  const lines = script.split(/\r?\n/);
  const collected: Scenario[] = [];
  let currentName = "";
  let currentLines: string[] = [];
  let inScenario = false;
  const flush = () => {
    if (!inScenario) return;
    const body = currentLines.join("\n").trim();
    if (body.length > 0) collected.push({ name: currentName || "场景 1", body });
    currentLines = [];
  };
  for (const line of lines) {
    const m = line.match(/^##\s+(.*)$/);
    if (m) {
      flush();
      inScenario = true;
      currentName = m[1].trim();
    } else if (inScenario) {
      currentLines.push(line);
    }
    // 一级标题(#)与##之前的开场说明文字：不计入任何场景
  }
  flush();
  return collected.length ? collected : [{ name: "场景 1", body: script.trim() }];
}

/** 批量运行多个场景并汇总报告。任一失败则整体失败。 */
export async function runSuite(script: string, opts: AgentOptions = {}): Promise<AgentRunResult> {
  const scenarios = splitScenarios(script);
  const results: AgentRunResult[] = [];
  for (const sc of scenarios) {
    const r = await runAgent(sc.body, { ...opts, systemPrompt: undefined });
    results.push(r);
  }
  const overall = results.every((r) => r.report.status === "pass") ? "pass" : "fail";
  const summary: TestReport = {
    status: overall,
    assertions: results.flatMap((r, i) =>
      r.report.assertions.map((a) => ({
        ...a,
        expectation: "[" + (scenarios[i]?.name ?? String(i + 1)) + "] " + a.expectation,
      })),
    ),
    summary:
      "共 " + results.length + " 个场景，通过 " +
      results.filter((r) => r.report.status === "pass").length + " 个",
    transcript: results
      .map((r, i) => "## " + (scenarios[i]?.name ?? String(i + 1)) + "\n" + r.transcript.trim())
      .join("\n\n"),
  };
  return {
    report: summary,
    text: renderSuiteText(summary, results, scenarios),
    json: JSON.stringify(summary, null, 2),
    transcript: summary.transcript,
  };
}

function verdictTag(v: "pass" | "fail"): string {
  return v === "pass" ? "PASS" : "FAIL";
}

function assertionLine(a: { verdict: "pass" | "fail"; expectation: string; evidence?: string }): string {
  const ev = a.evidence ? " (" + a.evidence + ")" : "";
  return "  - [" + verdictTag(a.verdict) + "] " + a.expectation + ev;
}

function renderText(r: TestReport): string {
  const lines: string[] = [];
  lines.push("=== 页面测试报告 ===");
  lines.push("结论: " + (r.status === "pass" ? "PASS" : "FAIL"));
  lines.push("断言数: " + r.assertions.length);
  for (const a of r.assertions) lines.push(assertionLine(a));
  if (r.summary) lines.push("摘要: " + r.summary);
  lines.push("---");
  lines.push(r.transcript.trim());
  return lines.join("\n");
}

function renderSuiteText(
  summary: TestReport,
  results: AgentRunResult[],
  scenarios: { name: string; body: string }[],
): string {
  const lines: string[] = [];
  lines.push("=== 页面测试套件报告 ===");
  lines.push("整体结论: " + (summary.status === "pass" ? "PASS" : "FAIL"));
  lines.push("场景数: " + results.length);
  results.forEach((r, i) => {
    lines.push("");
    lines.push(
      "--- 场景 " + (i + 1) + "：" + (scenarios[i]?.name ?? "") +
        " [" + (r.report.status === "pass" ? "PASS" : "FAIL") + "] ---",
    );
    for (const a of r.report.assertions) lines.push(assertionLine(a));
    if (r.report.summary) lines.push("  摘要: " + r.report.summary);
  });
  lines.push("");
  lines.push("汇总: " + summary.summary);
  return lines.join("\n");
}
