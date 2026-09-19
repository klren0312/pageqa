import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createLlmBackend } from "./llm.js";
import { createBskTools, ensureSession, ensureBskReady } from "./bsk/tools.js";
import { JevClient } from "./jev.js";
import { loadConfig } from "./config.js";
import { buildReport, type TestReport } from "./report.js";

export interface AgentOptions {
  session?: string;
  systemPrompt?: string;
  debug?: boolean;
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
  "工作流程（必须严格遵守）：",
  "1. 第一步永远是 navigate(url) 打开目标页面，等待其加载完成。",
  "2. navigate 之后立即调用 snapshot() 确认页面已真实打开、读取当前内容并定位元素。",
  "3. 按用户意图逐步交互；每次交互后如需要可再次 snapshot 确认状态。",
  "4. 只有在 navigate + snapshot 已成功、页面确为期望页面之后，才能调用 assert_text 校验关键结果。",
  "5. 最后用简洁中文给出结论：每个断言「成立/不成立」，并附证据（实际看到的标题或文本片段）。",
  "",
  "完整性要求（长流程尤其重要）：",
  "- 必须按顺序执行完提示中列出的**每一个步骤**（包括以 `### ` 标注的每个子步骤），不得只完成前几步就总结收尾。",
  "- 每完成一个步骤，简要记一句「第 k 步完成：<结果>」，再继续下一步；不要提前输出最终结论。",
  "- 结尾必须单独输出一行进度声明，格式固定：`步骤完成：<已完成步骤数>/<总步骤数>`。",
  "  例如共 7 个步骤且全部完成时输出 `步骤完成：7/7`；只完成 4 步则输出 `步骤完成：4/7`。",
  "- 若某步骤确实无法完成（元素找不到、操作被拒绝等），明确说明该步骤失败及原因，然后继续或终止，但仍要如实输出进度声明。",
  "- 工具调用失败（如 click 找不到元素、超时）不等于该步骤失败：必须先重新 snapshot 定位元素后重试；同一操作连续两次失败才可判定该步骤失败。",
  "",
  "硬性约束（违反即视为测试失败）：",
  "- 严禁在 navigate 之前调用 assert_text：页面尚未打开时断言必然不成立，且会误报通过。",
  "- 严禁在尚未 snapshot 确认页面内容的情况下就断言；若 snapshot 返回内容为空或明显不是目标页面，应报告「不成立」并说明原因，而不是编造结论。",
  "- 严禁在步骤未执行完的情况下给出「测试通过」结论；宁可报告某步骤失败，也不要静默省略步骤。",
  "- 不要编造未观察到的内容；若元素不存在、导航失败或页面未打开，明确说明。",
  "",
  "只输出测试结论与证据，不要输出多余解释。",
].join("\n");

// 上下文压力控制：长流程会累积大量页面快照（一次快照几千至上万字符），
// 默认模型上下文窗口只有 32k token，若不裁剪会把早期的步骤说明挤出上下文，
// 导致模型「忘记」后续步骤而提前收尾。
const CONTEXT_CHAR_LIMIT = 40_000;
const KEEP_RECENT_MESSAGES = 12;
const MAX_OLD_TOOL_CHARS = 1_500;
const TRIMMED_MARK = "（较早的快照已省略";

/** 粗略估算消息文本总字符数。 */
function estimateChars(messages: AgentMessage[]): number {
  let n = 0;
  for (const m of messages) {
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") {
      n += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content as { text?: string }[]) {
        if (typeof part?.text === "string") n += part.text.length;
      }
    }
  }
  return n;
}

/** 截断较早的工具结果（保留最近若干条完整），避免快照把上下文撑爆。 */
function trimOldToolResults(
  messages: AgentMessage[],
  keepRecent: number,
  maxChars: number,
): AgentMessage[] {
  const cut = messages.length - keepRecent;
  if (cut <= 0) return messages;
  return messages.map((m, i) => {
    if (i >= cut) return m;
    const msg = m as { role?: string; content?: unknown };
    if (msg.role !== "toolResult" || !Array.isArray(msg.content)) return m;
    let changed = false;
    const content = (msg.content as { type?: string; text?: string }[]).map(
      (part) => {
        if (
          part?.type !== "text" ||
          typeof part.text !== "string" ||
          part.text.length <= maxChars ||
          part.text.includes(TRIMMED_MARK)
        ) {
          return part;
        }
        changed = true;
        return {
          ...part,
          text:
            part.text.slice(0, maxChars) +
            `\n${TRIMMED_MARK}${part.text.length - maxChars} 字符，如需查看请重新 snapshot）`,
        };
      },
    );
    return changed ? ({ ...m, content } as AgentMessage) : m;
  });
}

/**
 * 用 pi-agent-core 编排一次自然语言页面测试：注入 bsk 工具，驱动浏览器执行，整理报告。
 * 若配置中启用了 Jev（PAGEQA_JEV_ENABLED=true 且配置了 API Key），
 * 断言环节会使用 Jev 语义判断替代字符串包含匹配。
 */
export async function runAgent(
  input: string,
  opts: AgentOptions = {},
): Promise<AgentRunResult> {
  const debug = opts.debug ?? false;
  const log = debug
    ? (m: string) => process.stderr.write("[debug] " + m + "\n")
    : () => {};

  const t0 = Date.now();
  log("[runAgent] 开始，输入长度=" + input.length);

  const { models, model } = createLlmBackend();
  log("[runAgent] LLM 后端已创建，model=" + model.id);

  log("[runAgent] 创建/复用 bsk session...");
  await ensureBskReady(debug);
  const session = ensureSession(opts.session);
  log("[runAgent] bsk session=" + session);

  const jevCfg = loadConfig().jev;
  const jevClient = new JevClient(jevCfg, debug);
  log("[runAgent] Jev enabled=" + jevClient.enabled);

  const tools = createBskTools({ session, jevClient, debug });
  log(
    "[runAgent] 工具数=" +
      tools.length +
      " " +
      tools.map((t) => t.name).join(", "),
  );

  const events: string[] = [];
  const agent = new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      model,
      tools,
    },
    streamFn: models.streamSimple.bind(models),
    // 上下文超限前，先把较早的页面快照裁剪掉，保住最近的上下文与用例步骤。
    transformContext: async (messages) => {
      const before = estimateChars(messages);
      if (before <= CONTEXT_CHAR_LIMIT) return messages;
      const trimmed = trimOldToolResults(
        messages,
        KEEP_RECENT_MESSAGES,
        MAX_OLD_TOOL_CHARS,
      );
      log(
        "[runAgent] 上下文裁剪：" +
          before +
          " -> " +
          estimateChars(trimmed) +
          " 字符（消息 " +
          messages.length +
          " 条）",
      );
      return trimmed;
    },
  });

  agent.subscribe((e) => {
    if (e.type === "tool_execution_start") {
      events.push("[tool] " + e.toolName);
      log("[agent] 工具调用开始: " + e.toolName);
    } else if (e.type === "tool_execution_end") {
      // 工具失败必须显式记录，否则报告里看不出「某步其实报错了」
      events.push((e.isError ? "[tool-error] " : "[tool-ok] ") + e.toolName);
      log(
        "[agent] 工具调用" + (e.isError ? "失败" : "完成") + ": " + e.toolName,
      );
    } else if (
      e.type === "message_update" &&
      e.assistantMessageEvent?.type === "text_delta"
    ) {
      events.push(e.assistantMessageEvent.delta);
    }
  });

  log("[runAgent] 发送 prompt...");
  await agent.prompt(input);
  log("[runAgent] prompt 完成，等待 idle...");
  await agent.waitForIdle();
  log("[runAgent] idle 完成，耗时=" + (Date.now() - t0) + "ms");

  // 循环可能因模型报错/上下文超限而提前结束；此时绝不能当成「正常跑完」。
  const agentError = agent.state.errorMessage;
  log(
    "[runAgent] 消息数=" +
      agent.state.messages.length +
      "，错误=" +
      (agentError ?? "无"),
  );
  if (agentError) events.push("\n[agent-error] " + agentError + "\n");

  const transcript = events.join("");
  const report = buildReport(input, transcript);
  if (agentError) {
    report.status = "fail";
    report.assertions.push({
      expectation: "agent 正常执行完毕（未因错误中断）",
      verdict: "fail",
      evidence: agentError,
    });
  }
  log(
    "[runAgent] 断言数=" + report.assertions.length + "，状态=" + report.status,
  );

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
    if (body.length > 0)
      collected.push({ name: currentName || "场景 1", body });
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
  return collected.length
    ? collected
    : [{ name: "场景 1", body: script.trim() }];
}

/** 批量运行多个场景并汇总报告。任一失败则整体失败。 */
export async function runSuite(
  script: string,
  opts: AgentOptions = {},
): Promise<AgentRunResult> {
  const scenarios = splitScenarios(script);
  const results: AgentRunResult[] = [];
  for (const sc of scenarios) {
    const r = await runAgent(sc.body, { ...opts, systemPrompt: undefined });
    results.push(r);
  }
  const overall = results.every((r) => r.report.status === "pass")
    ? "pass"
    : "fail";
  const summary: TestReport = {
    status: overall,
    assertions: results.flatMap((r, i) =>
      r.report.assertions.map((a) => ({
        ...a,
        expectation:
          "[" + (scenarios[i]?.name ?? String(i + 1)) + "] " + a.expectation,
      })),
    ),
    summary:
      "共 " +
      results.length +
      " 个场景，通过 " +
      results.filter((r) => r.report.status === "pass").length +
      " 个",
    transcript: results
      .map(
        (r, i) =>
          "## " +
          (scenarios[i]?.name ?? String(i + 1)) +
          "\n" +
          r.transcript.trim(),
      )
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

function assertionLine(a: {
  verdict: "pass" | "fail";
  expectation: string;
  evidence?: string;
}): string {
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
      "--- 场景 " +
        (i + 1) +
        "：" +
        (scenarios[i]?.name ?? "") +
        " [" +
        (r.report.status === "pass" ? "PASS" : "FAIL") +
        "] ---",
    );
    for (const a of r.report.assertions) lines.push(assertionLine(a));
    if (r.report.summary) lines.push("  摘要: " + r.report.summary);
  });
  lines.push("");
  lines.push("汇总: " + summary.summary);
  return lines.join("\n");
}
