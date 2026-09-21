import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createLlmBackend } from "./llm.js";
import {
  closeSession,
  createBskTools,
  ensureSession,
  ensureBskReady,
} from "./bsk/tools.js";
import { JevClient } from "./jev.js";
import { loadConfig } from "./config.js";
import { debugLog, info, setDebug } from "./log.js";
import {
  addUsage,
  buildReport,
  countAssertions,
  emptyUsage,
  formatUsage,
  mergeUsage,
  numberSteps,
  parseAssertions,
  parseProgress,
  type TestReport,
  type TokenUsage,
} from "./report.js";

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
  usage: TokenUsage;
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
  "- upload(target, file): 上传本地文件到文件输入框/上传区域，target 传触发上传的元素（或省略由工具自动查找）",
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
  "- 用例的每一步都已用 `### 步骤 k：<描述>` 编号（k 从 1 连续递增）。必须严格按编号顺序执行**每一个步骤**，不得跳步、不得只完成前几步就总结收尾。",
  "- 每完成一个步骤，简要记一句「第 k 步完成：<结果>」（k 必须与用例中的步骤编号一致），再继续下一步；不要提前输出最终结论。",
  "- 结尾必须单独输出一行进度声明，格式固定：`步骤完成：<已完成步骤数>/<总步骤数>`。",
  "  例如共 7 个步骤且全部完成时输出 `步骤完成：7/7`；只完成 4 步则输出 `步骤完成：4/7`。",
  "- 若某步骤确实无法完成（元素找不到、操作被拒绝等），明确说明该步骤失败及原因，然后继续或终止，但仍要如实输出进度声明。",
  "- 只要还有未执行的步骤，就继续调用工具执行下一步，不要中途停下等待用户输入；只有全部步骤都执行（或已明确失败）后才输出进度声明并收尾。",
  "- 工具调用失败（如 click 找不到元素、超时）不等于该步骤失败：必须先重新 snapshot 定位元素后重试；同一操作连续两次失败才可判定该步骤失败。",
  "",
  "表单提交失败处理（关键，不得跳过）：",
  "- 点击「提交 / 确定 / 保存 / 确认」类按钮后，必须先确认动作是否真的成功：弹窗是否关闭、是否出现成功提示、列表数据是否刷新。",
  "- 若弹窗仍未关闭、仍停留在表单页，或出现「xxx 不能为空」「请输入 xxx」「请选择 xxx」「必填项」等校验提示，一律视为提交失败，此时不得跳过该步骤、不得继续下一步。",
  "- 提交失败时重新 snapshot 扫描当前表单的全部必填项：优先按校验提示定位缺失字段；其次找 label 前带红色「*」或标注「必填 / required」的字段。",
  "- 逐一补齐缺失的必填项：文本/数字输入框填入合法内容（名称类可用「自动化测试+时间戳」这类合法值；编码、排序、数量、比例类填合法数字如 1、001）；下拉/单选/复选/日期/级联等非文本控件先点击展开，再点选第一个可用选项或页面默认项。",
  "- 补齐后再次提交，重复「确认是否成功 → 扫描必填项 → 补齐 → 再提交」，最多 3 轮；仍无法提交则如实记录失败原因后继续后续步骤，不得静默跳过。",
  "",
  "硬性约束（违反即视为测试失败）：",
  "- 严禁在 navigate 之前调用 assert_text：页面尚未打开时断言必然不成立，且会误报通过。",
  "- 严禁在尚未 snapshot 确认页面内容的情况下就断言；若 snapshot 返回内容为空或明显不是目标页面，应报告「不成立」并说明原因，而不是编造结论。",
  "- 严禁在步骤未执行完的情况下给出「测试通过」结论；宁可报告某步骤失败，也不要静默省略步骤。",
  "- 不要编造未观察到的内容；若元素不存在、导航失败或页面未打开，明确说明。",
  "- 涉及文件上传时必须用 upload 工具：原生系统文件选择框无法被自动化点击，直接 click 上传按钮会卡住流程。",
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

// 长流程最常见的失败模式：模型做完一两步就自行收尾（不再调用工具、直接给结论），
// 后面的步骤根本没执行。这里按 agent 自报的进度/已解析断言数补「继续执行」提示，
// 直到跑满、确实没有进展或达到次数上限为止。
const MAX_CONTINUATIONS = 5;

/** 套件报告里每个场景最多回放多少条执行轨迹（末尾优先），避免报告过长。 */
const TRACE_TAIL_LINES = 25;

/** 构造续跑提示：只要求接着做，不重复已完成步骤，并再次强调进度声明格式。 */
function continuePrompt(
  progress: { done: number; total: number } | null,
): string {
  const tail =
    "不要重复已完成的步骤；每完成一步记「第 k 步完成：<结果>」，全部步骤执行完后必须单独输出一行「步骤完成：<已完成数>/<总数>」。";
  if (progress) {
    return (
      `进度检查：你自报的进度是 ${progress.done}/${progress.total}，仍有步骤未执行。` +
      `请从第 ${progress.done + 1} 步开始继续执行剩余步骤，` +
      tail
    );
  }
  return (
    "进度检查：你没有输出进度声明「步骤完成：<已完成数>/<总数>」，且用例中的断言/步骤尚未全部执行。" +
    "请继续执行剩余步骤，" +
    tail +
    "若确实有步骤无法完成，也要如实输出实际进度。"
  );
}

/** 汇总 agent 全部 assistant 消息的 usage（包含每一轮与每次续跑）。 */
function collectUsage(messages: AgentMessage[]): TokenUsage {
  let acc = emptyUsage();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    acc = addUsage(acc, m.usage);
  }
  return acc;
}

/** 取用例文本的单行预览，便于在日志里快速识别当前跑的是哪条用例。 */
function preview(input: string, max = 60): string {
  const oneLine = input.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

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

/** 本次运行使用的 session 持有者：让最外层的 finally 能兜底关闭它。 */
interface SessionHolder {
  id?: string;
}

/**
 * 用 pi-agent-core 编排一次自然语言页面测试：注入 bsk 工具，驱动浏览器执行，整理报告。
 * 若配置中启用了 Jev（PAGEQA_JEV_ENABLED=true 且配置了 API Key），
 * 断言环节会使用 Jev 语义判断替代字符串包含匹配。
 *
 * 无论用例通过、失败还是中途抛错，结束后都会关闭本次的 bsk session，
 * 从而关掉自动化操作的那个浏览器窗口（Agent Window）。
 */
export async function runAgent(
  input: string,
  opts: AgentOptions = {},
): Promise<AgentRunResult> {
  const holder: SessionHolder = {};
  try {
    return await runAgentCore(input, opts, holder);
  } finally {
    if (holder.id) closeSession(holder.id);
  }
}

/** runAgent 的实际编排逻辑；session 记录到 holder 供调用方兜底清理。 */
async function runAgentCore(
  input: string,
  opts: AgentOptions,
  holder: SessionHolder,
): Promise<AgentRunResult> {
  const debug = opts.debug ?? false;
  setDebug(debug);
  const log = debugLog;

  const t0 = Date.now();
  log("[runAgent] 开始，输入长度=" + input.length);
  // 由 pageqa 统一给用例的每行编号后再交给模型：模型输出的「步骤完成：k/n」
  // 就能映射回用例原文，报告可直接指出「停在哪一步、下一步该做什么」。
  const { numbered, steps } = numberSteps(input);
  info(
    `[pageqa] 用例开始：${preview(input)}（${input.length} 字符，${steps.length} 个步骤）`,
  );

  log("[runAgent] 创建 LLM 后端...");
  const { models, model } = createLlmBackend();
  log("[runAgent] LLM 后端已创建，model=" + model.id);
  info(`[pageqa] LLM 已就绪：model=${model.id}`);

  info("[pageqa] 检查 bsk daemon 与浏览器连接…");
  await ensureBskReady();
  info("[pageqa] 创建/复用 bsk session…");
  const session = ensureSession(opts.session);
  holder.id = session;
  log("[runAgent] bsk session=" + session);
  info(`[pageqa] bsk session=${session}`);

  const jevCfg = loadConfig().jev;
  const jevClient = new JevClient(jevCfg, debug);
  log("[runAgent] Jev enabled=" + jevClient.enabled);
  info(`[pageqa] 语义断言（Jev）${jevClient.enabled ? "已启用" : "未启用"}`);

  const tools = createBskTools({ session, jevClient });
  log(
    "[runAgent] 工具数=" +
      tools.length +
      " " +
      tools.map((t) => t.name).join(", "),
  );
  info(
    `[pageqa] 工具已就绪：${tools.length} 个；用例已编号为 ${steps.length} 个步骤（报告按此定位卡点）`,
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

  // 工具执行进度始终打印（默认可见），让长流程每跑一步都有回显；
  // 避免出现「终端长时间无输出、不知道卡在哪一步」的观感。
  let toolCount = 0;
  let toolStartedAt = 0;
  let firstTextLogged = false;
  agent.subscribe((e) => {
    if (e.type === "tool_execution_start") {
      events.push("[tool] " + e.toolName);
      log("[agent] 工具调用开始: " + e.toolName);
      toolCount += 1;
      toolStartedAt = Date.now();
      info(`[pageqa] ▶ #${toolCount} ${e.toolName} …`);
    } else if (e.type === "tool_execution_end") {
      // 工具失败必须显式记录，否则报告里看不出「某步其实报错了」
      events.push((e.isError ? "[tool-error] " : "[tool-ok] ") + e.toolName);
      log(
        "[agent] 工具调用" + (e.isError ? "失败" : "完成") + ": " + e.toolName,
      );
      const cost = toolStartedAt ? Date.now() - toolStartedAt : 0;
      info(
        `[pageqa] ${e.isError ? "✗" : "✓"} #${toolCount} ${e.toolName}` +
          `${e.isError ? "（失败，将重试或报告）" : ""} ${cost}ms`,
      );
    } else if (
      e.type === "message_update" &&
      e.assistantMessageEvent?.type === "text_delta"
    ) {
      if (!firstTextLogged) {
        firstTextLogged = true;
        info("[pageqa] 模型已开始输出，正在推进步骤…");
      }
      events.push(e.assistantMessageEvent.delta);
    }
  });

  log("[runAgent] 发送 prompt...");
  info("[pageqa] 已提交用例，等待模型与浏览器执行…");
  await agent.prompt(numbered);
  log("[runAgent] prompt 完成，等待 idle...");
  await agent.waitForIdle();

  // 续跑：只在「有明确证据表明还没执行完」时才追问，避免正常用例被多余打扰。
  // 证据 = agent 自报进度未满，或用例中断言数还没跑够。
  const expectedAssertions = countAssertions(input);
  let lastSignature: string | null = null;
  for (let round = 0; round < MAX_CONTINUATIONS; round++) {
    if (agent.state.errorMessage) break;
    const transcriptSoFar = events.join("");
    const progress = parseProgress(transcriptSoFar);
    const parsed = parseAssertions(transcriptSoFar).length;
    const incomplete = progress
      ? progress.done < progress.total
      : expectedAssertions > 0 && parsed < expectedAssertions;
    if (!incomplete) break;

    const signature =
      (progress ? `${progress.done}/${progress.total}` : "-") + "|" + parsed;
    if (round > 0 && signature === lastSignature) {
      log("[runAgent] 续跑后进度未推进（" + signature + "），停止续跑");
      break;
    }
    lastSignature = signature;
    const note =
      "[continue] 第 " +
      (round + 1) +
      " 次续跑（进度 " +
      (progress ? `${progress.done}/${progress.total}` : "未声明") +
      "，断言 " +
      parsed +
      "/" +
      expectedAssertions +
      "）\n";
    events.push(note);
    log("[runAgent] " + note.trim());
    info(
      `[pageqa] 步骤未跑完，发起第 ${round + 1} 次续跑（进度 ` +
        `${progress ? `${progress.done}/${progress.total}` : "未声明"}，` +
        `断言 ${parsed}/${expectedAssertions}）`,
    );
    await agent.prompt(continuePrompt(progress));
    await agent.waitForIdle();
  }

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

  // token 消耗：从每条 assistant 消息的 usage 汇总，渲染在报告末尾。
  const usage = collectUsage(agent.state.messages);
  report.usage = usage;
  log("[runAgent] " + formatUsage(usage));
  info(
    `[pageqa] 用例结束：${report.status === "pass" ? "PASS" : "FAIL"}，` +
      `断言 ${report.assertions.length} 条，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );

  return {
    report,
    text: renderText(report),
    json: JSON.stringify(report, null, 2),
    transcript,
    usage,
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
  setDebug(opts.debug ?? false);
  const scenarios = splitScenarios(script);
  const results: AgentRunResult[] = [];
  info(
    `[pageqa] 套件共 ${scenarios.length} 个场景：` +
      scenarios.map((s) => s.name).join(" / "),
  );
  for (const [i, sc] of scenarios.entries()) {
    info(
      `[pageqa] ═══ 场景 ${i + 1}/${scenarios.length}：${sc.name} ═══`,
    );
    const r = await runAgent(sc.body, { ...opts, systemPrompt: undefined });
    results.push(r);
    info(
      `[pageqa] ═══ 场景 ${i + 1}/${scenarios.length} 结束：` +
        `${r.report.status === "pass" ? "PASS" : "FAIL"} ═══`,
    );
  }
  const overall = results.every((r) => r.report.status === "pass")
    ? "pass"
    : "fail";
  const usage = results.reduce((acc, r) => mergeUsage(acc, r.usage), emptyUsage());
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
    // 逐场景明细：JSON 报告里保留 steps/trace，CI 侧可直接定位失败场景的卡点步骤。
    scenarios: results.map((r, i) => ({
      name: scenarios[i]?.name ?? String(i + 1),
      status: r.report.status,
      steps: r.report.steps ?? [],
      trace: r.report.trace ?? [],
      assertions: r.report.assertions,
    })),
    usage,
  };
  return {
    report: summary,
    text: renderSuiteText(summary, results, scenarios),
    json: JSON.stringify(summary, null, 2),
    transcript: summary.transcript,
    usage,
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
  if (r.summary)   lines.push("摘要: " + r.summary);
  lines.push("---");
  lines.push(r.transcript.trim());
  lines.push("---");
  lines.push(formatUsage(r.usage));
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
    // 执行轨迹：套件模式下不再只给一个「23/42」，把工具调用与步骤自述还原出来，
    // 使用者才能判断「卡在用例的哪一步、该改哪一句」。
    const trace = r.report.trace ?? [];
    if (trace.length > 0) {
      const shown = trace.slice(-TRACE_TAIL_LINES);
      lines.push(`  执行轨迹（末尾 ${shown.length}/${trace.length} 条）:`);
      for (const t of shown) lines.push("    " + t);
    }
    lines.push("  " + formatUsage(r.usage));
  });
  lines.push("");
  lines.push("汇总: " + summary.summary);
  lines.push("---");
  lines.push(formatUsage(summary.usage));
  return lines.join("\n");
}
