import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createModelCatalog,
  hasProvider,
  loadBuiltinProviders,
  resolveModel,
  type ModelCatalog,
  type ModelChoice,
} from "./models.js";
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
  numberSteps,
  parseAssertions,
  parseProgress,
  renderSuiteText,
  renderText,
  statusTag,
  summarizeSuite,
  type AssertionResult,
  type TestReport,
  type TokenUsage,
} from "./report.js";
import { Recorder } from "./record.js";
import type { ScenarioRecording } from "./replay.js";
import { restorePlaceholders, type RunVarValue } from "./vars.js";
import { t } from "./i18n.js";

export interface AgentOptions {
  session?: string;
  systemPrompt?: string;
  debug?: boolean;
  /**
   * 中止信号（交互模式下用户按 Esc）。触发时调用 `Agent.abort()`，
   * 该信号会一路贯穿到 bsk 工具的 `execute(..., signal)` 并 kill 掉正在跑的子进程。
   */
  abortSignal?: AbortSignal;
  /** 场景名（套件模式下由 `## 场景名` 提供），写进录制结果供回放脚本使用。 */
  scenarioName?: string;
  /** 本次运行展开 `${...}` 占位符用的取值，录制回放脚本时用于把具体值还原成占位符。 */
  vars?: RunVarValue[];
  /** 将要写入的回放脚本路径（仅用于在报告里标注，落盘由 CLI 负责）。 */
  scriptPath?: string;
  /**
   * 本次运行使用的模型（provider + model id）。
   * 交互模式在 /model 切换后逐场景传入；缺省用配置文件里保存的默认选择。
   */
  model?: ModelChoice;
  /**
   * 共享的模型目录。交互模式注入同一个实例，使 /login 得到的凭据与刚切换的模型
   * 对本场景立即生效；批处理模式不传，由 runAgent 自建（只含自定义端点）。
   */
  catalog?: ModelCatalog;
}

export interface AgentRunResult {
  report: TestReport;
  text: string;
  json: string;
  transcript: string;
  usage: TokenUsage;
  /** 本次运行录制到的可回放步骤（单场景一条；套件模式逐场景一条）。 */
  recordings: ScenarioRecording[];
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
  "下拉菜单（关键）：",
  "- 很多组件库（如 element-plus 的 el-dropdown）的下拉菜单是**悬停触发**的：必须先用 hover 悬停在触发按钮上、等菜单展开，再 click 菜单项。直接 click 触发按钮常常点不开菜单。",
  "- 判断菜单是否已展开：snapshot 里出现了对应的菜单项（如 menuitem「上传文档」）。若 click 触发按钮后 snapshot 里没有菜单项，改为 hover 再点，不要继续在同一个位置重复 click。",
  "- 页面上可能有多个同名下拉（例如页面级的「操作」与当前区域级的「操作」）。选错会展开完全不同的菜单，后续步骤连锁失败：请按当前操作的区域选择那一个，并在它展开后确认菜单项与用例要求一致。",
  "- `@eN` 编号只在**最近一次 snapshot 的页面状态下**有效：展开/收起下拉菜单、切换路由、提交表单等任何页面变化都会重新编号。若在你上次 snapshot 之后页面又变化过，必须先重新 snapshot 再取用 `@eN`，不得沿用旧编号——沿用会点到编号相同的另一个元素，而且工具不会报错。",
  "- 若快照里找不到目标元素（例如展开的下拉菜单把下方控件遮住了），不要凭编号猜：先重新 snapshot（必要时先收起菜单），等目标元素出现在快照里再操作。",
  "- 声称某一步完成前必须有依据：快照或工具结果里能看到该操作的效果（选中态、填入值、成功提示）。看不到就说明没生效，要重新定位后重做，不要照抄用例描述交差。",
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
 * 断言在**字面包含未命中**时会请 Jev 做一次语义复核（命中则不调用，省一次远端往返）。
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
    if (holder.id) await closeSession(holder.id);
  }
}

/** 单个场景的 agent 编排上下文：一次 setup 产出，供执行与收尾两个阶段复用。 */
interface AgentSession {
  agent: Agent;
  /** agent 事件累积的原始文本（工具调用/输出），供报告与续跑判定使用。 */
  events: string[];
  /** 用例编号后的文本，作为首次 prompt。 */
  numbered: string;
  /** 步骤清单（用于日志与卡点定位）。 */
  steps: string[];
  /** 回放脚本录制器（记录成功执行过的浏览器操作）。 */
  recorder: Recorder;
  /**
   * 本次运行中 `assert_text` 工具返回的断言结果（按执行顺序）。
   *
   * 报告以它为断言准源：工具返回「成立/不成立」是确定性的，模型自述的措辞则
   * 时好时坏（写成「…，断言成立。」时既无期望值也无法解析，会把通过的用例判成假失败）。
   */
  assertions: AssertionResult[];
  startedAt: number;
  /** 调用方传入的中止信号（无则为 undefined）。 */
  abortSignal?: AbortSignal;
}

/**
 * 本轮是否被调用方主动中止（而非报错）。
 *
 * pi-agent-core 没有 `aborted` 事件，中止表现为「signal 被 abort」+「最后一条 assistant
 * 消息的 stopReason 变成 aborted」（见其 `handleRunFailure`），因此两条线索都要看：
 * 只看 signal 会漏掉「stream 自己按契约返回 aborted」，只看消息会漏掉「还没进到消息阶段
 * 就被中止」。
 */
function wasAborted(
  signal: AbortSignal | undefined,
  agent: Agent,
): boolean {
  if (signal?.aborted) return true;
  const messages = agent.state.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; stopReason?: string };
    if (m.role !== "assistant") continue;
    return m.stopReason === "aborted";
  }
  return false;
}

/**
 * 阶段一：准备运行环境。
 * 完成 LLM 后端创建、bsk 就绪检查、session 创建、工具组装、Agent 实例化与事件订阅。
 */
async function initializeAgent(
  input: string,
  opts: AgentOptions,
  holder: SessionHolder,
): Promise<AgentSession> {
  const debug = opts.debug ?? false;
  const log = debugLog;
  const startedAt = Date.now();

  log("[runAgent] 开始，输入长度=" + input.length);
  // 由 pageqa 统一给用例的每行编号后再交给模型：模型输出的「步骤完成：k/n」
  // 就能映射回用例原文，报告可直接指出「停在哪一步、下一步该做什么」。
  const { numbered, steps } = numberSteps(input);
  info(
    t("log.caseStart", {
      text: preview(input),
      chars: input.length,
      steps: steps.length,
    }),
  );

  log("[runAgent] 解析模型目录...");
  // 批处理模式自建目录（只含自定义端点，保持启动开销不变）；交互模式复用 TUI 注入的实例，
  // 这样 /model 的切换与 /login 的凭据都能在这次运行里立即生效。
  const catalog = opts.catalog ?? (await createModelCatalog());
  const choice = opts.model ?? catalog.defaultChoice;
  // 选择的 provider 尚未注册时才补加载内置 provider：自定义端点路径不会为这棵依赖树买单。
  if (!hasProvider(catalog, choice.provider)) {
    log("[runAgent] 注册内置 provider（选择=" + choice.provider + "）...");
    await loadBuiltinProviders(catalog);
  }
  const model = resolveModel(catalog, choice);
  if (!model) {
    throw new Error(
      t("err.modelNotFound", {
        provider: choice.provider,
        model: choice.model,
      }),
    );
  }
  const models = catalog.models;
  log("[runAgent] 模型已解析，model=" + choice.provider + "/" + model.id);
  info(t("log.llmReady", { model: model.id }));

  info(t("log.checkDaemon"));
  await ensureBskReady();
  info(t("log.createSession"));
  const session = await ensureSession(opts.session);
  holder.id = session;
  log("[runAgent] bsk session=" + session);
  info(t("log.session", { id: session }));

  const jevClient = new JevClient(loadConfig().jev, debug);
  log("[runAgent] Jev enabled=" + jevClient.enabled);
  info(
    t("log.jev", {
      state: jevClient.enabled ? t("common.enabled") : t("common.disabled"),
    }),
  );

  // 录制器：始终收集本次运行的操作序列，是否落盘由 CLI 的 --emit-script 决定。
  // 「哪条断言靠 Jev 语义复核才成立」由工具层逐条上报（见 bsk/tools.ts），
  // 不再按「整场是否启用 Jev」一刀切——字面命中的断言回放同样能通过，不必标记。
  const recorder = new Recorder(opts.vars ?? []);
  // 断言结果由工具层逐条上报（见 bsk/tools.ts 的 onExec），报告不再依赖模型措辞。
  const assertions: AssertionResult[] = [];
  const tools = createBskTools({
    session,
    jevClient,
    onExec: (event) => {
      recorder.noteTool(event);
      if (event.assert) {
        assertions.push({
          expectation: event.assert.expectation,
          verdict: event.assert.pass ? "pass" : "fail",
          evidence: event.assert.evidence,
        });
      }
    },
  });
  log(
    "[runAgent] 工具数=" +
      tools.length +
      " " +
      tools.map((t) => t.name).join(", "),
  );
  info(t("log.toolsReady", { n: tools.length, steps: steps.length }));

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

  subscribeProgress(agent, events, recorder);

  // 用户在交互模式里按 Esc → 中止本轮运行。
  // `Agent.abort()` 是 pi-agent-core 唯一的中断入口：它 abort 内部那个 AbortController，
  // 该 signal 一路贯穿到工具的 `execute(..., signal)`，bsk 层据此 kill 掉正在跑的子进程。
  // 若传入时就已经被中止（排队期间被取消），不注册监听——由调用方负责别开始执行。
  if (opts.abortSignal && !opts.abortSignal.aborted) {
    opts.abortSignal.addEventListener("abort", () => agent.abort(), {
      once: true,
    });
  }

  return {
    agent,
    events,
    numbered,
    steps,
    recorder,
    assertions,
    startedAt,
    abortSignal: opts.abortSignal,
  };
}

/**
 * 从工具结果里抽出可读文本。工具失败时，pi-agent-core 会把 `error.message` 放进
 * `result.content[0].text`（见其 agent-loop 的 `createErrorToolResult`），因此这里
 * 拿到的就是**失败原因本身**。
 */
export function toolResultText(result: unknown): string {
  const content = (result as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => ((part as { text?: string } | null)?.text ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

/** 压成单行并截断：失败原因往往是多行堆栈，不能整段灌进日志与轨迹。 */
function clipOneLine(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

/**
 * 订阅 agent 事件，把工具调用与模型输出记入 events，并把进度回显到 stderr。
 *
 * 工具执行进度始终打印（默认可见），让长流程每跑一步都有回显；
 * 避免出现「终端长时间无输出、不知道卡在哪一步」的观感。
 */
function subscribeProgress(
  agent: Agent,
  events: string[],
  recorder: Recorder,
): void {
  const log = debugLog;
  let toolCount = 0;
  let toolStartedAt = 0;
  let firstTextLogged = false;

  agent.subscribe((e) => {
    if (e.type === "tool_execution_start") {
      events.push("[tool] " + e.toolName);
      log("[agent] 工具调用开始: " + e.toolName);
      toolCount += 1;
      toolStartedAt = Date.now();
      info(t("log.toolStart", { n: toolCount, tool: e.toolName }));
    } else if (e.type === "tool_execution_end") {
      const cost = toolStartedAt ? Date.now() - toolStartedAt : 0;
      // 失败原因必须落进日志与执行轨迹。
      // 只写「失败，将重试或报告」的话，交互模式下盯着视口也分不清是
      // 「本地服务没起」「URL 写错」还是「选择器匹配不上」——而这三种的处理方式完全不同。
      const reason = e.isError ? clipOneLine(toolResultText(e.result)) : "";
      events.push(
        (e.isError ? "[tool-error] " : "[tool-ok] ") +
          e.toolName +
          (reason ? "：" + reason : ""),
      );
      log(
        "[agent] 工具调用" + (e.isError ? "失败" : "完成") + ": " + e.toolName,
      );
      info(
        t("log.toolEnd", {
          mark: e.isError ? "✗" : "✓",
          n: toolCount,
          tool: e.toolName,
          reason: reason ? "：" + reason : "",
          retry: e.isError ? "（将重试或报告）" : "",
          cost,
        }),
      );
    } else if (
      e.type === "message_update" &&
      e.assistantMessageEvent?.type === "text_delta"
    ) {
      if (!firstTextLogged) {
        firstTextLogged = true;
        info(t("log.modelOutput"));
      }
      events.push(e.assistantMessageEvent.delta);
      // 顺带给录制器喂文本：从「第 k 步完成」自述里跟踪进度，
      // 把后续工具调用映射回用例步骤号（映射不准时为 null，不影响回放）。
      recorder.noteText(e.assistantMessageEvent.delta);
    }
  });
}

/**
 * 阶段二：发首次用例，并在「有明确证据表明还没执行完」时续跑。
 * 证据 = agent 自报进度未满，或用例中断言数还没跑够；进度无推进则提前停止。
 */
async function executeWithContinuations(
  session: AgentSession,
  input: string,
): Promise<void> {
  const { agent, events, numbered } = session;
  const log = debugLog;

  // 开始前就已被取消（排队时被 /cancel）→ 一步都不跑。
  // 否则会真发起一轮 LLM 调用，白花钱还留下半截记录。
  if (session.abortSignal?.aborted) {
    info(t("log.cancelledBeforeStart"));
    return;
  }

  log("[runAgent] 发送 prompt...");
  info(t("log.caseSubmitted"));
  await agent.prompt(numbered);
  log("[runAgent] prompt 完成，等待 idle...");
  await agent.waitForIdle();

  const expectedAssertions = countAssertions(input);
  let lastSignature: string | null = null;
  for (let round = 0; round < MAX_CONTINUATIONS; round++) {
    if (agent.state.errorMessage) break;
    // 被中止的轮次绝不「续跑」：续跑会立刻再发起一轮 LLM 调用，
    // 而用户按下 Esc 表达的正是「我不想再等这个了」。
    if (wasAborted(session.abortSignal, agent)) {
      log("[runAgent] 本轮已被中止，停止续跑");
      break;
    }
    const transcriptSoFar = events.join("");
    const progress = parseProgress(transcriptSoFar);
    // 断言进度以工具结果为准（模型自述的措辞时好时坏，可能一条都解析不出来）；
    // 只有在拿不到工具结果时才退回按结论文本解析（与 buildReport 同一条规则，
    // 不能用两者较大值——结论文本解析计数一高就会压过可靠的工具结果）。
    const parsed =
      session.assertions.length > 0
        ? session.assertions.length
        : parseAssertions(transcriptSoFar).length;
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
      t("log.continuation", {
        n: round + 1,
        progress: progress
          ? `${progress.done}/${progress.total}`
          : t("log.undeclared"),
        a: parsed,
        b: expectedAssertions,
      }),
    );
    await agent.prompt(continuePrompt(progress));
    await agent.waitForIdle();
  }

  log("[runAgent] idle 完成，耗时=" + (Date.now() - session.startedAt) + "ms");
}

/**
 * 阶段三：根据执行轨迹整理报告。
 * agent 因错误/上下文超限中断时，绝不当作「正常跑完」，而是显式追加强制失败断言。
 */
function finalizeResult(
  session: AgentSession,
  input: string,
  opts: AgentOptions,
): AgentRunResult {
  const { agent, events, startedAt } = session;
  const log = debugLog;

  // 循环可能因模型报错/上下文超限而提前结束；此时绝不能当成「正常跑完」。
  const agentError = agent.state.errorMessage;
  log(
    "[runAgent] 消息数=" +
      agent.state.messages.length +
      "，错误=" +
      (agentError ?? "无"),
  );
  if (agentError) events.push("\n[agent-error] " + agentError + "\n");

  const aborted = wasAborted(session.abortSignal, agent);
  const transcript = events.join("");
  const report = buildReport(input, transcript, session.assertions, {
    cancelled: aborted,
  });
  // 报告里标注回放脚本的落盘位置（真正写文件由 CLI 在运行结束后完成）
  if (opts.scriptPath) report.script = opts.scriptPath;
  if (aborted) {
    log("[runAgent] 本轮被用户中止，记为「已取消」：不进退出码、不写入回放脚本");
  } else if (agentError) {
    report.status = "fail";
    report.assertions.push({
      expectation: t("report.agentErrorExpectation"),
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
    t("log.caseEnd", {
      status: statusTag(report.status),
      n: report.assertions.length,
      dur: ((Date.now() - startedAt) / 1000).toFixed(1),
    }),
  );

  return {
    report,
    text: renderText(report),
    json: JSON.stringify(report, null, 2),
    transcript,
    usage,
    // 录制结果与「跑得成不成功」无关：失败运行也能导出脚本（--emit-script），
    // 便于排查「模型这次到底做了什么」。
    recordings: [
      {
        name: opts.scenarioName ?? t("common.scenarioDefault"),
        // 用例原文同样按占位符形式写进脚本：这份文本会被回放报告用来指出
        // 「对应用例第 k 步」，与用户的用例文件保持一致才不会看着像写死了值。
        caseSteps: (report.steps ?? []).map((s) =>
          restorePlaceholders(s, opts.vars ?? []),
        ),
        steps: session.recorder.recorded,
      },
    ],
  };
}

/** runAgent 的实际编排逻辑；session 记录到 holder 供调用方兜底清理。 */
async function runAgentCore(
  input: string,
  opts: AgentOptions,
  holder: SessionHolder,
): Promise<AgentRunResult> {
  setDebug(opts.debug ?? false);
  const session = await initializeAgent(input, opts, holder);
  await executeWithContinuations(session, input);
  return finalizeResult(session, input, opts);
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
      collected.push({ name: currentName || t("common.scenarioDefault"), body });
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
    : [{ name: t("common.scenarioDefault"), body: script.trim() }];
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
    t("log.suiteStart", {
      n: scenarios.length,
      names: scenarios.map((s) => s.name).join(" / "),
    }),
  );
  for (const [i, sc] of scenarios.entries()) {
    info(
      t("log.suiteScenario", {
        i: i + 1,
        n: scenarios.length,
        name: sc.name,
      }),
    );
    const r = await runAgent(sc.body, {
      ...opts,
      systemPrompt: undefined,
      scenarioName: sc.name,
    });
    results.push(r);
    info(
      t("log.suiteScenarioEnd", {
        i: i + 1,
        n: scenarios.length,
        status: r.report.status === "pass" ? "PASS" : "FAIL",
      }),
    );
  }
  // 汇总口径与回放模式共用同一实现（report.ts 的 summarizeSuite），两种模式报告结构一致。
  const summary = summarizeSuite(
    scenarios.map((sc, i) => ({
      name: sc.name,
      report: results[i].report,
      usage: results[i].usage,
    })),
  );
  if (opts.scriptPath) summary.script = opts.scriptPath;
  return {
    report: summary,
    text: renderSuiteText(summary, results, scenarios),
    json: JSON.stringify(summary, null, 2),
    transcript: summary.transcript,
    usage: summary.usage ?? emptyUsage(),
    recordings: results.flatMap((r) => r.recordings),
  };
}

// 报告渲染（renderText / renderSuiteText）与套件汇总（summarizeSuite）在 report.ts 中实现，
// 由 LLM 运行与零模型回放共用，保证两种模式的报告结构与汇总口径一致。
