import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ModelUnreachableError,
  probeModelReachable,
  splitScenarios,
  type AgentRunResult,
  type Scenario,
} from "./agent.js";
import { closeSession, ensureBskReady, ensureSession } from "./bsk/tools.js";
import { debugLog, info } from "./log.js";
import { getLocale, t } from "./i18n.js";
import {
  loadReplayScript,
  REPLAY_FORMAT,
  REPLAY_VERSION,
  type ReplayScript,
  type ScenarioRecording,
} from "./replay.js";
import {
  emptyUsage,
  numberSteps,
  renderSuiteText,
  renderText,
  summarizeSuite,
  type ScenarioFailureReason,
  type SuiteMember,
  type TestReport,
  type TokenUsage,
} from "./report.js";

/**
 * 套件的父进程编排：父进程按运行队列**串行** fork 子进程，一个场景一个进程。
 * 见 ADR-0013。
 *
 * 为什么不再让场景跑在同一个进程里：进程内拦不住原生崩溃（浏览器 / bsk daemon 把
 * 进程带崩、OOM 被系统杀掉），一次崩溃会带走整个队列，连已经跑完只差汇总的结果一起没。
 * 之所以仍然**串行**：bsk 的「一次只有一条命令在飞」是**模块级** Promise 链，只在本进程
 * 内有效，跨进程并行会直接击穿这条不变量；且每个场景要独占一个浏览器窗口。
 *
 * 父进程只做三件事：建 session、fork、收结果。子进程就是普通的
 * `pageqa --only <k> --json <用例>`（见 ADR-0013 决策二），这里不发明第二套协议。
 */

/** 子进程日志的落点（默认写父进程 stderr）。交互模式注入它把日志接进界面视口。 */
export type ChildLogSink = (line: string) => void;

/**
 * 子进程入口：**与 suite.js 同目录的 index.js**，也就是 CLI 自己。
 *
 * 刻意**不用 `process.argv[1]`**：它只在「这个进程本身就是 CLI」时才等于入口脚本。
 * 在被别的程序调用时（测试进程、将来的库用法）它是调用方的文件，拿它当入口等于
 * 把调用方再跑一遍——而调用方如果又会 fork，就是一个自我复制的死循环。
 * 2026-09-28 实测踩到过：测试进程里 `argv[1]` 是 `tests/smoke.test.mjs`，
 * 于是每个子进程都重跑一遍那份用例、再各开一层子进程，浏览器窗口被成串开出来。
 *
 * 用模块自身的相对位置解析，谁调用都不会跑偏；入口不存在就当场报错，
 * 而不是让 node 去报一个「找不到模块」然后被当成子进程日志转发出去。
 */
export function resolveCliEntry(): string {
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  if (!existsSync(entry)) {
    throw new Error(t("err.childEntryMissing", { path: entry }));
  }
  return entry;
}

export interface ForkSuiteOptions {
  /** 已展开占位符的用例文本，用于切分与命名（子进程会按源文件自己再展开一次）。 */
  script: string;
  /** 传给子进程的输入位：用例文件路径；内联文本时就是原文本身。 */
  input: string;
  /** 源用例文件路径；内联文本为 null（合并脚本时不写 source 与 hash）。 */
  sourcePath: string | null;
  debug?: boolean;
  /** 用户显式给出的 session；未给时由父进程为每个场景各建一个并负责收尾。 */
  session?: string;
  /** 场景级执行时长上限（毫秒）；`0` 表示不限。 */
  timeoutMs: number;
  /** 是否要父进程合并出一份回放脚本（`--no-side-outputs` 且未显式 --emit-script 时为假）。 */
  wantScript: boolean;
  /** 要写进报告 `script` 字段的路径（只有显式 --emit-script 才给）。 */
  reportedScriptPath?: string;
  /** 子进程入口，默认取当前 CLI 的入口脚本；测试可注入。 */
  entry?: string;
  /** 子进程日志落点，默认写父进程 stderr。 */
  onChildLog?: ChildLogSink;
  /** 打开子进程的用量流水（`--usage-stream`）；父进程用 `onChildUsage` 决定往哪转。 */
  usageStream?: boolean;
  onChildUsage?: (usage: TokenUsage) => void;
  /** 同时跑几个场景的上限（默认 1，逐个跑）。超过 `MAX_CONCURRENCY` 由 CLI 先拦下。 */
  concurrency?: number;
}

/**
 * 并发上限的硬顶：`--concurrency` 超过它直接报错（**不静默截断**）。
 *
 * 并发的代价是同时开着 N 个浏览器窗口（一个 session 一个 Agent Window），
 * 数字失控时先把人机两边都拖垮；而静默截断会让人以为「我说 16 怎么只跑了 8」。
 */
export const MAX_CONCURRENCY = 8;

/**
 * 带并发上限地跑一批任务，结果按**原始下标**放回数组；被跳过的位置留 `undefined`。
 *
 * 顺序是刻意的：并行只该改变「什么时候跑」，不该改变「结果按什么顺序排」——
 * 报告里的场景顺序、合并出来的回放脚本顺序都依赖它。
 *
 * `shouldStop` 用来「不再派发新任务」（模型或环境级故障时）：**已经在跑的会跑完**，
 * 它们的结论照收；没派发的留空，由调用方记成「已取消」。
 *
 * 抽成纯函数是因为并行唯一的新增逻辑就是它，也最容易写错（提前派发、漏派发、
 * 把没跑过的当成跑过了）。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  shouldStop?: () => boolean,
): Promise<(R | undefined)[]> {
  // 显式 fill：`new Array(n)` 是**稀疏**数组，`.map/.forEach` 会跳过空洞，
  // 调用方拿到它多半会踩坑（"为什么我的第 3 个元素没被处理"）。
  const results: (R | undefined)[] = new Array<R | undefined>(items.length).fill(
    undefined,
  );
  let next = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        if (shouldStop?.()) return;
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

export interface ForkSuiteOutcome {
  report: TestReport;
  text: string;
  json: string;
  transcript: string;
  usage: TokenUsage;
  /** 父进程合并出的回放脚本；没有录制或不要脚本时为 null（由调用方落盘）。 */
  script: ReplayScript | null;
  /**
   * 套件**中途**模型不可达：调用方据此补一条干净报错。
   *
   * 第一个场景就不可达时不会走到这里——那种情况与「一条都没跑」等价，orchestrator
   * 直接抛 `ModelUnreachableError`，沿用既有的干净报错路径（不给 stdout 塞假报告）。
   */
  modelUnreachable?: { message: string; done: number };
  /** 已经真正跑过（有结论）的场景数。 */
  done: number;
}

/** 子进程跑完一次的结果。 */
export interface ChildRunResult {
  /** 子进程 stdout 上那份套件形态的报告；没解析出来就是异常终止。 */
  report?: TestReport;
  /** 子进程写出的临时回放脚本。 */
  script?: ReplayScript;
  /** 是我们自己把它停掉的：按上限掐的，还是用户按 Esc 中止的。 */
  stopped?: "timeout" | "abort";
  /** 退出方式的描述（退出码 / 信号），写进报告的人读摘要与日志。 */
  how: string;
  /** 最近一次上报的用量：用户中止时也要能带回已经烧掉的那部分。 */
  usage?: TokenUsage;
}

/** 一次异常收尾的处置结论。 */
interface FailureClass {
  kind: "model" | "infrastructure" | null;
  detail: string;
  error?: Error;
}

/**
 * 批量运行多个场景并汇总报告：每个场景一个子进程，父进程串行 fork。
 *
 * 与历史行为的三处刻意对齐（免得「换成子进程」顺手改了语义）：
 * - 第一个场景就环境不可用（模型/bsk）时**直接抛出**，由 CLI 打干净报错、不给 stdout
 *   塞一份伪装成结果的报告——与今天逐场景运行时的处置逐字一致；
 * - 套件中途坏掉时，坏的那个记失败、剩余记「已取消」，并给出已完成场景的报告；
 * - 退出码仍然只看「有没有真正失败」，已取消不计入（见 ADR-0002 决策五）。
 */
export async function runSuiteInChildren(
  opts: ForkSuiteOptions,
): Promise<ForkSuiteOutcome> {
  const entry = opts.entry ?? resolveCliEntry();
  const emitLog = opts.onChildLog ?? ((line: string) => process.stderr.write(line + "\n"));

  const scenarios = splitScenarios(opts.script);
  const startedAt = Date.now();
  // 并发是**上限**：不给就是 1（逐个跑），给了也不超过 MAX_CONCURRENCY。
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 1, MAX_CONCURRENCY));
  const parallel = concurrency > 1 && scenarios.length > 1;
  // 并发与共享 session 是**语义冲突**，不是「不支持」：见 ConcurrencySessionConflictError。
  if (isConcurrencySessionConflict(concurrency, scenarios.length, opts.session)) {
    throw new ConcurrencySessionConflictError(concurrency);
  }
  info(
    t("log.suiteStart", {
      n: scenarios.length,
      names: scenarios.map((s) => s.name).join(" / "),
    }),
  );
  if (parallel) info(t("log.suiteParallel", { n: concurrency }));

  const reports = new Map<number, TestReport>();
  const failures = new Map<
    number,
    { reason: ScenarioFailureReason; detail: string }
  >();
  const childScripts = new Map<number, ReplayScript>();
  /**
   * 模型/环境级故障的判定：它不只影响一个场景，而是「继续派发没有意义」。
   * 记下来、停止派发后续场景，最后在「一条都没跑成」时用它走既有的干净报错路径。
   *
   * 刻意**不在 worker 里直接抛**：并行时抛出去会带着还在跑的子进程逃出调度器
   * （`Promise.all` 一 reject，剩下的人就没人等了），CLI 一退出它们立刻变成孤儿。
   */
  let fatal:
    | { kind: "model" | "infrastructure"; error: Error; detail: string }
    | undefined;
  let stopped = false;

  const tmpDir = opts.wantScript
    ? mkdtempSync(join(tmpdir(), "pageqa-suite-"))
    : null;

  try {
    /** 跑一个场景（下标 i）。并发上限由外面的调度器管，这里只管这一个怎么跑。 */
    const runOne = async (i: number): Promise<void> => {
      const sc = scenarios[i];
      info(
        t("log.suiteScenario", {
          i: i + 1,
          n: scenarios.length,
          name: sc.name,
        }),
      );

      // ── 父进程持 session 的生命周期（ADR-0013 决策四）──
      // 让子进程上报 session id 在最需要它的时候（崩溃、被强杀）恰好不可靠；
      // 由父进程建、父进程收，子进程只是拿去用。
      let sessionId = opts.session;
      try {
        await ensureBskReady();
        if (!sessionId) sessionId = await ensureSession();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const error = err instanceof Error ? err : new Error(detail);
        failures.set(i, { reason: "infrastructure", detail });
        fatal = { kind: "infrastructure", error, detail };
        stopped = true;
        info(t("log.suiteInfraGone", { msg: detail, done: reports.size }));
        return;
      }

      const scriptPath = tmpDir
        ? join(tmpDir, `scenario-${i + 1}.replay.json`)
        : undefined;
      const outcome = await runScenarioChild({
        entry,
        scenarioIndex: i,
        total: scenarios.length,
        input: opts.input,
        session: sessionId,
        scriptPath,
        debug: opts.debug,
        timeoutMs: opts.timeoutMs,
        emitLog,
        // 并发时日志必然交错，父进程的「开始/结束」行已经分不清谁是谁——
        // 只有这时才给每行加场景编号前缀（逐个跑时加了只会挤掉日志正文，见 ADR-0013 决策九）。
        ...(parallel ? { logTag: scenarioLogTag(i + 1, sc.name) } : {}),
        usageStream: opts.usageStream,
        ...(opts.onChildUsage ? { onUsage: opts.onChildUsage } : {}),
      });

      if (outcome.report) {
        reports.set(i, outcome.report);
        if (outcome.script) childScripts.set(i, outcome.script);
        info(
          t("log.suiteScenarioEnd", {
            i: i + 1,
            n: scenarios.length,
            status: outcome.report.status === "pass" ? "PASS" : "FAIL",
          }),
        );
        return;
      }

      // 子进程没交出报告 ⟹ 它没能走到 runAgent 的 finally ⟹ 那个 session 还是活的，
      // 由父进程兜底关掉（ADR-0013 决策四）。正常结束时子进程自己已经关过了。
      if (sessionId) await closeSession(sessionId);

      // ── 没有报告：先分清是「模型挂了」还是「子进程崩了」（ADR-0013 决策七）──
      // 只有超时不用查：它是我们自己下的手，原因已经确定。
      if (outcome.stopped === "timeout") {
        const sec = String(Math.round(opts.timeoutMs / 1000));
        failures.set(i, { reason: "timeout", detail: sec });
        info(
          t("log.suiteChildTimeout", { i: i + 1, n: scenarios.length, sec }),
        );
        return;
      }
      info(
        t("log.suiteChildProbe", { i: i + 1, n: scenarios.length }),
      );
      const cls = await classifyReportless(outcome);
      if (cls.kind) {
        // 模型挂了 / 环境坏了都不是这一个场景的事：记下判定、停止派发后续场景。
        // 已经在跑的会跑完（它们的结论照收），没派发的由下面的汇总记成「已取消」。
        const error = cls.error ?? new Error(cls.detail);
        failures.set(i, { reason: "infrastructure", detail: cls.detail });
        if (!fatal) fatal = { kind: cls.kind, error, detail: cls.detail };
        stopped = true;
        info(
          cls.kind === "model"
            ? t("log.suiteModelGone", { done: reports.size })
            : t("log.suiteInfraGone", { msg: cls.detail, done: reports.size }),
        );
        return;
      }
      failures.set(i, { reason: "crash", detail: outcome.how });
      info(
        t("log.suiteChildCrash", {
          i: i + 1,
          n: scenarios.length,
          how: outcome.how,
        }),
      );
    };

    await mapWithConcurrency(
      scenarios,
      concurrency,
      (_sc, i) => runOne(i),
      () => stopped,
    );

    // 一条都没跑成时沿用既有的干净报错路径（不往 stdout 塞一份伪装成结果的报告）：
    // 逐场景运行时是这个处置，换成子进程之后必须逐字保持（ADR-0013）。
    if (fatal && reports.size === 0) throw fatal.error;
    const modelUnreachable =
      fatal?.kind === "model" && reports.size > 0
        ? { message: fatal.detail, done: reports.size }
        : undefined;

    // ── 汇总：口径与回放模式共用 summarizeSuite，两种模式报告结构一致 ──
    const members: SuiteMember[] = scenarios.map((sc, i) => {
      const report = reports.get(i);
      if (report) {
        return {
          name: sc.name,
          report: toMemberReport(report, sc.name),
          usage: report.usage ?? emptyUsage(),
        };
      }
      const failure = failures.get(i);
      if (failure) {
        return { name: sc.name, report: failedMember(sc, failure), usage: emptyUsage() };
      }
      return { name: sc.name, report: cancelledMember(sc), usage: emptyUsage() };
    });

    const summary = summarizeSuite(members);
    summary.durationMs = Date.now() - startedAt;
    if (opts.reportedScriptPath) summary.script = opts.reportedScriptPath;
    // 键是场景序号：合并顺序因此恒等于用例原文顺序，与谁先跑完无关（见 mergeScripts）。
    const script = opts.wantScript ? mergeScripts(childScripts) : null;

    return {
      report: summary,
      text: renderSuiteText(
        summary,
        members,
        scenarios.map((s) => ({ name: s.name })),
      ),
      json: JSON.stringify(summary, null, 2),
      transcript: summary.transcript,
      usage: summary.usage ?? emptyUsage(),
      script,
      ...(modelUnreachable ? { modelUnreachable } : {}),
      done: reports.size,
    };
  } finally {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** 子进程的命令行契约（ADR-0013 决策二）。 */
export interface ChildInvocation {
  /** 场景序号（0 起）；传给子进程的是「序号 + 1」。 */
  scenarioIndex: number;
  /** 用例输入：文件路径，或内联原文。 */
  input: string;
  session?: string;
  /** 临时回放脚本的落点（录制数据就是这样回传的）。 */
  scriptPath?: string;
  /** 让子进程把 LLM 用量逐次打到 stderr（交互模式要实时用量时才加）。 */
  usageStream?: boolean;
  debug?: boolean;
  locale?: string;
}

/**
 * 拼出子进程的命令行。
 *
 * 抽成纯函数是为了让单测把这份契约钉死——它是「单独重跑」与「父进程内部隔离」
 * 共用同一条路径的前提，改错了不会报错，只会静默地跑成别的场景。
 */
export function buildChildArgs(inv: ChildInvocation): string[] {
  return [
    "--only",
    String(inv.scenarioIndex + 1),
    "--json",
    "--no-tui",
    "--no-side-outputs",
    "--locale",
    inv.locale ?? getLocale(),
    ...(inv.debug ? ["--debug"] : []),
    ...(inv.session ? ["--session", inv.session] : []),
    ...(inv.scriptPath ? ["--emit-script", inv.scriptPath] : []),
    ...(inv.usageStream ? ["--usage-stream"] : []),
    // `--` 之后一律按位置参数走：用例原文完全可能以 `-` 开头。必须放在最后。
    "--",
    inv.input,
  ];
}

/**
 * 子进程实时上报 LLM 用量的行前缀（ADR-0013 第二步）。
 *
 * 为什么需要这条通道：交互模式状态栏那句「已经烧了多少」是 `onUsage` 回调一路推上来的，
 * 而场景搬进子进程之后，没有别的东西能把它**实时**带回来（报告只在收工时才有一份）。
 *
 * 刻意做成**明文可读的一行**、由公开的 `--usage-stream` 打开：谁都能自己跑一次子进程
 * 命令看到它（`pageqa --only 2 --usage-stream …`），而不是只有内部人知道的暗规则。
 * 父进程读到这类行会吞掉——状态栏自己会渲染，不需要它再进一遍日志视口。
 */
export const USAGE_LINE_PREFIX = "[pageqa:usage] ";

/** 把一次累计用量渲染成一行（子进程往 stderr 打的就是它）。 */
export function formatUsageLine(usage: TokenUsage): string {
  return USAGE_LINE_PREFIX + JSON.stringify(usage);
}

/** 解析用量行；不是用量行（或半截行）返回 null。 */
export function parseUsageLine(line: string): TokenUsage | null {
  if (!line.startsWith(USAGE_LINE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(line.slice(USAGE_LINE_PREFIX.length)) as Record<
      string,
      unknown
    >;
    if (parsed && typeof parsed === "object") {
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      return {
        input: n(parsed.input),
        output: n(parsed.output),
        cacheRead: n(parsed.cacheRead),
        cacheWrite: n(parsed.cacheWrite),
        reasoning: n(parsed.reasoning),
        total: n(parsed.total),
        calls: n(parsed.calls),
      };
    }
  } catch {
    // 被截断/交错的半截行：当作普通日志行，不因为一行坏数据丢掉整个场景的结果。
  }
  return null;
}

export interface RunChildOptions extends ChildInvocation {
  entry: string;
  total: number;
  timeoutMs: number;
  emitLog: ChildLogSink;
  /**
   * 每行日志前缀（形如 `[#2 场景名]`）：**只在并发时**给，见 ADR-0013 决策九。
   *
   * 传了就给每个非用量行加上，用量行照旧被吞掉（状态栏自己渲染，不需要归属）。
   */
  logTag?: string;
  /** 让子进程把 LLM 用量逐次打到 stderr（`--usage-stream`）。 */
  usageStream?: boolean;
  /** 本次会话的模型选择：用既有的 `PAGEQA_LLM_*` 环境变量传下去（交互模式 /model 要用）。 */
  model?: { provider: string; model: string };
  /** 用户中止（交互模式按 Esc）。 */
  abortSignal?: AbortSignal;
  onUsage?: (usage: TokenUsage) => void;
}

/** 日志前缀里场景名的长度上限：再长就把日志正文挤出屏幕，归属反而看不清了。 */
const LOG_TAG_NAME_MAX = 16;

/**
 * 拼一条日志的「场景归属」前缀：`[#2 场景名]`。
 *
 * 编号在前是有意的：它与报告里的场景次序、`--only k` 的 k、看板与 `/status` 里的编号
 * 都是同一个数，用户可以直接拿它去别处查；名字只负责「一眼认出是哪条」。
 * 名字截断到 {@link LOG_TAG_NAME_MAX}，超长补 `…`——前缀是标签，不该比正文还长。
 *
 * 纯函数（无 I/O、不看语言环境），因此可以单测。
 */
export function scenarioLogTag(index: number, name: string): string {
  const flat = name.replace(/\s+/g, " ").trim();
  const shown =
    flat.length > LOG_TAG_NAME_MAX
      ? flat.slice(0, LOG_TAG_NAME_MAX) + "…"
      : flat;
  return `[#${index} ${shown}]`;
}

/**
 * 跑一个场景的子进程。
 *
 * 子进程的命令行就是公开入口那一套（ADR-0013 决策二），因此「单独重跑一个场景」
 * 与「父进程内部隔离」是同一条代码路径：
 *
 * ```
 * pageqa --only <k> --json --no-tui --no-side-outputs --session <id> -- <用例>
 * ```
 *
 * - `--json`：stdout 只放最终报告，父进程只认这一份 JSON；
 * - `--no-side-outputs`：HTML 报告与**默认**回放脚本都别写（父进程统一写一份），
 *   但显式给出的 `--emit-script <临时路径>` 仍然生效——录制数据就是这样回传的
 *   （ADR-0013 决策六）；
 * - `--no-tui`：兜底，确保子进程不会去抢终端（stdout 是管道时本来也不会）；
 * - `--usage-stream`：交互模式要实时用量时才加（见 `USAGE_LINE_PREFIX`）。
 *
 * 导出是为了让单测用**假子进程**（entry 指向一个只打印固定内容的脚本）把父进程这一侧
 * 钉死：用量行被吞、其余行原样转发、报告与临时脚本被取回、上限看门狗真的掐得动。
 * 这些都不需要浏览器，因此能进单元测试；真浏览器那段留给冒烟测试。
 */
export async function runScenarioChild(opts: RunChildOptions): Promise<ChildRunResult> {
  const args = buildChildArgs(opts);
  debugLog(`[suite] fork 场景 ${opts.scenarioIndex + 1}/${opts.total}`);

  const env = opts.model
    ? {
        ...process.env,
        PAGEQA_LLM_MODEL: opts.model.model,
        PAGEQA_LLM_PROVIDER: opts.model.provider,
      }
    : process.env;

  const child = spawn(process.execPath, [opts.entry, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env,
  });

  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  // 子进程的 stderr **原样**转发（ADR-0013 决策九）：它自带时间戳，再加一层前缀
  // 会污染既有日志文案与 i18n。按行切是为了让交互模式那一侧能当作「一行日志」消费。
  // 用量行是唯一的例外：它被吞掉（状态栏自己会渲染），不混进日志视口。
  // 并发时是另一个例外：日志必然交错，靠 `logTag` 认出行属于哪个场景（决策三）。
  let pending = "";
  let lastUsage: TokenUsage | undefined;
  const handleLine = (line: string) => {
    const usage = parseUsageLine(line);
    if (!usage) {
      opts.emitLog(opts.logTag ? opts.logTag + " " + line : line);
      return;
    }
    lastUsage = usage;
    opts.onUsage?.(usage);
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  });

  /** 我们主动把它停掉的原因；不是我们下的手就是 undefined。 */
  let stopped: "timeout" | "abort" | undefined;
  const watchdog =
    opts.timeoutMs > 0
      ? setTimeout(() => {
          stopped = "timeout";
          child.kill();
        }, opts.timeoutMs)
      : undefined;
  const onAbort = () => {
    stopped = "abort";
    child.kill();
  };
  opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
  if (opts.abortSignal?.aborted) onAbort();

  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.on("close", (c, s) => resolve({ code: c, signal: s }));
    child.on("error", () => resolve({ code: null, signal: null }));
  });
  if (watchdog) clearTimeout(watchdog);
  opts.abortSignal?.removeEventListener("abort", onAbort);
  if (pending) handleLine(pending);

  const how = describeExit(code, signal);
  if (stopped) return { stopped, how, ...(lastUsage ? { usage: lastUsage } : {}) };

  const report = parseChildReport(stdout);
  if (report) {
    return {
      report,
      how,
      script: loadChildScript(opts.scriptPath),
      ...(lastUsage ? { usage: lastUsage } : {}),
    };
  }
  return { how, ...(lastUsage ? { usage: lastUsage } : {}) };
}

/**
 * 从子进程的 stdout 里取报告。
 *
 * 解析不出来就是「子进程没交出报告」——可能是崩了，也可能是环境坏了，具体哪一种
 * 由 `classifyReportless` 回头查一次再定。这里只负责判断「有没有」。
 */
function parseChildReport(stdout: string): TestReport | undefined {
  const text = stdout.trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as TestReport;
    // 只认套件形态（子进程恒定输出带 `scenarios[]` 的报告，见 ADR-0013 决策五）：
    // 形状不对就当没拿到，不要拿半份东西去汇总。
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.status === "string" &&
      Array.isArray(parsed.scenarios)
    ) {
      return parsed;
    }
  } catch {
    // 非 JSON（比如崩溃时打出来的半截栈）：交给归因那一步处理。
  }
  return undefined;
}

/** 读子进程写出的临时回放脚本；文件缺失/损坏一律当作「这次没有录制」而不是报错。 */
function loadChildScript(path: string | undefined): ReplayScript | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    return loadReplayScript(path);
  } catch (err) {
    debugLog(
      `[suite] 临时回放脚本不可用（${err instanceof Error ? err.message : String(err)}）`,
    );
    return undefined;
  }
}

/** 子进程异常结束的描述（退出码 + 信号），用于写进报告与日志。 */
function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `signal ${signal}`;
  if (code === null) return "spawn failed";
  return `exit code ${code}`;
}

/**
 * 子进程没交出报告时，回头判断到底是哪一类（ADR-0013 决策七）。
 *
 * 先查模型、再查浏览器环境：模型挂了要终止整个套件（继续跑只会得到 N 个假失败，
 * 而且每个场景还白开一次浏览器窗口）；浏览器环境挂了同理；两者都健康，那就只能是
 * 这一个子进程自己崩了——记失败、继续跑后面的。
 */
async function classifyReportless(outcome: ChildRunResult): Promise<FailureClass> {
  try {
    await probeModelReachable();
  } catch (err) {
    if (err instanceof ModelUnreachableError) {
      return { kind: "model", detail: err.reason, error: err };
    }
    // 探活本身失败（配置缺模型、provider 没注册等）：同样是「模型这一侧不通」。
    return {
      kind: "model",
      detail: err instanceof Error ? err.message : String(err),
      error: err instanceof Error ? err : undefined,
    };
  }
  try {
    await ensureBskReady();
  } catch (err) {
    return {
      kind: "infrastructure",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  return { kind: null, detail: outcome.how };
}

/**
 * 把子进程那份「只有一个场景的套件报告」折成汇总要的成员报告。
 *
 * 直接用它的顶层会被 `summarizeSuite` 二次加 `[场景名]` 前缀（那一层已经加过了），
 * 所以断言/步骤/轨迹都从 `scenarios[0]` 取，顶层只拿结论、耗时与用量。
 */
function toMemberReport(suiteReport: TestReport, name: string): TestReport {
  const detail = suiteReport.scenarios?.[0];
  return {
    status: suiteReport.status,
    ...(suiteReport.mode ? { mode: suiteReport.mode } : {}),
    assertions: detail?.assertions ?? [],
    steps: detail?.steps ?? [],
    trace: detail?.trace ?? [],
    ...(detail?.summary ? { summary: detail.summary } : {}),
    ...(detail?.reason ? { reason: detail.reason } : {}),
    ...(detail?.skipped ? { skipped: detail.skipped } : {}),
    transcript: stripSuiteHeader(suiteReport.transcript, name),
    ...(typeof suiteReport.durationMs === "number"
      ? { durationMs: suiteReport.durationMs }
      : {}),
  };
}

/** 去掉子进程套件报告在 transcript 头上加的那行 `## 场景名`（父进程汇总时会再加一次）。 */
function stripSuiteHeader(transcript: string, name: string): string {
  const header = "## " + name + "\n";
  return transcript.startsWith(header) ? transcript.slice(header.length) : transcript;
}

/** 崩溃/超时的场景在报告里的样子：失败 + 机器可读归因，而不是伪造一条断言。 */
function failedMember(
  sc: Scenario,
  failure: { reason: ScenarioFailureReason; detail: string },
): TestReport {
  return {
    status: "fail",
    reason: failure.reason,
    summary: reasonSummary(failure),
    assertions: [],
    transcript: "",
    // 步骤清单照给：CI 侧要能看出「这个场景本来要做哪几步」。
    steps: numberSteps(sc.body).steps,
  };
}

function reasonSummary(failure: {
  reason: ScenarioFailureReason;
  detail: string;
}): string {
  switch (failure.reason) {
    case "timeout":
      return t("report.reason.timeout", { sec: failure.detail });
    case "crash":
      return t("report.reason.crash", { how: failure.detail });
    default:
      return t("report.reason.infrastructure", { msg: failure.detail });
  }
}

/**
 * 被联带取消的场景：既不是通过也不是失败，不计入退出码（ADR-0002 决策五）。
 * 它必须被记成「已取消」而不是「失败」——环境坏了不是被测页面挂了。
 */
function cancelledMember(sc: Scenario): TestReport {
  return {
    status: "cancelled",
    cancelReason: t("report.cancelEnvGone"),
    assertions: [],
    transcript: "",
    steps: numberSteps(sc.body).steps,
  };
}

/**
 * 环境级故障：模型端点不可达之外的「跑不了」——bsk daemon 不可用、连不上浏览器。
 *
 * 与 `ModelUnreachableError` 分开是因为处置虽同（取消剩余场景）、说法必须不同：
 * 报告里把「模型连不上」说成「浏览器连不上」会把人引到错误的方向去。
 * 交互模式据此停掉整条队列（见 ADR-0013 决策七）。
 */
export class EnvironmentUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(t("err.envUnavailable", { msg: reason }));
    this.name = "EnvironmentUnavailableError";
  }
}

/**
 * `--concurrency > 1` 与显式 `--session` 同时给出：场景之间会互相翻页。
 *
 * 这不是「参数组合不支持」，而是**语义上不成立**。并发的前提是每个场景独占一个浏览器窗口，
 * 而 `--session` 让所有场景共用一个 session：
 * - bsk 对「同一 session 已有命令在跑」直接回 `session_busy`（不是排队），
 *   于是这堆真并发会被摊成一片「场景失败 / 超时」的假结论；
 * - 更糟的是它**不一定报错**：A 导航、B 导航、A 的点击落在 B 的页面上，
 *   报告照样会给出 PASS/FAIL，只是那结论来自另一个页面。
 *
 * 因此宁可当场拒绝，也不静默改成串行——「你不说就动你的并发度」与
 * `--concurrency` 超上限时不静默截断是同一条原则（见 MAX_CONCURRENCY 的说明）。
 */
export class ConcurrencySessionConflictError extends Error {
  constructor(readonly concurrency: number) {
    super(t("err.concurrencyWithSession", { n: concurrency }));
    this.name = "ConcurrencySessionConflictError";
  }
}

/**
 * 这个组合是否会真的并发：**只有两个以上场景**、并发上限大于 1、且显式给了 session 才算冲突。
 *
 * 抽成纯函数是为了让单测把「什么时候该拒、什么时候不该拒」钉死：
 * 一个场景时并发无从谈起（单场景照跑），并发为 1 时本来就是一个一个跑（共享 session 正是它的用法）。
 */
export function isConcurrencySessionConflict(
  concurrency: number,
  scenarioCount: number,
  session: string | undefined,
): boolean {
  return concurrency > 1 && scenarioCount > 1 && Boolean(session);
}

// ── 交互模式的单场景入口（ADR-0013 第二步）──

export interface ChildScenarioOptions {
  /** 场景名：追加场景的名字来自用户，必须原样进报告与回放脚本。 */
  name: string;
  /** **未展开**的用例原文：子进程自己展开，回放脚本才能还原成 `${...}`。 */
  body: string;
  /** 本次会话选定的模型：`/model` 只改内存，必须显式传给子进程。 */
  model?: { provider: string; model: string };
  debug?: boolean;
  /** 场景级执行上限（毫秒；0 = 不限）。 */
  timeoutMs: number;
  /** 用户按 Esc → 杀掉子进程，该场景记「已取消」。 */
  abortSignal?: AbortSignal;
  /** 子进程逐次上报的用量（状态栏实时显示）。 */
  onUsage?: (usage: TokenUsage) => void;
  /** 子进程日志的落点（交互模式接进日志视口）。 */
  onChildLog?: ChildLogSink;
  /**
   * 每行日志的场景前缀（形如 `[#3 场景名]`）：交互模式并发时给，否则不给。
   *
   * 判定在调用方（TUI 知道自己的并发量与队列长度），这里只负责透传。
   */
  logTag?: string;
  entry?: string;
}

/**
 * 把一个场景交给独立子进程执行，返回与 `runAgent` 同形的结果。
 *
 * 交互模式复用批处理那个执行器，差别只有三处：日志进界面视口而不是 stderr、
 * 打开 `--usage-stream` 拿实时用量、以及把会话选定的模型用既有的 `PAGEQA_LLM_*`
 * 环境变量传下去。**没有第四套机制**——模型走既有环境变量，用量走那一条明文协议。
 */
export async function runScenarioInChild(
  opts: ChildScenarioOptions,
): Promise<AgentRunResult> {
  const entry = opts.entry ?? resolveCliEntry();
  const emitLog = opts.onChildLog ?? ((line: string) => process.stderr.write(line + "\n"));

  // 轮到它了才建 session，且由父进程持有（ADR-0013 决策四）。
  // 这一步失败是**环境级**故障（daemon 不可用、浏览器没连）：包装成专用类型，
  // 交互模式据此停掉整条队列，而不是把它摊成一条普通失败继续跑（决策七）。
  let session: string;
  try {
    await ensureBskReady();
    session = await ensureSession();
  } catch (err) {
    throw new EnvironmentUnavailableError(
      err instanceof Error ? err.message : String(err),
    );
  }

  const dir = mkdtempSync(join(tmpdir(), "pageqa-scene-"));
  const scriptPath = join(dir, "scenario.replay.json");
  let lastUsage: TokenUsage | undefined;
  try {
    const outcome = await runScenarioChild({
      entry,
      scenarioIndex: 0,
      total: 1,
      // 名字重新拼回 `## 场景名`：子进程靠它认领场景，报告里也才是用户给的那个名字。
      input: "## " + opts.name + "\n" + opts.body,
      session,
      scriptPath,
      usageStream: true,
      model: opts.model,
      ...(opts.logTag ? { logTag: opts.logTag } : {}),
      abortSignal: opts.abortSignal,
      timeoutMs: opts.timeoutMs,
      debug: opts.debug,
      emitLog,
      onUsage: (usage) => {
        lastUsage = usage;
        opts.onUsage?.(usage);
      },
    });

    if (outcome.report) {
      const report = toMemberReport(outcome.report, opts.name);
      if (lastUsage && !report.usage) report.usage = lastUsage;
      return {
        report,
        text: renderText(report),
        json: JSON.stringify(report, null, 2),
        transcript: report.transcript,
        usage: report.usage ?? emptyUsage(),
        recordings: outcome.script ? recordingsFromScript(outcome.script) : [],
      };
    }

    // ── 没有报告：先看是不是我们自己把它停掉的 ──
    if (outcome.stopped === "abort") {
      if (session) await closeSession(session);
      // 用户中止：记「已取消」，不计入退出码、也不写回放脚本（ADR-0002 决策五）。
      // 已经烧掉的用量照带回去——中止的只是执行，不是已经发生的消耗。
      return resultFromReport({
        status: "cancelled",
        cancelReason: t("report.cancel"),
        assertions: [],
        transcript: "",
        steps: numberSteps(opts.body).steps,
        ...(lastUsage ? { usage: lastUsage } : {}),
      });
    }
    if (outcome.stopped === "timeout") {
      if (session) await closeSession(session);
      const sec = String(Math.round(opts.timeoutMs / 1000));
      return resultFromReport(
        failedMember(
          { name: opts.name, body: opts.body },
          { reason: "timeout", detail: sec },
        ),
      );
    }

    // ── 子进程没交出报告：回头查一次，分清「模型挂了 / 环境坏了 / 它自己崩了」──
    if (session) await closeSession(session);
    const cls = await classifyReportless(outcome);
    if (cls.kind === "model") {
      throw cls.error instanceof ModelUnreachableError
        ? cls.error
        : new ModelUnreachableError(
            opts.model?.provider ?? "",
            opts.model?.model ?? "",
            cls.detail,
          );
    }
    if (cls.kind === "infrastructure") {
      throw new EnvironmentUnavailableError(cls.detail);
    }
    return resultFromReport(
      failedMember(
        { name: opts.name, body: opts.body },
        { reason: "crash", detail: outcome.how },
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 把一份成员形态的报告包成 `AgentRunResult`（交互模式执行器的返回形状）。 */
function resultFromReport(report: TestReport): AgentRunResult {
  return {
    report,
    text: renderText(report),
    json: JSON.stringify(report, null, 2),
    transcript: report.transcript,
    usage: report.usage ?? emptyUsage(),
    recordings: [],
  };
}

/**
 * 子进程脚本里的场景 → 回放录制。
 *
 * 刻意不在这里贴 `sourcePath`：来源是「这个场景写回哪个用例文件」的事，由交互模式
 * 在归档批次时统一补（`src/tui/batches.ts`）。子进程根本不知道写回落点，
 * 在这里猜一个只会多一处可能写错的地方。
 */
function recordingsFromScript(script: ReplayScript): ScenarioRecording[] {
  return script.scenarios.map((s) => ({
    name: s.name,
    caseSteps: s.caseSteps,
    steps: s.steps,
  }));
}

/**
 * 把各子进程写出的临时脚本合并成一份（键 = 场景序号，从 0 起）。
 *
 * 顺序按**场景序号**排，不按交卷先后：并行跑时先结束的场景先把脚本交上来，
 * 按到达顺序合并就等于把「创建 → 编辑 → 删除」演成乱序回放
 * （实测一份两场景脚本里 S2 排在 S1 前面）。
 *
 * 一个源用例 = 一份脚本是不变量（ADR-0001）：脚本内部本来就有 `scenarios[]`，
 * 拆成「一个场景一份」会让 `--replay <整份用例>` 失去对应文件。
 * `source` 取序号最小的一份即可——每个子进程读的是同一份源用例，hash 必然一致。
 *
 * 导出是为了让单测能把「合并顺序 = 用例原文顺序」这条契约钉死，不需要真起浏览器。
 */
export function mergeScripts(
  scripts: Map<number, ReplayScript>,
): ReplayScript | null {
  const ordered = [...scripts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, script]) => script);
  if (ordered.length === 0) return null;
  return {
    format: REPLAY_FORMAT,
    version: REPLAY_VERSION,
    recordedAt: new Date().toISOString(),
    source: ordered[0].source,
    scenarios: ordered.flatMap((s) => s.scenarios),
  };
}
