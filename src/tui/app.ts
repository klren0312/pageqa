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
import {
  ScenarioQueue,
  type QueuedScenario,
  type ScenarioState,
} from "./queue.js";
import { accent, dim, editorTheme, err, ok, title, warn } from "./theme.js";
import { appendScenarioToCaseFile, scenariosFromInput } from "./writeback.js";

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

const HELP_TEXT = [
  "命令：",
  "  /status        查看运行队列",
  "  /cancel <n>    取消一个尚未开始的待办（n 为队列编号）",
  "  /help          显示本帮助",
  "  /exit          收工（等同于 Ctrl+C）",
  "键位：",
  "  Enter          提交输入（写了 `## 标题` 就是场景名，否则取首行摘要）",
  "  Shift+Enter    换行（写多场景用例时用）",
  "  Esc            中止当前场景，队列继续跑下一个",
  "  Ctrl+C         收工：中止当前 + 取消全部待办，然后输出汇总报告",
].join("\n");

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
 * 给「没有结果的场景」造一份最小报告。
 * 典型是排队中被 `/cancel`、或 Ctrl+C 时还没轮到的场景——如实说「未运行」，
 * 而不是伪装成通过（那会让汇总报告说谎）。
 */
function notRunReport(item: QueuedScenario): TestReport {
  return {
    status: "cancelled",
    cancelReason: `${item.cancelNote ?? "未执行"}（该场景未运行）`,
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
        expectation: "场景正常执行完毕（未因错误中断）",
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
    matchesKey,
  } = await import("@earendil-works/pi-tui");

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
  const hintLine = new Text(
    dim(
      "Enter 提交 · Shift+Enter 换行 · Esc 中止当前场景 · Ctrl+C 收工 · /help 查看命令",
    ),
    1,
  );
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

  function updateStatus(): void {
    const all = queue.all();
    const running = queue.running();
    const waiting = queue.waiting().length;
    const settled = all.filter(
      (i) => i.state !== "queued" && i.state !== "running",
    ).length;
    const bits: string[] = [title("pageqa 交互模式")];
    if (running) {
      bits.push(
        `${accent(running.name)} 运行中 ${settled + 1}/${all.length}` +
          `（${fmtDuration(Date.now() - (running.startedAt ?? Date.now()))}）`,
      );
    } else if (shuttingDown) {
      bits.push(dim("正在收尾…"));
    } else if (all.length > 0 && settled === all.length) {
      bits.push(ok("已全部结束") + dim("，可继续追加场景"));
    } else {
      bits.push(dim("启动中…"));
    }
    bits.push(`待办 ${waiting}`);
    if (writtenBack > 0) bits.push(dim(`已写回 ${writtenBack}`));
    bits.push(dim(opts.sourcePath));
    statusLine.setText(bits.join(dim("  ·  ")));
    tui.requestRender();
  }

  function statusText(): string {
    const all = queue.all();
    if (all.length === 0) return "运行队列为空";
    const tagOf = (s: ScenarioState): string => {
      switch (s) {
        case "queued":
          return "待办";
        case "running":
          return "运行中";
        case "pass":
          return "PASS";
        case "fail":
          return "FAIL";
        default:
          return "已取消";
      }
    };
    return all
      .map(
        (i) =>
          `#${i.id} [${tagOf(i.state)}] ${i.name}` +
          (i.added ? "（追加）" : ""),
      )
      .join("\n");
  }

  const queue = new ScenarioQueue(async (item) => {
    const startedAt = item.startedAt ?? Date.now();
    append(title(`场景「${item.name}」${item.added ? "（追加）" : ""}`));
    let result: AgentRunResult;
    try {
      // 占位符在这里展开（而不是入队时）：追加场景与初始场景共用同一个时刻，
      // 与批处理模式的「同一次运行共用一个时刻」保持一致。
      result = await runAgent(expandVars(item.body, opts.now), {
        debug: opts.debug,
        vars: opts.vars,
        scenarioName: item.name,
        abortSignal: item.abort.signal,
      });
    } catch (err2) {
      result = failedResult(item, err2);
      append(err(`场景「${item.name}」执行出错：${msgOf(err2)}`));
    }
    results.set(item.id, result);
    const tag = statusTag(result.report.status);
    const line =
      `场景「${item.name}」结束：${tag}` +
      `（断言 ${result.report.assertions.length} 条，耗时 ${fmtDuration(Date.now() - startedAt)}）`;
    append(result.report.status === "pass" ? ok(line) : result.report.status === "cancelled" ? warn(line) : err(line));
    return result.report.status;
  }, updateStatus);

  /** 把一段输入拆成场景：写回源用例文件 + 入队。 */
  function addScenarios(text: string): void {
    const scenarios = scenariosFromInput(text);
    if (scenarios.length === 0) return;
    for (const sc of scenarios) {
      // 先写回再入队：源文件是「用户想留下的用例」，本次运行只是它的一次执行。
      try {
        appendScenarioToCaseFile(opts.sourcePath, sc);
        writtenBack += 1;
        append(dim(`已写回源用例文件：## ${sc.name}`));
      } catch (err2) {
        append(err(`写回源用例文件失败（该场景仍会执行）：${msgOf(err2)}`));
      }
      const item = queue.add(sc.name, sc.body, true);
      append(`已加入运行队列 #${item.id}：${item.name}（用例已写回 ${opts.sourcePath}）`);
    }
    // 队列空闲时立刻开跑；正在跑则等当前场景结束后自动接上。
    queue.pump();
  }

  function runCommand(line: string): void {
    const [cmd, arg] = line.slice(1).split(/\s+/, 2);
    switch (cmd) {
      case "help":
        append(HELP_TEXT);
        break;
      case "status":
        append(statusText());
        break;
      case "cancel": {
        const id = Number(arg);
        const item = Number.isFinite(id) ? queue.cancel(id) : undefined;
        append(
          item
            ? `已取消待办 #${item.id}「${item.name}」`
            : `没有找到可取消的待办 #${arg ?? ""}（已开始执行的场景请用 Esc 中止）`,
        );
        break;
      }
      case "exit":
      case "quit":
        void shutdown("用户输入 /exit");
        break;
      default:
        append(`未知命令：/${cmd ?? ""}（可用：/help /status /cancel <n> /exit）`);
    }
  }

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    append(warn(`收工：${reason}`));
    if (queue.running()) {
      append(dim("正在中止当前场景…"));
      queue.abortRunning();
    }
    const cancelled = queue.cancelAllWaiting();
    if (cancelled > 0) append(dim(`已取消 ${cancelled} 个未开始的待办`));
    updateStatus();

    // 等真正停下来再拆界面：否则会有一轮日志写进已销毁的视口。
    // 兜底：中止信号若没能让执行方返回（端点不响应 abort 等），最多等 30s 就强行收尾，
    // 免得界面永远卡在「正在收尾」。
    const deadline = Date.now() + 30_000;
    while (queue.running() || queue.waiting().length > 0) {
      if (Date.now() > deadline) {
        append(err("中止超时，强制收尾（该场景的报告可能缺失）"));
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
    // Esc 只在有场景在跑时接管，其余时候留给编辑器（它用 Esc 关自动补全）。
    if (matchesKey(data, "escape") && queue.running()) {
      const item = queue.abortRunning();
      append(warn(`已请求中止场景「${item?.name ?? ""}」，剩余步骤不再执行`));
      return { consume: true };
    }
    return undefined;
  });

  const ticker = setInterval(() => updateStatus(), 1000);

  // ── 启动 ──
  const initial = splitScenarios(input);
  for (const sc of initial) queue.add(sc.name, sc.body, false);
  info(
    `[pageqa] 交互模式：${initial.length} 个初始场景已入队` +
      `${opts.debug ? "，debug=on" : ""}`,
  );
  info(`[pageqa] 源用例文件：${opts.sourcePath}（追加场景会写回这里）`);
  append(
    dim(
      "输入一段自然语言用例并回车即可追加场景（会写回源用例文件）；/help 查看命令。",
    ),
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
