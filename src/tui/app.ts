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
 * - `Ctrl+C` 收工：中止当前 + 取消全部待办，回到批处理口径输出汇总报告。
 *
 * 模型切换与登录（见 ADR-0004）：
 * - `/model` 打开模型选择器：`Enter` 本次会话生效、`Ctrl+S` 同时设为启动默认（写回 config.json）；
 * - `/login` 登录一个内置 provider（API Key 或订阅 OAuth），凭据写入 `~/.pageqa/auth.json`；
 * - `/logout` 移除某个 provider 的本地凭据。
 * 选择器与登录提问都复用底部输入区（浮层负责选项，输入框负责文本/密钥），
 * 因此「跑场景」与「改配置」用的是同一套输入路径，不需要第二套按键。
 */
import { runAgent, splitScenarios, type AgentRunResult } from "../agent.js";
import { info, setSink } from "../log.js";
import {
  emptyUsage,
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
  type ScenarioState,
} from "./queue.js";
import { accent, dim, editorTheme, err, ok, title, warn } from "./theme.js";
import { appendScenarioToCaseFile, scenariosFromInput } from "./writeback.js";
import { getLocale, setLocale, t } from "../i18n.js";
import { CONFIG_PATH, saveLocale, saveModelSelection } from "../config.js";
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
  /** 源用例文件路径。交互模式要求必须有它——追加场景要写回这里。 */
  sourcePath: string;
  /** 源用例文件原文（含 `${...}` 占位符）。 */
  sourceText: string;
  /** 本次运行展开占位符的取值。 */
  vars: RunVarValue[];
  /**
   * 展开 `${...}` 占位符用的时刻。
   * 初始场景与全部追加场景**共用同一个**：回放脚本靠「具体值 → 占位符」反查还原，
   * 若各场景各用各的时刻，同一份脚本里一个占位符会对应多个取值（见 ADR-0002 决策六）。
   */
  now: Date;
  debug: boolean;
  /** 将要写入的回放脚本路径（仅用于在汇总报告里标注）。 */
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
  /** 写回源用例文件的场景数。 */
  writtenBack: number;
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
 * 给「没有结果的场景」造一份最小报告。
 * 典型是排队中被 `/cancel`、或 Ctrl+C 时还没轮到的场景——如实说「未运行」，
 * 而不是伪装成通过（那会让汇总报告说谎）。
 */
function notRunReport(item: QueuedScenario): TestReport {
  return {
    status: "cancelled",
    cancelReason:
      (item.cancelNote ?? t("tui.notExecuted")) + t("tui.notRunSuffix"),
    assertions: [],
    transcript: "",
    steps: numberSteps(item.body).steps,
    usage: emptyUsage(),
  };
}

/** 执行抛错时的报告：记成失败，绝不当作「未执行」。 */
function failedResult(item: QueuedScenario, cause: unknown): AgentRunResult {
  const message = msgOf(cause);
  const report: TestReport = {
    status: "fail",
    assertions: [
      {
        expectation: t("tui.scenarioErrorExpectation"),
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
  const {
    TuiAltScreen,
    ProcessTerminal,
    VStack,
    ScrollView,
    Text,
    Editor,
    SelectList,
    CombinedAutocompleteProvider,
    matchesKey,
  } = await import("@earendil-works/pi-tui");

  /**
   * 浮层根组件：负责「标题 + 列表 + 提示」的布局，并把按键转交给内部的 SelectList。
   *
   * 必须自己实现 `handleInput`：pi-tui 只把按键交给**聚焦组件**，而 VStack/Container
   * 只做布局、不向子组件转发输入，不实现的话方向键/回车会全部石沉大海。
   */
  // 动态 import 拿到的 `SelectList` 是值而非类型，类里要引用实例类型只能这样推导。
  type SelectListInstance = InstanceType<typeof SelectList>;

  class SelectorOverlay extends VStack {
    constructor(
      private readonly list: SelectListInstance,
      children: StackChild[],
    ) {
      super(children);
    }

    handleInput(data: string): void {
      this.list.handleInput(data);
    }
  }

  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, true, undefined, { mouse: true });

  // ── 视口：上方滚动日志 + 底部固定输入区 ──
  const logLines: string[] = [];
  const document = new Text("");
  const transcript = new ScrollView(document, {
    follow: "end",
    primary: true,
    scrollbar: "auto",
  });
  const statusLine = new Text("", 1);
  const hintLine = new Text(dim(t("tui.hint")), 1);
  const editor = new Editor(tui, editorTheme, { paddingX: 1 });

  const dock = new VStack([
    { component: statusLine, shrink: 1, minSize: 0 },
    { component: editor, shrink: 1, minSize: 3 },
    { component: hintLine, shrink: 1, minSize: 0 },
  ]);
  tui.setLayoutRoot(
    new VStack([
      { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
    ]),
  );
  tui.setFocus(editor);

  // ── 状态 ──
  const results = new Map<number, AgentRunResult>();
  let writtenBack = 0;
  let shuttingDown = false;
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
    opts: { allowSaveDefault?: boolean } = {},
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
              opts.allowSaveDefault ? t("tui.model.hint") : t("tui.select.hint"),
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
    bits.push(dim(opts.sourcePath));
    statusLine.setText(bits.join(dim("  ·  ")));
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
          `#${i.id} [${tagOf(i.state)}] ${i.name}` +
          (i.added ? t("tui.appended") : ""),
      )
      .join("\n");
  }

  const queue = new ScenarioQueue(async (item) => {
    const startedAt = item.startedAt ?? Date.now();
    append(
      title(
        t("tui.sceneStart", {
          name: item.name,
          appended: item.added ? t("tui.appended") : "",
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
      });
    } catch (err2) {
      result = failedResult(item, err2);
      append(err(t("tui.sceneError", { name: item.name, msg: msgOf(err2) })));
    }
    results.set(item.id, result);
    const tag = statusTag(result.report.status);
    const line = t("tui.sceneEnd", {
      name: item.name,
      tag,
      n: result.report.assertions.length,
      duration: fmtDuration(Date.now() - startedAt),
    });
    append(result.report.status === "pass" ? ok(line) : result.report.status === "cancelled" ? warn(line) : err(line));
    return result.report.status;
  }, updateStatus);

  // ── `/` 命令联想：在行首输入 `/` 时弹出命令列表（/cancel 还会补全待办编号）──
  /** 构建补全项。描述随语种变化，所以切语种后要重建 provider。 */
  function buildCommandItems(): SlashCommand[] {
    return [
      { name: "status", description: t("tui.cmd.status") },
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
      { name: "toggle-language", description: t("tui.cmd.toggleLanguage") },
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

  /** 把一段输入拆成场景：写回源用例文件 + 入队。 */
  function addScenarios(text: string): void {
    const scenarios = scenariosFromInput(text);
    if (scenarios.length === 0) return;
    for (const sc of scenarios) {
      // 先写回再入队：源文件是「用户想留下的用例」，本次运行只是它的一次执行。
      try {
        appendScenarioToCaseFile(opts.sourcePath, sc);
        writtenBack += 1;
        append(dim(t("tui.wroteBack", { name: sc.name })));
      } catch (err2) {
        append(err(t("tui.writeBackFail", { msg: msgOf(err2) })));
      }
      const item = queue.add(sc.name, sc.body, true);
      append(
        t("tui.queued", {
          id: item.id,
          name: item.name,
          path: opts.sourcePath,
        }),
      );
    }
    // 队列空闲时立刻开跑；正在跑则等当前场景结束后自动接上。
    queue.pump();
  }

  function runCommand(line: string): void {
    const [cmd, arg] = line.slice(1).split(/\s+/, 2);
    switch (cmd) {
      case "help":
        append(t("tui.help"));
        break;
      case "toggle-language": {
        // 切语种并把结果写回配置文件：下次启动直接生效。
        const next = getLocale() === "en" ? "zh" : "en";
        setLocale(next);
        try {
          saveLocale(next);
          append(t("tui.languageSwitched", { locale: next }));
        } catch (err2) {
          append(
            t("tui.languageSwitchFailed", { locale: next, msg: msgOf(err2) }),
          );
        }
        // 底部提示行与命令补全描述都是构建时写死的文本，这里手动刷新一下。
        hintLine.setText(dim(t("tui.hint")));
        installAutocomplete();
        updateStatus();
        break;
      }
      case "status":
        append(statusText());
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
        void shutdown(t("tui.exitReason"));
        break;
      default:
        append(t("tui.unknownCmd", { cmd: cmd ?? "" }));
    }
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
    if (text.startsWith("/")) runCommand(text);
    else addScenarios(text);
  };

  // Esc / Ctrl+C 走全局监听：它们在编辑器之前被处理，
  // 因为「中止正在跑的东西」不该排队等编辑器先把按键消化一遍。
  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      void shutdown("Ctrl+C");
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
  const initial = splitScenarios(input);
  for (const sc of initial) queue.add(sc.name, sc.body, false);
  info(
    "[pageqa] " +
      t("tui.interactiveStart", { n: initial.length }) +
      (opts.debug ? t("tui.debugOn") : ""),
  );
  info("[pageqa] " + t("tui.sourceFile", { path: opts.sourcePath }));
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
  queue.pump();
  await finished;

  // ── 汇总（回到批处理口径：stdout 只放报告，退出码交 CI）──
  const all = queue.all();
  const members: SuiteMember[] = all.map((item) => {
    const r = results.get(item.id);
    return r
      ? { name: item.name, report: r.report, usage: r.usage }
      : { name: item.name, report: notRunReport(item), usage: emptyUsage() };
  });
  const summary = summarizeSuite(members);
  if (opts.scriptPath) summary.script = opts.scriptPath;
  const text = renderSuiteText(
    summary,
    members,
    all.map((i) => ({ name: i.name })),
  );
  const recordings = all
    .filter((i) => i.state !== "cancelled")
    .flatMap((i) => results.get(i.id)?.recordings ?? []);

  return {
    report: summary,
    text,
    json: JSON.stringify(summary, null, 2),
    transcript: summary.transcript,
    usage: summary.usage ?? emptyUsage(),
    recordings,
    writtenBack,
  };
}
