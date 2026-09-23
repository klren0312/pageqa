/**
 * 交互模式：跑用例的同时可以提交新场景。
 *
 * 界面用 pi-tui 的 `TuiAltScreen`（全屏、应用自管滚动）：上方是可滚动的日志视口（跟随末尾、
 * 上万行也不会触发全量重绘），下方是固定在底部的输入框与状态栏——这正是「长流程跑十几分钟、
 * 期间还能追加用例」需要的布局（见 ADR-0002）。
 *
 * pi-tui 是**延迟加载**的（`await import`）：批处理与回放路径不该为一份 UI 依赖付启动开销，
 * 而且 UI 加载失败时有独立的报错，不会连带把整个 CLI 拖崩。
 *
 * 键位（见 ADR-0002 决策三/五）：
 * - `Enter` 提交、`Shift+Enter` 换行；
 * - `Esc` 中止当前场景（记为「已取消」，队列继续跑下一个）；
 * - `Ctrl+C` 收工：中止当前 + 取消全部待办，回到批处理口径输出汇总报告。它是**正常退出**
 *   而不是硬杀——还原终端、打完报告才退；收尾期间再按一次表示「别再等队列了」（`/exit` 同义）。
 *   `SIGINT` 信号（raw 模式没生效时 Ctrl+C 会变成信号）走同一条路，见 ADR-0008。
 * - 日志视口可滚：`PageUp`/`PageDown` 翻页、`Ctrl+↑`/`Ctrl+↓` 逐行、`Home`/`End` 跳到首尾，
 *   鼠标滚轮同样有效；上滚即暂停跟随末尾，此时视口末行会显示一行提示，点它（或按 `End`）
 *   回到底部继续跟随。键位与滚轮步长为什么这么定，见 `./keys.ts`。
 * - `↑`/`↓` 在**输入框为空时**归日志视口：一部分终端会把滚轮翻译成 `↑`/`↓`（VS Code 的
 *   全屏缓冲就是这样），不分派的话滚轮会去翻输入框的历史、日志反而滚不动；历史输入因此
 *   改用 `Ctrl+P`/`Ctrl+N`。输入框里有内容时 `↑`/`↓` 仍归编辑器。理由见 `./keys.ts`。
 *
 * Token 消耗：
 * - **输入框下方**常驻一行本次会话的累计用量（含正在跑的场景的实时值，每轮 LLM 调用后刷新）——
 *   长流程跑到一半就能看出已经烧了多少；文案与报告末行**同源**（同一个 `formatUsage`），
 *   端点没返回 usage 时它会自己说明，不会拿 0 冒充；
 * - 每个场景结束再在日志里补一行该场景的明细，退出时的汇总报告口径不变。
 *
 * 模型探活（见 `../agent.ts` 的 `ensureModelReachable`）：
 * - 每个场景开跑前先探一次模型是否真的能发起请求；不通就把该场景如实记为失败，并把
 *   **剩余待办一起取消**——一次「连不上」不该摊成 N 个「用例失败」，更不该为它开 N 个
 *   浏览器窗口。探活用的是「开跑那一刻」的模型选择，因此 `/model` 换过模型后会自动重探。
 *
 * 无源会话与运行时加载（见 ADR-0005）：
 * - 可以**不带任何用例文件**启动（`pageqa` 无参 + TTY）：队列为空、落点为空；
 * - `/run <路径/关键字>` 加载一个已有用例文件的场景，并把落点切到它；
 * - 落点为空时，追加的场景只存在于本次会话，不写任何文件——退出时要明说，
 *   否则「敲下去就等于留下了」这条前提被抽掉而没人告诉用户。
 *
 * `/new` 开新会话（见 ADR-0009）：
 * - 清空视口与运行队列、token 计数从头开始，**但上一批先归档**——退出时的汇总报告与
 *   回放脚本覆盖整个进程跑过的全部场景（见 `./batches.ts`）；
 * - 队列里还有在跑/待办的场景时拒绝执行（不静默丢掉「已提交但没跑」的场景）；
 * - 落点不跟着换（静默丢落点会让之后敲下的用例不再写回文件）。
 *
 * 模型切换与登录（见 ADR-0004）：
 * - `/model` 打开模型选择器：`Enter` 本次会话生效、`Ctrl+S` 同时设为启动默认（写回 config.json）；
 * - `/login` 登录一个内置 provider（API Key 或订阅 OAuth），凭据写入 `~/.pageqa/auth.json`；
 * - `/logout` 移除某个 provider 的本地凭据。
 * 选择器与登录提问都复用底部输入区（浮层负责选项，输入框负责文本/密钥），
 * 因此「跑场景」与「改配置」用的是同一套输入路径，不需要第二套按键。
 */
import {
  ModelUnreachableError,
  runAgent,
  splitScenarios,
  type AgentRunResult,
} from "../agent.js";
import { info, setSink } from "../log.js";
import {
  emptyUsage,
  formatUsage,
  mergeUsage,
  numberSteps,
  renderSuiteText,
  renderText,
  statusTag,
  summarizeSuite,
  type SuiteMember,
  type TestReport,
  type TokenUsage,
} from "../report.js";
import type { ScenarioRecording } from "../replay.js";
import { expandVars, type RunVarValue } from "../vars.js";
// 仅类型导入（编译期擦除），不会让「非交互路径」为 UI 依赖付出加载开销。
import type {
  Component,
  SelectItem,
  SlashCommand,
  StackChild,
} from "@earendil-works/pi-tui";
import {
  ScenarioQueue,
  type QueuedScenario,
  type ScenarioExecutor,
  type ScenarioOrigin,
  type ScenarioState,
} from "./queue.js";
import {
  combineBatches,
  snapshotBatch,
  type SessionBatch,
} from "./batches.js";
import { accent, dim, editorTheme, err, ok, title, warn } from "./theme.js";
import { frameLines, overlayInnerWidth } from "./overlay-frame.js";
import {
  arrowKeysBelongToLog,
  KEYBINDINGS,
  WHEEL_SCROLL_LINES,
} from "./keys.js";
import {
  appendScenarioToCaseFile,
  loadCaseScenarios,
  scenariosFromInput,
} from "./writeback.js";
import {
  buildPickPrompt,
  displayPath,
  parsePick,
  resolveCaseFile,
} from "./case-source.js";
import { getLocale, setLocale, t } from "../i18n.js";
import {
  CONFIG_PATH,
  readSideOutputPrefs,
  saveLocale,
  saveModelSelection,
  saveSideOutputPref,
  type SideOutputPrefs,
} from "../config.js";
import { AUTH_PATH } from "../auth.js";
import {
  createModelCatalog,
  listLoginOptions,
  listLogoutOptions,
  listModelOptions,
  loadBuiltinProviders,
  resolveModel,
  PAGEQA_PROVIDER_ID,
  type LogoutOption,
  type LoginOption,
  type ModelCatalog,
  type ModelChoice,
  type ModelOption,
} from "../models.js";
// 仅类型导入（编译期擦除）：TUI 路径不需要为 pi-ai 的运行时代码付出加载开销
// （真正的模型目录由 models.ts 按需动态加载）。
import type { AuthEvent, AuthPrompt, AuthType } from "@earendil-works/pi-ai";

export interface InteractiveOptions {
  /**
   * 启动时指定的源用例文件路径，也就是初始落点。
   *
   * 无参启动的会话没有它——落点由运行中的 `/run` 决定（见 ADR-0005 决策四）。
   */
  sourcePath?: string;
  /** 本次运行展开占位符的取值。 */
  vars: RunVarValue[];
  /**
   * 展开 `${...}` 占位符用的时刻。
   *
   * 初始场景、`/run` 加载的场景与全部追加场景**共用同一个**：回放脚本靠
   * 「具体值 → 占位符」反查还原，若各场景各用各的时刻，同一份脚本里一个占位符
   * 会对应多个取值（见 ADR-0002 决策六）。加载场景为何也必须跟会话时刻走，
   * 见 ADR-0005 决策八——同一落点派生的场景会进同一份脚本，而回放端只展开一次。
   */
  now: Date;
  debug: boolean;
  /**
   * 显式指定的回放脚本输出路径（仅用于在汇总报告里标注）。
   *
   * 不给路径时脚本按来源拆、各自贴着源用例写（见 ADR-0005 决策七），
   * 那些路径只有退出时才知道，因此打 stderr 而不是塞进报告。
   */
  scriptPath?: string;
}

export interface InteractiveRunResult {
  /** 全部场景的汇总报告（含「已取消」的场景）。 */
  report: TestReport;
  text: string;
  json: string;
  transcript: string;
  usage: TokenUsage;
  /** 跑过的场景的录制。已取消的不含——半截轨迹录进脚本会让回放跑半个用例还可能报 PASS。 */
  recordings: ScenarioRecording[];
  /** 写回落点的场景数。 */
  writtenBack: number;
  /** 因为没有落点而没能写回的场景数（退出时必须明说，否则等于静默丢数据）。 */
  unwritten: number;
}

// 帮助文本按当前语种实时渲染（/toggle-language 之后要立刻是新语言）。
// 见下方 runCommand 的 "help" 分支。

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * 让模型从候选里挑用例文件的超时。
 *
 * 挑文件只是 `/run` 的一个辅助步骤——它卡住时必须能及时退到手动选择，
 * 不能因为模型端点慢，就让「加载用例文件」这件事看起来坏了。
 */
const PICK_TIMEOUT_MS = 20_000;

/**
 * 看板带渲染所需的最小终端列宽。
 *
 * 5 列要横向铺开，每列至少约 16 显示列（CJK 列名 + 卡名截断）≈ 90 列才够看。
 * pi-tui 的 `ScrollView` 只支持纵向、没有横向滚动，窄屏下硬挤 5 列只会互相覆盖，
 * 因此低于此宽度直接不渲染看板、整片留给日志视口（见 ADR-0010 决策三）。
 */
const KANBAN_MIN_WIDTH = 90;

/** 用户主动取消交互（Esc / Ctrl+C）时用的哨兵错误，与真正的失败区分开。 */
const CANCELLED = "__cancelled__";

function cancelledError(): Error {
  return new Error(CANCELLED);
}

function isCancelled(err: unknown): boolean {
  return msgOf(err) === CANCELLED;
}

/**
 * 选择器的 value 编码：`provider\0model`。
 *
 * 不能用 `provider/model` 这种肉眼可读形式——模型 id 本身可能含 `/`
 * （如 openrouter 的 `openai/gpt-4o`），split 第一个斜杠会把模型名切坏。
 * 用不可见的分隔符既不参与展示，也不会有歧义。
 */
const VALUE_SEP = "\u0000";

function encodeValue(a: string, b: string): string {
  return a + VALUE_SEP + b;
}

function decodeValue(value: string): [string, string] {
  const i = value.indexOf(VALUE_SEP);
  return i < 0 ? [value, ""] : [value.slice(0, i), value.slice(i + 1)];
}

/** 模型选择的展示文案：自定义端点只显示模型 id，内置 provider 带上前缀以便区分。 */
function modelLabel(choice: ModelChoice): string {
  return choice.provider === PAGEQA_PROVIDER_ID
    ? choice.model
    : `${choice.provider}/${choice.model}`;
}

/**
 * 执行抛错时的报告：记成失败，绝不当作「未执行」。
 *
 * `expectation` 可换：模型不可达时「场景执行出错」这句并不准确——那条用例压根没开始跑，
 * 报告该说的是「模型能连通」这条前提不成立（见下方场景执行器里的 ModelUnreachableError 分支）。
 */
function failedResult(
  item: QueuedScenario,
  cause: unknown,
  expectation: string = t("tui.scenarioErrorExpectation"),
): AgentRunResult {
  const message = msgOf(cause);
  const report: TestReport = {
    status: "fail",
    assertions: [
      {
        expectation,
        verdict: "fail",
        evidence: message,
      },
    ],
    transcript: "[agent-error] " + message,
    trace: ["[agent-error] " + message],
    steps: numberSteps(item.body).steps,
    usage: emptyUsage(),
  };
  return {
    report,
    text: renderText(report),
    json: JSON.stringify(report, null, 2),
    transcript: report.transcript,
    usage: emptyUsage(),
    recordings: [],
  };
}

export async function runInteractive(
  input: string,
  opts: InteractiveOptions,
): Promise<InteractiveRunResult> {
  // 交互会话整体墙钟起点：取函数入口（含 TUI 装配与首次 resolveInitialChoice），
  // 代表「整个交互过程」的跨度，退出汇总时用它覆盖 summarizeSuite 的成员求和。
  const interactiveStartedAt = Date.now();
  const {
    TuiAltScreen,
    ProcessTerminal,
    VStack,
    ScrollView,
    Text,
    Editor,
    SelectList,
    CombinedAutocompleteProvider,
    KeybindingsManager,
    TUI_KEYBINDINGS,
    isKeyRelease,
    matchesKey,
    setKeybindings,
    truncateToWidth,
    visibleWidth,
  } = await import("@earendil-works/pi-tui");

  /** 浮层外框：内容按内宽渲染，边框与填充交给 `frameLines`（见 ./overlay-frame.ts）。 */
  class OverlayFrame implements Component {
    constructor(private readonly child: Component) {}

    invalidate(): void {
      this.child.invalidate?.();
    }

    render(width: number): string[] {
      return frameLines(
        this.child.render(overlayInnerWidth(width)),
        width,
        truncateToWidth,
      );
    }
  }

  /**
   * 浮层根组件：负责「标题 + 列表 + 提示」的布局，加一圈边框，并把按键转交给内部的 SelectList。
   *
   * 必须自己实现 `handleInput`：pi-tui 只把按键交给**聚焦组件**，而 VStack/Container
   * 只做布局、不向子组件转发输入，不实现的话方向键/回车会全部石沉大海。
   */
  // 动态 import 拿到的 `SelectList` 是值而非类型，类里要引用实例类型只能这样推导。
  type SelectListInstance = InstanceType<typeof SelectList>;

  class SelectorOverlay extends OverlayFrame {
    constructor(
      private readonly list: SelectListInstance,
      children: StackChild[],
    ) {
      super(new VStack(children));
    }

    handleInput(data: string): void {
      this.list.handleInput(data);
    }
  }

  const terminal = new ProcessTerminal();
  // 滚动键位与滚轮步长是 pi-tui 的全局设置（输入分发时才读取），必须在收到按键之前装好。
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, KEYBINDINGS));
  const tui = new TuiAltScreen(terminal, true, undefined, {
    mouse: true,
    wheelScrollLines: WHEEL_SCROLL_LINES,
    // `follow: "end"` 的代价是「上滚」这件事本身没有别的凭据：没有这行提示，用户只能看到
    // 日志不再刷新，却不知道是自己滚走了、也不知道怎么回去。它同时是可点击的（点一下回底部）。
    scrollToEndIndicator: () => t("tui.scroll.paused"),
  });

  // ── 视口：上方滚动日志 + 底部固定输入区 ──
  const logLines: string[] = [];
  const document = new Text("");
  const transcript = new ScrollView(document, {
    follow: "end",
    primary: true,
    scrollbar: "auto",
  });
  const statusLine = new Text("", 1);
  // token 消耗紧贴输入框下方：`paddingY: 0` —— 它是一行数据，不该像提示行那样上下各留一行空白
  // （那两行空白是日志区的空间）。内容与报告末行同源（同一个 `formatUsage`），口径不会两处不一。
  const usageLine = new Text("", 1, 0);
  const hintLine = new Text(dim(t("tui.hint")), 1);
  const editor = new Editor(tui, editorTheme, { paddingX: 1 });
  // 看板带：上方固定高度按状态把场景分成 5 列（见 ADR-0010）。
  const kanban = new Text("");

  const dock = new VStack([
    { component: statusLine, shrink: 1, minSize: 0 },
    { component: editor, shrink: 1, minSize: 3 },
    { component: usageLine, shrink: 1, minSize: 0 },
    { component: hintLine, shrink: 1, minSize: 0 },
  ]);
  tui.setLayoutRoot(
    new VStack([
      { component: kanban, basis: "auto", grow: 0, shrink: 1, minSize: 0 },
      { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
    ]),
  );
  tui.setFocus(editor);

  // ── 状态 ──
  const results = new Map<number, AgentRunResult>();
  /**
   * 正在跑的那次 `runAgent` 的实时用量（每轮 LLM 调用后由 agent 回调刷新）。
   *
   * 场景结束时以 `results` 里的权威结算值取代它，因此必须清空——否则同一份消耗会被算两遍。
   */
  let runningUsage: TokenUsage | null = null;

  /**
   * 本次会话累计 token 用量 = 已结束场景的结算值 + 正在跑的场景的实时值。
   *
   * 输入框下方那行要回答的是「到现在为止烧了多少」：只算已结束的场景，长流程跑到第十分钟时
   * 显示的仍是上一个场景的数字。
   */
  function sessionUsage(): TokenUsage {
    let acc = emptyUsage();
    for (const r of results.values()) acc = mergeUsage(acc, r.usage);
    if (runningUsage) acc = mergeUsage(acc, runningUsage);
    return acc;
  }
  /**
   * 当前落点（Write-back Target，见 ADR-0005 决策四）：追加场景写回哪个用例文件。
   *
   * 启动时给了源用例文件就是它；无参启动时为空，等 `/run` 加载第一个文件时填上，
   * 之后每次加载都会跟着换（用户刚打开哪个文件，敲下的用例就该写进哪个）。
   * 为空时追加的场景不写任何文件——这是让「无源会话」合法存在必须付的代价。
   */
  let writeBackTarget: string | undefined = opts.sourcePath;
  let writtenBack = 0;
  /** 因为没有落点而没能写回的场景数：退出时要如实报出来，不能静默丢。 */
  let unwritten = 0;
  let shuttingDown = false;
  /** 收尾期间又收到一次收工请求（Ctrl+C / SIGINT / `/exit`）：不再等队列停下。 */
  let finishNow = false;
  let teardown = false;
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });

  // ── 模型目录与会话级模型选择 ──
  // 目录本身不含内置 provider（保持启动开销）；`/model`、`/login` 或配置里指向
  // 内置 provider 时才按需加载（见 resolveInitialChoice / ensureBuiltins）。
  const catalog = await createModelCatalog();
  /** 本次会话当前使用的模型：每个场景开跑时取值，切换只影响之后的场景。 */
  let currentChoice: ModelChoice = { ...catalog.defaultChoice };
  /** 配置里保存的启动默认（Ctrl+S 会更新它）。 */
  let defaultChoice: ModelChoice = { ...catalog.defaultChoice };
  /** 文本/密钥提问的等待态（同一时刻最多一个）。 */
  let pendingAsk: {
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  } | null = null;
  /** 正在进行的登录流程（Esc / 收工时用它中止）。 */
  let loginController: AbortController | null = null;

  /** 往视口追加一行（界面已拆则退回 stderr，避免日志被吞掉）。 */
  const append = (line: string): void => {
    logLines.push(line);
    if (teardown) {
      process.stderr.write(line + "\n");
      return;
    }
    document.setText(logLines.join("\n"));
    tui.requestRender();
  };

  // 日志即视口内容：工具调用、bsk 命令、耗时这些都从 stdio 重定向进来，
  // 「长流程卡在哪一步」在同一屏上就能看到（stdout 仍只留给最终报告）。
  setSink(append);

  // ── 模型与登录：命令实现 ──
  const hintDefault = (): void => hintLine.setText(dim(t("tui.hint")));

  /** 按需加载内置 provider（/model、/login、/logout 与内置默认模型都需要）。 */
  async function ensureBuiltins(): Promise<void> {
    if (!catalog.builtinsLoaded) await loadBuiltinProviders(catalog);
  }

  /**
   * 校正启动时的模型选择。
   *
   * 配置里可能留着「上次登录过的 provider」（例如 anthropic），但那台机器后来
   * 清了凭据、或该模型已下线。此时若不做处理，每个场景都会以「模型不存在」失败，
   * 用户看到的是「工具坏了」而不是「换个模型就好」——因此这里如实告警并退回自定义
   * 端点的第一个模型，让本次会话仍然可用。
   */
  async function resolveInitialChoice(): Promise<void> {
    if (currentChoice.provider === PAGEQA_PROVIDER_ID) return;
    try {
      await ensureBuiltins();
    } catch {
      // 内置 provider 加载失败：下面统一按「不可用」兜底。
    }
    if (resolveModel(catalog, currentChoice)) return;
    const fallback = catalog.models.getModels(PAGEQA_PROVIDER_ID)[0];
    append(
      warn(
        t("tui.model.fallback", {
          provider: currentChoice.provider,
          model: currentChoice.model,
          next: fallback?.id ?? "-",
        }),
      ),
    );
    if (fallback) {
      currentChoice = { provider: PAGEQA_PROVIDER_ID, model: fallback.id };
    }
  }

  /** 选择器的返回值：`save` 表示用户按的是 Ctrl+S（设为启动默认）。 */
  interface SelectorPick {
    value: string;
    save: boolean;
  }

  /**
   * 打开一个选择器浮层并等待选择结果。
   *
   * 用浮层而不是「打印编号 + 读输入」：候选可能上百条（内置 provider 的模型目录），
   * 编号列表既难读也没法翻页/过滤；SelectList 自带方向键、鼠标与滚动。
   */
  function openSelector(
    titleText: string,
    items: SelectItem[],
    opts: { allowSaveDefault?: boolean; hint?: string } = {},
  ): Promise<SelectorPick | undefined> {
    return new Promise((resolve) => {
      const list = new SelectList(
        items,
        Math.min(14, Math.max(3, items.length)),
        editorTheme.selectList,
      );
      const overlay = new SelectorOverlay(list, [
        { component: new Text(title(titleText), 1, 1), shrink: 1, minSize: 1 },
        { component: list, basis: "auto", shrink: 1, minSize: 1 },
        {
          component: new Text(
            dim(
              opts.hint ??
                (opts.allowSaveDefault
                  ? t("tui.model.hint")
                  : t("tui.select.hint")),
            ),
            1,
            1,
          ),
          shrink: 1,
          minSize: 1,
        },
      ]);
      const handle = tui.showOverlay(overlay, {
        width: "90%",
        minWidth: 40,
        maxHeight: "70%",
        anchor: "center",
        margin: 1,
      });

      let settled = false;
      let removeListener: (() => void) | undefined;
      const close = (): void => {
        if (settled) return;
        settled = true;
        removeListener?.();
        handle.hide();
        tui.setFocus(editor);
        tui.requestRender();
      };

      list.onSelect = (item) => {
        close();
        resolve({ value: item.value, save: false });
      };
      list.onCancel = () => {
        close();
        resolve(undefined);
      };
      if (opts.allowSaveDefault) {
        // Ctrl+S 是「设为启动默认」：SelectList 自己不认识这个键，因此在全局输入
        // 监听里截获（监听先于聚焦组件执行，所以这里能抢在列表处理之前拿到）。
        removeListener = tui.addInputListener((data) => {
          if (!matchesKey(data, "ctrl+s")) return undefined;
          const selected = list.getSelectedItem();
          if (selected) {
            const value = selected.value;
            close();
            resolve({ value, save: true });
          }
          return { consume: true };
        });
      }
    });
  }

  /** 追加一条提问并等待用户回车（文本/密钥输入走底部输入框）。 */
  function askUser(
    message: string,
    hint: string = t("tui.login.promptInput"),
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      pendingAsk = { resolve, reject };
      append(accent(message));
      hintLine.setText(dim(hint));
      tui.requestRender();
    });
  }

  /** 用户回车提交提问（由 editor.onSubmit 调用）。 */
  function settleAsk(text: string): void {
    const ask = pendingAsk;
    if (!ask) return;
    pendingAsk = null;
    hintDefault();
    ask.resolve(text);
  }

  /** 提问被取消（Esc / 收工）：拒绝掉等待方，让登录流程按「已取消」收尾。 */
  function rejectAsk(error: Error): void {
    const ask = pendingAsk;
    if (!ask) return;
    pendingAsk = null;
    hintDefault();
    ask.reject(error);
  }

  /** 把 pi-ai 的登录事件回显到视口（授权链接、设备码、进度…）。 */
  function notifyAuth(event: AuthEvent): void {
    switch (event.type) {
      case "auth_url":
        append(accent(t("tui.login.openUrl")));
        append(accent(event.url));
        if (event.instructions) append(dim(event.instructions));
        break;
      case "device_code":
        append(
          accent(
            t("tui.login.deviceCode", {
              url: event.verificationUri,
              code: event.userCode,
            }),
          ),
        );
        append(dim(t("tui.login.waiting")));
        break;
      case "info":
        append(t("tui.login.info", { msg: event.message }));
        for (const link of event.links ?? []) {
          append(accent(link.label ? `${link.label}: ${link.url}` : link.url));
        }
        break;
      case "progress":
        append(dim(event.message));
        break;
    }
  }

  /** 把 pi-ai 的登录提问转成界面交互（select 走浮层，文本/密钥走输入框）。 */
  async function askAuthPrompt(prompt: AuthPrompt): Promise<string> {
    if (prompt.type === "select") {
      const items: SelectItem[] = prompt.options.map((option) => ({
        value: option.id,
        label: option.label,
        description: option.description,
      }));
      const pick = await openSelector(prompt.message, items);
      if (!pick) throw cancelledError();
      return pick.value;
    }
    const message = prompt.placeholder
      ? `${prompt.message}\n(${prompt.placeholder})`
      : prompt.message;
    const hint =
      prompt.type === "manual_code"
        ? t("tui.login.promptManual")
        : t("tui.login.promptInput");
    return await askUser(message, hint);
  }

  /** 执行一次登录：提问/事件都接在界面上，凭据由 pi-ai 写入 CredentialStore。 */
  async function runLogin(provider: string, type: AuthType): Promise<void> {
    const controller = new AbortController();
    loginController = controller;
    append(
      accent(
        t("tui.login.pending", {
          provider,
          method: type === "oauth" ? "OAuth" : "API key",
          path: AUTH_PATH,
        }),
      ),
    );
    try {
      await catalog.models.login(provider, type, {
        signal: controller.signal,
        prompt: (prompt) => askAuthPrompt(prompt),
        notify: (event) => notifyAuth(event),
      });
      append(ok(t("tui.login.success", { provider, path: AUTH_PATH })));
    } catch (err2) {
      if (controller.signal.aborted || isCancelled(err2)) {
        append(warn(t("tui.login.cancelled", { provider })));
      } else {
        append(err(t("tui.login.failed", { provider, msg: msgOf(err2) })));
      }
    } finally {
      loginController = null;
      // 兜底：登录流程已结束，不该再留着未决提问（否则下一次回车会被它吃掉）。
      rejectAsk(cancelledError());
      hintDefault();
      tui.requestRender();
    }
  }

  /** 应用一次模型选择（`persist` 为真时同时写回配置作为启动默认）。 */
  async function applyModel(
    choice: ModelChoice,
    persist: boolean,
  ): Promise<void> {
    try {
      await ensureBuiltins();
    } catch {
      // 已加载过、或加载失败：下面按目录现状校验并给出可读报错。
    }
    if (!resolveModel(catalog, choice)) {
      append(
        err(
          t("tui.model.switchFailed", {
            provider: choice.provider,
            model: choice.model,
          }),
        ),
      );
      return;
    }
    currentChoice = { ...choice };
    append(
      accent(
        t("tui.model.switched", {
          provider: choice.provider,
          model: choice.model,
        }),
      ),
    );
    if (persist) {
      try {
        saveModelSelection(choice.provider, choice.model);
        defaultChoice = { ...choice };
        append(
          ok(
            t("tui.model.savedDefault", {
              provider: choice.provider,
              model: choice.model,
              path: CONFIG_PATH,
            }),
          ),
        );
      } catch (err2) {
        append(err(t("tui.model.saveDefaultFailed", { msg: msgOf(err2) })));
      }
    }
    updateStatus();
  }

  /** 面板里语言项显示的名字：语种名本身不翻译。 */
  function localeLabel(): string {
    return getLocale() === "en" ? "English" : "中文";
  }

  /** 切换界面语种并写回配置：`/setting` 面板与 `/toggle-language` 别名共用。 */
  function switchLocale(): void {
    const next = getLocale() === "en" ? "zh" : "en";
    setLocale(next);
    try {
      saveLocale(next);
      append(t("tui.languageSwitched", { locale: next }));
    } catch (err2) {
      append(t("tui.languageSwitchFailed", { locale: next, msg: msgOf(err2) }));
    }
    // 底部提示行与命令补全描述都是构建时写死的文本，这里手动刷新一下。
    hintLine.setText(dim(t("tui.hint")));
    installAutocomplete();
    updateStatus();
  }

  /**
   * `/setting`：修改旁路产物开关与语言（ADR-0011 决策二）。
   *
   * 切换即写回配置并**重开面板**：三项常常一次要改不止一项，让用户关掉再敲一次 `/setting`
   * 是多余的一步。Esc 关面板。语言并入这里之后，`/toggle-language` 只作为未文档化的别名
   * 保留（不进 `/help`、不进补全），老习惯不被打断。
   */
  async function openSettingPanel(): Promise<void> {
    for (;;) {
      const prefs = readSideOutputPrefs();
      const items: SelectItem[] = [
        {
          value: "htmlReport",
          label: t("tui.setting.report"),
          description: prefs.htmlReport
            ? t("tui.setting.on")
            : t("tui.setting.off"),
        },
        {
          value: "replayScript",
          label: t("tui.setting.replayScript"),
          description: prefs.replayScript
            ? t("tui.setting.on")
            : t("tui.setting.off"),
        },
        {
          value: "locale",
          label: t("tui.setting.locale"),
          description: localeLabel(),
        },
      ];
      const pick = await openSelector(t("tui.setting.title"), items, {
        hint: t("tui.setting.hint", { path: CONFIG_PATH }),
      });
      if (!pick) return;
      if (pick.value === "locale") {
        switchLocale();
        continue;
      }
      const key: keyof SideOutputPrefs =
        pick.value === "htmlReport" ? "htmlReport" : "replayScript";
      const next = !prefs[key];
      try {
        saveSideOutputPref(key, next);
        append(
          t("tui.setting.saved", {
            name: t(
              key === "htmlReport"
                ? "tui.setting.report"
                : "tui.setting.replayScript",
            ),
            value: next ? t("tui.setting.on") : t("tui.setting.off"),
          }),
        );
      } catch (err2) {
        append(err(t("tui.setting.failed", { msg: msgOf(err2) })));
      }
    }
  }

  /** `/model`：列出可用模型并切换。 */
  async function openModelSelector(): Promise<void> {
    append(dim(t("tui.model.loading")));
    try {
      await ensureBuiltins();
    } catch (err2) {
      append(err(t("tui.model.loadFailed", { msg: msgOf(err2) })));
      return;
    }
    let options: ModelOption[];
    try {
      options = await listModelOptions(catalog);
    } catch (err2) {
      append(err(t("tui.model.loadFailed", { msg: msgOf(err2) })));
      return;
    }
    if (options.length === 0) {
      append(warn(t("tui.model.empty")));
      return;
    }
    const items: SelectItem[] = options.map((o) => {
      const badges: string[] = [];
      if (o.provider === defaultChoice.provider && o.model === defaultChoice.model) {
        badges.push(t("tui.model.badgeDefault"));
      }
      if (o.provider === currentChoice.provider && o.model === currentChoice.model) {
        badges.push(t("tui.model.badgeCurrent"));
      }
      return {
        value: encodeValue(o.provider, o.model),
        label: o.model + (badges.length > 0 ? `  [${badges.join(" / ")}]` : ""),
        description: `${o.providerName} · ctx ${o.contextWindow}`,
      };
    });
    const pick = await openSelector(
      t("tui.model.title", { current: modelLabel(currentChoice) }),
      items,
      { allowSaveDefault: true },
    );
    if (!pick) return;
    const [provider, model] = decodeValue(pick.value);
    await applyModel({ provider, model }, pick.save);
  }

  /** `/login`：选 provider/登录方式，然后跑登录流程。 */
  async function openLoginSelector(): Promise<void> {
    try {
      await ensureBuiltins();
    } catch (err2) {
      append(err(t("tui.login.loadFailed", { msg: msgOf(err2) })));
      return;
    }
    let options: LoginOption[];
    try {
      options = await listLoginOptions(catalog);
    } catch (err2) {
      append(err(t("tui.login.loadFailed", { msg: msgOf(err2) })));
      return;
    }
    if (options.length === 0) {
      append(warn(t("tui.login.noProviders")));
      return;
    }
    const items: SelectItem[] = options.map((o) => ({
      value: encodeValue(o.provider, o.type),
      label:
        o.type === "oauth"
          ? t("tui.login.methodOauth", {
              label: o.label ?? o.providerName,
            })
          : `${o.providerName} · ${t("tui.login.methodApiKey")}`,
      description:
        o.provider + (o.configured ? " · " + t("tui.login.loggedIn") : ""),
    }));
    const pick = await openSelector(t("tui.login.title"), items);
    if (!pick) return;
    const [provider, type] = decodeValue(pick.value);
    await runLogin(provider, type === "oauth" ? "oauth" : "api_key");
  }

  /** `/logout`：移除某个 provider 的本地凭据。 */
  async function openLogoutSelector(): Promise<void> {
    try {
      await ensureBuiltins();
    } catch {
      // provider 名取不到时退回 provider id 展示，不阻断登出。
    }
    let options: LogoutOption[];
    try {
      options = await listLogoutOptions(catalog);
    } catch (err2) {
      append(err(t("tui.logout.loadFailed", { msg: msgOf(err2) })));
      return;
    }
    if (options.length === 0) {
      append(dim(t("tui.logout.empty")));
      return;
    }
    const items: SelectItem[] = options.map((o) => ({
      value: encodeValue(o.provider, o.type),
      label: o.providerName,
      description: o.provider,
    }));
    const pick = await openSelector(t("tui.logout.title"), items);
    if (!pick) return;
    const [provider] = decodeValue(pick.value);
    try {
      await catalog.models.logout(provider);
      append(ok(t("tui.logout.success", { provider })));
    } catch (err2) {
      append(err(t("tui.logout.failed", { provider, msg: msgOf(err2) })));
    }
  }

  /** 场景来源的短标签：用例文件用相对路径（便于阅读），追加场景标「追加」。 */
  function originLabel(origin: ScenarioOrigin): string {
    return origin.kind === "added"
      ? t("tui.originAdded")
      : displayPath(origin.path);
  }

  /** 把字符串按显示宽度补空格到 w（CJK 占 2 宽，故用 visibleWidth 而非字符数）。 */
  function padToWidth(s: string, w: number): string {
    return s + " ".repeat(Math.max(0, w - visibleWidth(s)));
  }

  /**
   * 看板带：把场景按状态分成 5 列渲染（见 ADR-0010）。
   *
   * 纯展示、不滚动：列内只放得下的最近若干张，`+N 更多` 收尾，全量列表永远在 `/status`
   * 与日志里。这样不引入列内滚动，也就不碰 `↑/↓` 空输入归日志视口的键位契约。
   * 终端列数 < KANBAN_MIN_WIDTH 时整片清空，把空间让回日志视口。
   * "进行中"列尾部追加实时耗时，由 `updateStatus` 的 1s ticker 刷新。
   */
  function renderKanban(): void {
    const term = tui.terminal;
    const cols = term.columns;
    if (cols < KANBAN_MIN_WIDTH) {
      kanban.setText("");
      return;
    }
    const all = queue.all();
    const columns: {
      title: string;
      color: (s: string) => string;
      pick: (i: QueuedScenario) => boolean;
    }[] = [
      { title: t("tui.kanban.waiting"), color: dim, pick: (i) => i.state === "queued" },
      { title: t("tui.kanban.running"), color: accent, pick: (i) => i.state === "running" },
      { title: t("tui.kanban.pass"), color: ok, pick: (i) => i.state === "pass" },
      { title: t("tui.kanban.fail"), color: err, pick: (i) => i.state === "fail" },
      { title: t("common.cancelled"), color: warn, pick: (i) => i.state === "cancelled" },
    ];
    const groups = columns.map((c) => all.filter(c.pick));
    const sep = 1;
    const colWidth = Math.floor((cols - sep * (columns.length - 1)) / columns.length);
    if (colWidth < 8) {
      kanban.setText("");
      return;
    }
    // 看板带高度上限：预留状态栏 + 输入区 + 至少几行日志，故随终端高度自适应（2~7 行）。
    const maxRows = Math.max(2, Math.min(7, (term.rows || 24) - 10));
    const sepStr = dim("│");
    const more = t("tui.kanban.more");
    const headerCells = columns.map((c, idx) => {
      const title = truncateToWidth(`${c.title} (${groups[idx].length})`, colWidth, "…", false);
      return c.color(padToWidth(title, colWidth));
    });
    const bodyCells = columns.map((c, idx) => {
      const items = groups[idx];
      const cap = items.length > maxRows ? maxRows - 1 : maxRows;
      const lines: string[] = [];
      for (const it of items.slice(0, cap)) {
        let label = `#${it.id} ${it.name}`;
        if (it.state === "running" && it.startedAt != null) {
          label += ` · ${fmtDuration(Date.now() - it.startedAt)}`;
        }
        label = truncateToWidth(label, colWidth, "…", false);
        lines.push(c.color(padToWidth(label, colWidth)));
      }
      if (items.length > maxRows) {
        lines.push(dim(padToWidth(`… +${items.length - cap} ${more}`, colWidth)));
      }
      while (lines.length < maxRows) lines.push(" ".repeat(colWidth));
      return lines;
    });
    const rows: string[] = [headerCells.join(sepStr)];
    for (let r = 0; r < maxRows; r++) {
      rows.push(bodyCells.map((c) => c[r]).join(sepStr));
    }
    kanban.setText(rows.join("\n"));
  }

  function updateStatus(): void {
    const all = queue.all();
    const running = queue.running();
    const waiting = queue.waiting().length;
    const settled = all.filter(
      (i) => i.state !== "queued" && i.state !== "running",
    ).length;
    const bits: string[] = [title(t("tui.title"))];
    if (running) {
      bits.push(
        accent(running.name) +
          " " +
          t("tui.running", {
            i: settled + 1,
            n: all.length,
            duration: fmtDuration(Date.now() - (running.startedAt ?? Date.now())),
          }),
      );
    } else if (shuttingDown) {
      bits.push(dim(t("tui.shuttingDown")));
    } else if (all.length > 0 && settled === all.length) {
      bits.push(ok(t("tui.allDone")));
    } else {
      bits.push(dim(t("tui.starting")));
    }
    bits.push(t("tui.pending", { n: waiting }));
    // 当前模型常驻状态栏：切换过模型之后，这一栏是「这一条场景到底用哪个模型」的唯一凭据。
    bits.push(dim(t("tui.model.status", { model: modelLabel(currentChoice) })));
    if (writtenBack > 0) bits.push(dim(t("tui.writtenBack", { n: writtenBack })));
    // 落点常驻状态栏：无落点是「正常但会丢数据」的状态，必须一直看得见。
    bits.push(
      dim(
        writeBackTarget
          ? t("tui.target", { path: displayPath(writeBackTarget) })
          : t("tui.noTarget"),
      ),
    );
    statusLine.setText(bits.join(dim("  ·  ")));
    // token 消耗放在**输入框下方**（与报告末行同一句话：`formatUsage`），含正在跑的场景的
    // 实时值，每轮 LLM 调用后随 updateStatus 一起刷新；端点没返回 usage 时它会自己说明。
    usageLine.setText(formatUsage(sessionUsage()));
    renderKanban();
    tui.requestRender();
  }

  function statusText(): string {
    const all = queue.all();
    if (all.length === 0) return t("tui.queueEmpty");
    const tagOf = (s: ScenarioState): string => {
      switch (s) {
        case "queued":
          return t("tui.state.queued");
        case "running":
          return t("tui.state.running");
        case "pass":
          return "PASS";
        case "fail":
          return "FAIL";
        default:
          return t("common.cancelled");
      }
    };
    return all
      .map(
        (i) =>
          `#${i.id} [${tagOf(i.state)}] ${i.name}（${originLabel(i.origin)}）`,
      )
      .join("\n");
  }

  /**
   * 单个场景的执行流程。
   *
   * 抽成具名函数（而不是内联在 `new ScenarioQueue(...)` 里）是因为 `/new` 会开一条**新的队列**：
   * 新旧队列共用同一个执行器，而执行器里对 `queue` 的引用每次都取当前那条队列。
   */
  const runScenario: ScenarioExecutor = async (item) => {
    const startedAt = item.startedAt ?? Date.now();
    append(
      title(
        t("tui.sceneStart", {
          name: item.name,
          appended: item.origin.kind === "added" ? t("tui.appended") : "",
        }),
      ),
    );
    let result: AgentRunResult;
    try {
      // 占位符在这里展开（而不是入队时）：追加场景与初始场景共用同一个时刻，
      // 与批处理模式的「同一次运行共用一个时刻」保持一致。
      result = await runAgent(expandVars(item.body, opts.now), {
        debug: opts.debug,
        vars: opts.vars,
        scenarioName: item.name,
        abortSignal: item.abort.signal,
        // 用「开跑那一刻」的选择：用户在场景执行期间 /model，只影响之后的场景，
        // 不会把跑到一半的会话换成另一个模型（那会让报告里的模型归属含糊不清）。
        model: { ...currentChoice },
        catalog,
        // 每轮 LLM 调用后刷新状态栏里的 token 累计：长流程跑到一半就能看出已经烧了多少。
        onUsage: (usage) => {
          runningUsage = usage;
          updateStatus();
        },
      });
    } catch (err2) {
      append(err(t("tui.sceneError", { name: item.name, msg: msgOf(err2) })));
      if (err2 instanceof ModelUnreachableError) {
        // 模型不通：这个场景如实记为失败（**不是**「已取消」——它是配置错误，
        // 混进「不计入退出码」的类别会让 CI 把「模型连不上」当成通过），
        // 同时把整条队列停掉。继续跑只会把一次「连不上」摊成 N 个「用例失败」，
        // 每个还要先开一次浏览器窗口再白等十几分钟。
        result = failedResult(item, err2, t("tui.model.expectation"));
        append(dim(t("err.modelUnreachableHint")));
        const stopped = queue.cancelAllWaiting(t("tui.model.stopNote"));
        if (stopped > 0) append(warn(t("tui.model.stopRun", { n: stopped })));
      } else {
        result = failedResult(item, err2);
      }
    }
    results.set(item.id, result);
    // 结算值已进 results，实时值必须清掉，否则这份消耗会在状态栏里被算两遍。
    runningUsage = null;
    const tag = statusTag(result.report.status);
    const line = t("tui.sceneEnd", {
      name: item.name,
      tag,
      n: result.report.assertions.length,
      duration: fmtDuration(Date.now() - startedAt),
    });
    append(result.report.status === "pass" ? ok(line) : result.report.status === "cancelled" ? warn(line) : err(line));
    // 这一条场景花了多少：状态栏只有会话累计，看不出单条成本。没发生过 LLM 调用
    // （排队中被取消、模型探活就失败）时不打这行——那只会是一串 0。
    if (result.usage.calls > 0) append(dim(formatUsage(result.usage)));
    return result.report.status;
  };

  /**
   * 当前这一批的运行队列。`/new` 会把它换成一条新队列（上一批先快照进 `batches`），
   * 因此是 `let`：所有引用点读到的都必须是最新那条。
   */
  let queue = new ScenarioQueue(runScenario, updateStatus);

  /** `/new` 归档下来的历史批次：退出报告与回放脚本要覆盖整个进程跑过的全部场景。 */
  const batches: SessionBatch[] = [];

  // ── `/` 命令联想：在行首输入 `/` 时弹出命令列表（/cancel 还会补全待办编号）──
  /** 构建补全项。描述随语种变化，所以切语种后要重建 provider。 */
  function buildCommandItems(): SlashCommand[] {
    return [
      { name: "status", description: t("tui.cmd.status") },
      {
        name: "run",
        argumentHint: "<文件或关键字>",
        description: t("tui.cmd.run"),
      },
      { name: "new", description: t("tui.cmd.new") },
      {
        name: "cancel",
        argumentHint: "<n>",
        description: t("tui.cmd.cancel"),
        getArgumentCompletions: (argumentPrefix: string) => {
          const items = queue.waiting().map((i) => ({
            value: String(i.id),
            label: `#${i.id} ${i.name}`,
          }));
          const filtered = items.filter((i) =>
            i.value.startsWith(argumentPrefix.trim()),
          );
          return filtered.length > 0 ? filtered : null;
        },
      },
      { name: "model", description: t("tui.cmd.model") },
      { name: "login", description: t("tui.cmd.login") },
      { name: "logout", description: t("tui.cmd.logout") },
      { name: "setting", description: t("tui.cmd.setting") },
      { name: "help", description: t("tui.cmd.help") },
      { name: "exit", description: t("tui.cmd.exit") },
    ];
  }

  /** 安装/刷新命令补全 provider（Editor 在行首输入 `/` 时自动调用它）。 */
  function installAutocomplete(): void {
    editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(buildCommandItems(), process.cwd()),
    );
  }

  installAutocomplete();

  /**
   * 把一段输入拆成场景：写回**当前落点** + 入队。
   *
   * 没有落点时（无参启动且还没 `/run` 过任何文件）不写任何文件——ADR-0002 决策七
   * 拒绝过的两件事仍在拒绝之列：不在用户工作目录里凭空造文件、不静默降级成别的行为。
   * 代价是这些场景关掉就没，所以这里与退出时都要把话说出来（见 ADR-0005 决策六）。
   */
  function addScenarios(text: string): void {
    const scenarios = scenariosFromInput(text);
    if (scenarios.length === 0) return;
    const target = writeBackTarget;
    const origin: ScenarioOrigin = target
      ? { kind: "added", path: target }
      : { kind: "added" };
    for (const sc of scenarios) {
      // 先写回再入队：落点文件是「用户想留下的用例」，本次运行只是它的一次执行。
      if (target) {
        try {
          appendScenarioToCaseFile(target, sc);
          writtenBack += 1;
          append(dim(t("tui.wroteBack", { name: sc.name })));
        } catch (err2) {
          append(err(t("tui.writeBackFail", { msg: msgOf(err2) })));
        }
      } else {
        unwritten += 1;
        append(warn(t("tui.notWrittenBack", { name: sc.name })));
      }
      const item = queue.add(sc.name, sc.body, origin);
      append(
        target
          ? t("tui.queued", {
              id: item.id,
              name: item.name,
              path: target,
            })
          : t("tui.queuedNoTarget", { id: item.id, name: item.name }),
      );
    }
    // 队列空闲时立刻开跑；正在跑则等当前场景结束后自动接上。
    queue.pump();
  }

  /**
   * 让模型从候选里挑一个用例文件。
   *
   * 只把**文件名**交给模型，不给文件内容：读文件、编号、入队、录制全归 pageqa，
   * 「让 AI 自行查找」的边界就划在这里（见 ADR-0005 决策三）。
   */
  async function pickCaseByModel(
    hint: string,
    candidates: string[],
  ): Promise<string | undefined> {
    const model = resolveModel(catalog, currentChoice);
    if (!model) return undefined;
    try {
      const reply = await catalog.models.completeSimple(
        model,
        {
          messages: [
            {
              role: "user",
              content: buildPickPrompt(hint, candidates),
              timestamp: Date.now(),
            },
          ],
        },
        { signal: AbortSignal.timeout(PICK_TIMEOUT_MS) },
      );
      const text = reply.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("");
      const picked = parsePick(text, candidates);
      if (picked) {
        append(dim(t("tui.run.picked", { path: displayPath(picked) })));
        return picked;
      }
      append(
        dim(
          t("tui.run.pickFailed", { msg: text.trim().slice(0, 40) || "-" }),
        ),
      );
      return undefined;
    } catch (err2) {
      // 模型不可用不该变成「加载不了用例文件」：说清楚，然后走手动选择。
      append(dim(t("tui.run.pickFailed", { msg: msgOf(err2) })));
      return undefined;
    }
  }

  /**
   * `/run <路径或关键字>`：把一个已有用例文件的场景加载进队列。
   *
   * 确定性优先（见 ADR-0005 决策三）：命中唯一就直接加载；命中多个先让模型从文件名
   * 列表里挑，挑不出来（或模型不可用）就弹选择器让用户自己挑。加载进来的场景来源是
   * 那个文件，**不会被写回**（它本来就在文件里），但落点会切到它。
   */
  async function loadCaseFromHint(hint: string): Promise<void> {
    if (!hint) {
      append(err(t("tui.run.usage")));
      return;
    }
    const found = resolveCaseFile(hint);
    if (found.kind === "none") {
      append(err(t("tui.run.notFound", { hint })));
      return;
    }
    let path: string | undefined;
    if (found.kind === "one") {
      path = found.path;
    } else {
      const listed = found.candidates.map((p) => displayPath(p)).join("、");
      append(
        dim(
          t("tui.run.ambiguous", {
            n: found.candidates.length,
            paths: listed,
          }) +
            (found.truncated > 0
              ? t("tui.run.overflow", { n: found.truncated })
              : ""),
        ),
      );
      path = await pickCaseByModel(hint, found.candidates);
      if (!path) {
        const pick = await openSelector(
          t("tui.run.pickTitle", { hint }),
          found.candidates.map((p) => ({ value: p, label: displayPath(p) })),
        );
        path = pick?.value;
      }
    }
    if (!path) return;
    const casePath = path;
    let scenarios;
    try {
      scenarios = loadCaseScenarios(casePath);
    } catch (err2) {
      append(
        err(
          t("tui.run.readFailed", {
            path: displayPath(casePath),
            msg: msgOf(err2),
          }),
        ),
      );
      return;
    }
    if (scenarios.length === 0) {
      append(warn(t("tui.run.empty", { path: displayPath(casePath) })));
      return;
    }
    // 落点跟着这次加载走：刚打开的文件就是用户此刻在编辑/补用例的那个（决策四）。
    writeBackTarget = casePath;
    for (const sc of scenarios) {
      const item = queue.add(sc.name, sc.body, {
        kind: "file",
        path: casePath,
      });
      append(
        dim(
          t("tui.queued", {
            id: item.id,
            name: item.name,
            path: displayPath(casePath),
          }),
        ),
      );
    }
    append(
      accent(
        t("tui.run.loaded", {
          n: scenarios.length,
          path: displayPath(casePath),
        }),
      ),
    );
    append(dim(t("tui.run.targetSwitched", { path: displayPath(casePath) })));
    updateStatus();
    // 队列空闲时立刻开跑；正在跑则等当前场景结束后自动接上（决策五：加载即追加到队尾）。
    queue.pump();
  }

  /**
   * `/new`：在当前进程里开一个新会话。
   *
   * 清掉的是**视口与运行队列**（用户说的「重新开始」），不是历史：上一批先快照进 `batches`，
   * 退出时的汇总报告与回放脚本照样覆盖它（见 `./batches.ts`）。
   *
   * 队列里还有在跑或待办的场景时**拒绝执行**：静默丢掉「已提交但没跑」的场景，等于抽掉
   * 「提交了就一定会跑」这条承诺（ADR-0002 决策五），所以如实报错并给出两条出路。
   */
  function newSession(): void {
    const running = queue.running();
    const waiting = queue.waiting().length;
    if (running || waiting > 0) {
      if (running) {
        append(err(t("tui.new.busyRunning", { name: running.name })));
      }
      if (waiting > 0) {
        append(err(t("tui.new.busyWaiting", { n: waiting })));
      }
      return;
    }
    const batch = snapshotBatch(queue.all(), results, originLabel);
    batches.push(batch);
    const pass = batch.members.filter(
      (m) => m.report.status === "pass",
    ).length;
    const fail = batch.members.filter(
      (m) => m.report.status === "fail",
    ).length;
    // 归档小结先算好再清视口：顺序反了就会把刚要写下的内容自己擦掉。
    const recap = batch.members.map(
      (m, i) =>
        `#${i + 1} [${statusTag(m.report.status)}] ${m.name}（${m.origin ?? ""}）`,
    );
    logLines.length = 0;
    document.setText("");
    results.clear();
    runningUsage = null;
    queue = new ScenarioQueue(runScenario, updateStatus);
    append(
      title(
        t("tui.new.banner", {
          n: batch.members.length,
          pass,
          fail,
          cancel: batch.members.length - pass - fail,
        }),
      ),
    );
    for (const line of recap) append(dim(line));
    append(dim(t("tui.new.reset")));
    // 落点不跟着换：静默丢掉落点会让后面敲下的用例不再写回文件（那是更难发现的意外）。
    if (writeBackTarget) {
      append(
        dim(t("tui.new.targetKept", { path: displayPath(writeBackTarget) })),
      );
    }
    updateStatus();
  }

  function runCommand(line: string): void {
    // 参数取整段剩余文本：`/run` 的参数是路径，切成两段会把带空格的路径切坏。
    const rest = line.slice(1);
    const gap = rest.search(/\s/);
    const cmd = gap < 0 ? rest : rest.slice(0, gap);
    const arg = gap < 0 ? "" : rest.slice(gap).trim();
    switch (cmd) {
      case "help":
        // 滚轮步长从常量注入，免得帮助里的数字与 `./keys.ts` 慢慢对不上。
        append(t("tui.help", { wheel: WHEEL_SCROLL_LINES }));
        break;
      case "setting":
        void openSettingPanel();
        break;
      case "toggle-language":
        // 未文档化的别名（不进 /help、不进补全）：新入口是 /setting，老习惯不被打断。
        switchLocale();
        break;
      case "status":
        append(statusText());
        break;
      case "run":
        void loadCaseFromHint(arg);
        break;
      case "new":
        newSession();
        break;
      case "cancel": {
        const id = Number(arg);
        const item = Number.isFinite(id) ? queue.cancel(id) : undefined;
        append(
          item
            ? t("tui.cancelOk", { id: item.id, name: item.name })
            : t("tui.cancelNotFound", { arg: arg ?? "" }),
        );
        break;
      }
      case "model":
        void openModelSelector();
        break;
      case "login":
        void openLoginSelector();
        break;
      case "logout":
        void openLogoutSelector();
        break;
      case "exit":
      case "quit":
        requestShutdown(t("tui.exitReason"));
        break;
      default:
        append(t("tui.unknownCmd", { cmd: cmd ?? "" }));
    }
  }

  /**
   * 请求收工。
   *
   * 第二次请求（`Ctrl+C` 按键与 `SIGINT` 信号走的是同一条路）不再等队列停下：用户表达的是
   * 「立刻收尾」。但**仍然要走完收尾**——还原终端、打印汇总报告。这正是「不要直接把终端关闭，
   * 只要退出就行」的含义：进程必须经由正常路径退出，而不是被信号当场杀掉（被杀的进程不会
   * 还原终端，会把它留在 alt 屏 + 隐藏光标的状态里，看起来就像终端被关掉了）。
   */
  function requestShutdown(reason: string): void {
    if (!shuttingDown) {
      void shutdown(reason);
      return;
    }
    finishNow = true;
  }

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    append(warn(t("tui.shutdown", { reason })));
    // 收工也要了结「非场景」的等待：登录流程会一直挂着等授权/等输入，
    // 不中止的话下面的等队列循环会白等到超时。
    loginController?.abort();
    rejectAsk(cancelledError());
    if (queue.running()) {
      append(dim(t("tui.abortingCurrent")));
      queue.abortRunning();
    }
    const cancelled = queue.cancelAllWaiting();
    if (cancelled > 0) append(dim(t("tui.cancelledWaiting", { n: cancelled })));
    updateStatus();

    // 等真正停下来再拆界面：否则会有一轮日志写进已销毁的视口。
    // 兜底：中止信号若没能让执行方返回（端点不响应 abort 等），最多等 30s 就强行收尾，
    // 免得界面永远卡在「正在收尾」。
    const deadline = Date.now() + 30_000;
    while (queue.running() || queue.waiting().length > 0) {
      // 收尾期间又按了 Ctrl+C：别再等队列，立刻收尾（报告照打，仍然不是硬杀）。
      if (finishNow) {
        append(warn(t("tui.shutdownNow")));
        break;
      }
      if (Date.now() > deadline) {
        append(err(t("tui.abortTimeout")));
        break;
      }
      await sleep(100);
    }

    clearInterval(ticker);
    teardown = true;
    tui.stop();
    setSink(null);
    finish();
  }

  editor.onSubmit = (raw: string) => {
    const text = raw.trim();
    // 提问优先：登录流程在等用户输入时，回车是「回答提问」，不是「提交新场景」。
    if (pendingAsk) {
      editor.setText("");
      if (text) settleAsk(text);
      return;
    }
    if (!text) return;
    editor.addToHistory(text);
    editor.setText("");
    // 提交即「这段我看完了」：把视口拉回末尾恢复跟随。否则用户上滚读完一段再敲下一条时，
    // 新场景的日志会在看不见的地方刷过去（而「正在跑」的唯一现场就是这片日志）。
    transcript.scrollToEnd();
    if (text.startsWith("/")) runCommand(text);
    else addScenarios(text);
  };

  // Esc / Ctrl+C 走全局监听：它们在编辑器之前被处理，
  // 因为「中止正在跑的东西」不该排队等编辑器先把按键消化一遍。
  tui.addInputListener((data) => {
    // ↑/↓：输入框为空时归日志视口。一部分终端把滚轮翻译成 ↑/↓ 送进来（VS Code 的全屏缓冲
    // 就是这样），不接管的话滚轮会去翻输入框的历史、日志反而滚不动（见 ./keys.ts）。
    // 只吃「按一下」，不吃 Kitty 协议的释放事件——否则一次滚轮会在支持该协议的终端上滚两倍。
    if (
      !isKeyRelease(data) &&
      (matchesKey(data, "up") || matchesKey(data, "down")) &&
      arrowKeysBelongToLog({
        text: editor.getText(),
        overlayOpen: tui.hasOverlay(),
        autocompleteShowing: editor.isShowingAutocomplete(),
      })
    ) {
      transcript.scrollBy(
        matchesKey(data, "up") ? -WHEEL_SCROLL_LINES : WHEEL_SCROLL_LINES,
      );
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+c")) {
      requestShutdown("Ctrl+C");
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      // 提问中的 Esc = 取消这次提问（登录流程会按「已取消」收尾）。
      if (pendingAsk) {
        rejectAsk(cancelledError());
        return { consume: true };
      }
      // 浮层打开时把 Esc 留给列表自己处理（SelectList 的 onCancel）。
      if (tui.hasOverlay()) return undefined;
      // 其余时候只在有场景在跑时接管，否则留给编辑器（它用 Esc 关自动补全）。
      if (queue.running()) {
        const item = queue.abortRunning();
        append(warn(t("tui.abortScene", { name: item?.name ?? "" })));
        return { consume: true };
      }
    }
    return undefined;
  });

  const ticker = setInterval(() => updateStatus(), 1000);

  // ── 启动 ──
  // 无参启动时没有种子场景：队列为空、落点为空，等用户输入或 `/run`（ADR-0005 决策一）。
  const sourcePath = opts.sourcePath;
  const initial = sourcePath ? splitScenarios(input) : [];
  if (sourcePath) {
    for (const sc of initial) {
      queue.add(sc.name, sc.body, { kind: "file", path: sourcePath });
    }
  }
  info(
    "[pageqa] " +
      t("tui.interactiveStart", { n: initial.length }) +
      (opts.debug ? t("tui.debugOn") : ""),
  );
  info(
    "[pageqa] " +
      (sourcePath
        ? t("tui.sourceFile", { path: sourcePath })
        : t("tui.noSource")),
  );
  append(dim(t("tui.enterHint")));
  // 配置里的默认模型可能已不可用（provider 未登录/模型下线）：先校正，避免第一条场景
  // 就以「模型不存在」失败。校正结果会写到视口，用户的第一次交互就能看到。
  await resolveInitialChoice();
  info(
    "[pageqa] " +
      t("tui.model.status", { model: modelLabel(currentChoice) }),
  );
  updateStatus();

  tui.start();
  // 启动后终端尺寸才就绪，立刻渲染一次看板带（窄屏则保持空白、整片日志）。
  updateStatus();

  // Ctrl+C 有两条路径到我们这儿：raw 模式下它是 `\x03` 这个字节（上面的输入监听），
  // 而在 raw 模式没生效的时刻——启动早期、以及收尾还原终端之后——它会变成 SIGINT 信号，
  // 默认行为是**当场杀掉进程**：不还原终端、不打汇总报告，终端被留在 alt 屏 + 光标隐藏的
  // 状态里（看起来就像「终端被关掉了」，还得手动关掉标签页）。因此信号也走同一条收工路径。
  process.on("SIGINT", () => requestShutdown(t("tui.signalReason")));
  // 兜底：万一有异常把进程带走了，也别把终端留在半途（stop() 是同步的，且可重复调用）。
  process.on("exit", () => {
    if (!teardown) tui.stop();
  });

  queue.pump();
  await finished;

  // ── 汇总（回到批处理口径：stdout 只放报告，退出码交 CI）──
  // 覆盖**整个进程**跑过的场景：`/new` 归档下来的批次在前，当前批次在后（见 ./batches.ts）。
  const total = combineBatches([
    ...batches,
    snapshotBatch(queue.all(), results, originLabel),
  ]);
  const members = total.members;
  const summary = summarizeSuite(members);
  summary.durationMs = Date.now() - interactiveStartedAt;
  if (opts.scriptPath) summary.script = opts.scriptPath;
  const text = renderSuiteText(summary, members, total.names);
  const recordings = total.recordings;

  return {
    report: summary,
    text,
    json: JSON.stringify(summary, null, 2),
    transcript: summary.transcript,
    usage: summary.usage ?? emptyUsage(),
    recordings,
    writtenBack,
    unwritten,
  };
}
