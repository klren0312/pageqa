#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ModelUnreachableError,
  renderScenarios,
  runAgent,
  runSuite,
  selectScenario,
  splitScenarios,
  type AgentRunResult,
  type ScenarioSelection,
} from "./agent.js";
import {
  ensureConfigDir,
  CONFIG_PATH,
  loadConfig,
  readConcurrency,
  readSavedLocale,
  readScenarioTimeoutMs,
  readSideOutputPrefs,
  type SideOutputPrefs,
} from "./config.js";
import { downloadedFiles } from "./downloads.js";
import type { TestReport, TokenUsage } from "./report.js";
import {
  ConcurrencySessionConflictError,
  formatUsageLine,
  MAX_CONCURRENCY,
  runSuiteInChildren,
} from "./suite.js";
import {
  emitSideOutputs,
  writeReportSideOutput,
  type ScriptOutcome,
} from "./side-outputs.js";
import { runInteractive } from "./tui/app.js";
import {
  buildReplayScript,
  groupRecordingsBySource,
  loadReplayScript,
  runReplayScript,
  sourceDriftNotice,
  writeReplayScript,
  type ReplayScript,
  type ScenarioRecording,
} from "./replay.js";
import {
  captureRunVars,
  expandVars,
  VAR_HELP,
  type RunVarValue,
} from "./vars.js";
import { info, setDebug } from "./log.js";
import { parseLocale, setLocale, t } from "./i18n.js";
import { packageVersion } from "./version.js";

interface CliArgs {
  input?: string;
  session?: string;
  json: boolean;
  out?: string;
  suite: boolean;
  initConfig: boolean;
  help: boolean;
  /** `--version`：打印版本号后退出（方便脚本/CI 取当前版本）。 */
  version: boolean;
  debug: boolean;
  /** `--replay <file>`：零模型回放一个已有的回放脚本。 */
  replay?: string;
  /** `--emit-script [path]`：运行结束后把本次操作序列固化成回放脚本。 */
  emitScript: boolean;
  emitScriptPath?: string;
  /** `--semantic`：回放时的断言改用 Jev 语义判断（默认纯字符串匹配）。 */
  semantic: boolean;
  /** `--fail-fast`：回放时任一失败即停止该场景（默认跑完剩余步骤）。 */
  failFast: boolean;
  /**
   * `--settle-waits`：回放时把 `wait` 步骤当作「等页面稳定，上限为脚本记下的毫秒数」。
   *
   * 默认关闭：它的收益是把录制时留下的固定等待（实测占回放墙钟近一半）压成「页面一稳定就走」，
   * 代价是「为页面之外的事情留的等待」会被提前放行（见 replay.ts 的 ReplayOptions.settleWaits）。
   */
  settleWaits: boolean;
  /**
   * `--locate-timeout <ms>`：回放时，定位符**所在区域整体缺失**等页面就绪的上限（默认 8000ms）。
   *
   * 只在区域一起缺失时才等：区域在、或区域是没打开的浮层，立刻按「元素未找到」处理
   * （判据见 locator.ts 的 inspectRegion）。0 = 完全不等。
   */
  locateTimeoutMs?: number;
  /**
   * `--only <序号|标题>`：只跑其中一个场景（由 `## 场景名` 分隔出来的那一个）。
   * 批处理选项，与 `--suite` / `--tui` / `--replay` 互斥；见 ADR-0013 决策二。
   */
  only?: string;
  /**
   * `--no-side-outputs`：不写旁路产物（HTML 报告、默认回放脚本）。
   * 显式给出的 `--emit-script <path>` 仍然生效——显式请求优先（ADR-0011 决策三）。
   */
  noSideOutputs: boolean;
  /**
   * `--usage-stream`：把 LLM 用量的结构化记录逐次打到 stderr（一行一次）。
   *
   * 场景在子进程里执行时，父进程靠它把「已经烧了多少」实时带回来（见 ADR-0013 第二步）。
   * 谁都能自己跑一次带这个开关的命令看到它——不是内部暗规则。
   */
  usageStream: boolean;
  /**
   * `--concurrency <n>`：同时跑几个场景（**上限**，默认 1 = 逐个跑）。
   *
   * 并行等于声明「这些场景互不依赖」——这个声明只能由人来做，所以默认不开。
   * 只作用于批处理的多场景套件；交互模式与回放仍然是逐个跑（见 ADR-0013 决策三）。
   */
  concurrency?: number;
  /** `--tui`：显式要求进入交互模式。 */
  tui: boolean;
  /** `--no-tui`：显式拒绝交互模式（本机只想看滚动日志时用）。 */
  noTui: boolean;
  /** `--locale <zh|en>`：界面/日志/报告的显示语种（默认 zh）。 */
  locale: string;
  /** 参数解析错误（如带值选项缺少参数）；有值时 main 会提示并退出。 */
  error?: string;
}

export function parseArgs(argv: string[]): CliArgs {  const args: CliArgs = {
    json: false,
    suite: false,
    initConfig: false,
    help: false,
    version: false,
    debug: false,
    emitScript: false,
    semantic: false,
    failFast: false,
    settleWaits: false,
    tui: false,
    noTui: false,
    noSideOutputs: false,
    usageStream: false,
    locale: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // 兼容 `--locale=en` 写法（与 `--locale en` 等价）
    if (a.startsWith("--locale=")) {
      const v = a.slice("--locale=".length);
      args.locale = v;
      setLocale(parseLocale(v));
      continue;
    }
    switch (a) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-v":
      case "--version":
        args.version = true;
        break;
      case "--session": {
        const v = argv[++i];
        // 以 - 开头的「值」多半是下一个选项被吞了（如 `--session --json`）：
        // 宁可报缺参，也不拿一个 flag 当 session id 去跑。
        if (v === undefined || v.startsWith("-")) {
          args.error = t("err.sessionRequired");
          return args;
        }
        args.session = v;
        break;
      }
      case "--json":
        args.json = true;
        break;
      case "--suite":
        args.suite = true;
        break;
      case "--only": {
        const v = argv[++i];
        // 与 `--session` 同一套判据：以 - 开头的「值」多半是下一个选项被吞了。
        // 场景标题倒是可以以 - 开头，但那种标题本来就该用引号包起来，而引号在 shell 里
        // 就被剥掉了——所以这里宁可报缺参，也不拿一个 flag 当场景标识去找。
        if (v === undefined || v.startsWith("-")) {
          args.error = t("err.onlyRequired");
          return args;
        }
        args.only = v;
        break;
      }
      case "--no-side-outputs":
        args.noSideOutputs = true;
        break;
      case "--usage-stream":
        args.usageStream = true;
        break;
      case "--concurrency": {
        const v = argv[++i];
        if (v === undefined || v.startsWith("-")) {
          args.error = t("err.concurrencyRequired");
          return args;
        }
        // 只收正整数：`--concurrency 0`、`--concurrency 两个` 这类必须当场报错，
        // 静默回落成 1 会让人以为「我明明开了并行怎么还是一个个跑」。
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) {
          args.error = t("err.concurrencyInvalid", { value: v });
          return args;
        }
        args.concurrency = n;
        break;
      }
      case "--init-config":
        args.initConfig = true;
        break;
      case "--locale": {
        const v = argv[++i];
        if (v === undefined || v.startsWith("-")) {
          args.error = t("err.localeRequired", { arg: "--locale" });
          return args;
        }
        args.locale = v;
        setLocale(parseLocale(v));
        break;
      }
      case "--out": {
        const v = argv[++i];
        if (v === undefined || v.startsWith("-")) {
          args.error = t("err.outRequired");
          return args;
        }
        args.out = v;
        break;
      }
      case "--debug":
        args.debug = true;
        break;
      case "--replay": {
        const v = argv[++i];
        if (v === undefined || v.startsWith("-")) {
          args.error = t("err.replayRequired");
          return args;
        }
        args.replay = v;
        break;
      }
      case "--emit-script": {
        args.emitScript = true;
        // 路径可选：只有「看起来像路径」的后一个 token 才被当作输出路径消费，
        // 否则（如 `pageqa --emit-script examples/smoke.md`）留给用例输入位。
        const next = argv[i + 1];
        if (next && looksLikeScriptPath(next)) {
          args.emitScriptPath = next;
          i++;
        }
        break;
      }
      case "--semantic":
        args.semantic = true;
        break;
      case "--fail-fast":
        args.failFast = true;
        break;
      case "--settle-waits":
        args.settleWaits = true;
        break;
      case "--locate-timeout": {
        const v = argv[++i];
        if (v === undefined || v.startsWith("-")) {
          args.error = t("err.locateTimeoutRequired");
          return args;
        }
        // 0 是合法值（显式关闭等待），负数与非数字必须当场报错：静默回落成默认值
        // 会让人以为「我已经关掉了怎么还在等」。
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) {
          args.error = t("err.locateTimeoutInvalid", { value: v });
          return args;
        }
        args.locateTimeoutMs = n;
        break;
      }
      case "--tui":
        args.tui = true;
        break;
      case "--no-tui":
        args.noTui = true;
        break;
      case "--":
        // `--` 之后一律按位置参数处理：内联用例文本以 - 开头时用它兜底
        // （否则会被当成未知选项报错）。
        for (i += 1; i < argv.length; i++) {
          const rest = argv[i];
          if (args.input !== undefined) {
            args.error = t("err.extraPositional", { a: rest });
            return args;
          }
          args.input = rest;
        }
        break;
      default:
        if (a.startsWith("-")) {
          // 未知选项不能静默吞掉：`--emti-script`（拼错）被忽略的话，
          // 用户以为在录回放脚本，实际什么都没发生。
          args.error = t("err.unknownOption", { a });
          return args;
        }
        // 只接受一个用例输入。此前是「后者覆盖前者」，`--emit-script ./replay`
        // 这类写法一旦没被识别成输出路径，就会静默把用例换成 `./replay` 去跑，
        // 看起来像正常启动、实际测的是完全无关的文本。这里改为直接报错。
        if (args.input !== undefined) {
          args.error = t("err.extraPositional", { a });
          return args;
        }
        args.input = a;
    }
  }
  return args;
}

/**
 * 判断 `--emit-script` 后面的 token 是否应被当作输出路径。
 *
 * 判据是「像不像一个路径」而不是「是不是 .json 结尾」：用户完全可能想写成
 * `--emit-script ./replay`（不带扩展名）。因此：
 * - 以 `-` 开头 → 是下一个选项，不是路径；
 * - 以 .md/.txt 结尾 → 是用例文件，留给输入位（支持 `--emit-script 用例.md` 的写法）；
 * - 含空白或中文 → 是内联用例文本，留给输入位；
 * - 其余（`./replay`、`out.json`、`reports/run1`、`C:\out.json`）→ 当作输出路径。
 *
 * 盘符里的 `:` 也要认：套件编排把每个场景的临时脚本写到系统临时目录，Windows 下
 * 就是 `C:\Users\…\Temp\…` 这个形状；不认它就会把路径当成用例输入吞掉。
 */
function looksLikeScriptPath(token: string): boolean {
  if (token.startsWith("-")) return false;
  if (/\.(md|txt)$/i.test(token)) return false;
  return /^[A-Za-z0-9_./\\:-]+$/.test(token);
}

/**
 * 帮助文本：按当前语种渲染。完整文案在 i18n 目录里（key `help.full`），
 * 其中的 `{VAR_HELP}` 占位由调用方替换为运行期生成的占位符说明。
 */
function buildHelp(): string {
  return t("help.full").replace("{VAR_HELP}", VAR_HELP);
}

/**
 * 从资源管理器「复制文件路径」或聊天工具粘贴路径时，常会夹带不可见的
 * Bidi 控制符 / 零宽字符（如 U+202A LEFT-TO-RIGHT EMBEDDING、U+200B、U+FEFF）。
 * 它们肉眼不可见，却会让 readFileSync 找不到文件，进而把路径误判成内联文本。
 */
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** 清洗命令行传入的 <input>：去不可见字符、去首尾空白、去成对引号、去 file:// 前缀。 */
function cleanInput(raw: string): string {
  let s = raw.replace(INVISIBLE_CHARS, "").trim();
  const quoted = s.match(/^(["'])([\s\S]*)\1$/);
  if (quoted) s = quoted[2].replace(INVISIBLE_CHARS, "").trim();
  if (/^file:\/\//i.test(s)) {
    try {
      s = fileURLToPath(s);
    } catch {
      // 非法 file URL：保持原样，后续按不存在处理
    }
  }
  return s;
}

/** 是否"看起来"是一个脚本文件路径：单行且以 .md/.txt 结尾（大小写不敏感）。 */
function looksLikeScriptFile(input: string): boolean {
  return !/[\r\n]/.test(input) && /\.(md|txt)$/i.test(input);
}

/**
 * 默认的回放脚本落盘位置：贴着源用例（同名 + `.replay.json`），便于和用例一起进 git 评审。
 * 内联文本与无落点的追加场景没有源文件，落到当前工作目录。
 */
function defaultScriptPath(rawInput: string, isFile: boolean): string {
  return scriptPathForSource(isFile ? rawInput : null);
}

/** 一个来源文件对应的默认脚本位置。 */
function scriptPathForSource(sourcePath: string | null): string {
  if (!sourcePath) return "pageqa.replay.json";
  return join(
    dirname(sourcePath),
    basename(sourcePath, extname(sourcePath)) + ".replay.json",
  );
}

/**
 * 把交互模式跑过的场景固化成回放脚本（**按来源拆分**，见 ADR-0005 决策七）。
 *
 * 一个来源 = 一个用例文件 = 一份脚本：脚本头部的 `source { path, hash }` 是单值，
 * 而一次交互会话可以加载多个用例文件。刻意不升级脚本格式（`sources[]`）——脚本是
 * 会被长期保存、丢进 git、在 CI 里零模型重跑的对外契约，不值得为「一份脚本装多来源」
 * 这个几乎用不到的写法去动它的结构。
 *
 * 显式给了路径却撞上多个来源时**直接报错**：静默只收其中一个等于丢数据，而「脚本与
 * 用例文件一对一」是 ADR-0001 立下的不变量。一个场景都没跑过时不落盘——「压根没跑」
 * 不是证据，落盘只会多一个需要判断「这个空脚本是什么」的文件。
 *
 * 只返回结果、不打日志：路径与「为什么没生成」由收尾的产物清单统一交代（ADR-0011 决策五）。
 * 没有落点的场景不再兜底写到 cwd（决策四）：脚本贴的是「当前打开的用例文件」，没有打开的
 * 用例文件时，往工作目录扔一个隐式的 pageqa.replay.json 最容易被忽略。
 */
function buildInteractiveScripts(
  recordings: ScenarioRecording[],
  explicitPath: string | undefined,
): ScriptOutcome {
  if (recordings.length === 0) return { kind: "none" };
  const groups = groupRecordingsBySource(recordings);
  if (explicitPath && groups.size > 1) {
    throw new Error(
      t("err.emitMultiSource", {
        n: groups.size,
        paths: [...groups.keys()].map((p) => p ?? "-").join("、"),
      }),
    );
  }
  const paths: string[] = [];
  let noTarget = 0;
  for (const [sourcePath, group] of groups) {
    // 无落点的追加场景不再兜底写到 cwd：脚本贴的是「当前打开的用例文件」，
    // 没有打开的用例文件时，往工作目录扔一个隐式的 pageqa.replay.json 最容易被忽略
    // （ADR-0011 决策四）。显式给了路径时仍按它写——那是用户明确要求。
    if (!sourcePath && !explicitPath) {
      noTarget += group.length;
      continue;
    }
    const target = explicitPath ?? scriptPathForSource(sourcePath);
    // 写回之后源文件内容已变：必须重新读它算 hash，否则第一次回放就报「源用例已变更」。
    // 文件在运行中被删/改名时照常出脚本，只是没有漂移检测的依据（hash 为 null）。
    let sourceText: string | null = null;
    if (sourcePath) {
      try {
        sourceText = readFileSync(sourcePath, "utf8");
      } catch {
        sourceText = null;
      }
    }
    const script = buildReplayScript(group, { sourcePath, sourceText });
    writeReplayScript(target, script);
    paths.push(target);
  }
  if (paths.length === 0) return { kind: "no-target", count: noTarget };
  return { kind: "written", paths, ...(noTarget > 0 ? { noTarget } : {}) };
}

/**
 * 退出码：只有真正失败才非零。
 *
 * 「已取消」不计入——用户按 Esc 是「我不想再等这个了」，不是「这个用例挂了」，
 * 把它算成失败会让退出码和报告一起说谎（ADR-0002 决策五）。
 */
function exitCodeFor(report: TestReport): number {
  return report.status === "fail" ? 1 : 0;
}

/**
 * 是否进入交互模式。
 *
 * 判据必须**同时**看 stdin 与 stdout：TUI 要 raw stdin，只看 stdout 会让
 * `pageqa case.md < /dev/null`、IDE 内嵌终端、CI 子 shell 进去一个收不到键的空壳。
 *
 * `--json` 阻止（机器消费方要纯 stdout）；`--replay` 阻止（秒级零模型，全屏只是噪音）；
 * `--out` **不阻止**（它只是「报告另存一份」，与要不要看 TUI 无关）。
 */
function detectInteractive(
  args: CliArgs,
  isFile: boolean,
  hasInput: boolean,
  concurrency: number,
): { run: boolean; error?: string } {
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (args.tui) {
    if (args.noTui)
      return { run: false, error: t("err.tuiConflict") };
    // `--only` 把「跑哪一个场景」定死了，而交互模式的核心是「随时追加场景」：
    // 两者诉求相反，硬凑在一起只会得到半套行为（见 ADR-0013）。
    if (args.only !== undefined) {
      return { run: false, error: t("err.onlyWithTui") };
    }
    // `--concurrency` 与交互模式**不冲突**了：TUI 的队列也认并发上限（`/setting`
    // 里的「并发量」就是它，CLI 这个值只是本次会话的起点）。见 ADR-0013 决策三。
    if (args.json) {
      return { run: false, error: t("err.tuiWithJson") };
    }
    if (args.session) {
      return { run: false, error: t("err.tuiWithSession") };
    }
    if (hasInput && !isFile) {
      return { run: false, error: t("err.tuiNeedsFile") };
    }
    if (!tty) {
      return { run: false, error: t("err.tuiNeedsTty") };
    }
    return { run: true };
  }
  if (args.noTui || process.env.PAGEQA_NO_TUI) return { run: false };
  // `--only` 是批处理选项：不自动进交互模式（理由同上）。
  if (args.only !== undefined) return { run: false };
  // 自动识别：两个流都是 TTY、未给 --json，且「给了源用例文件」或「什么都没给」。
  // 前者是「跑这条用例」，后者是「先开个会话再决定跑什么」（ADR-0005 决策一）。
  // 内联文本仍不进——批处理与交互的差别只该是「人看不看这个终端」。
  return { run: Boolean(tty && !args.json && (isFile || !hasInput)) };
}

/**
 * 交互模式入口：把控制权交给 TUI，退出后回到批处理口径输出汇总报告。
 *
 * `source` 为空对象表示**无源会话**（无参启动）：队列为空、落点为空，
 * 用例文件由运行中的 `/run` 决定（见 ADR-0005 决策一）。
 *
 * 回放脚本必须在**写回完成之后**再生成：`source.hash` 依据的是源用例文件内容，
 * 而交互过程会把追加场景写进它——沿用启动时读到的那份，会让第一次回放就报「源用例已变更」。
 */
async function interactiveMode(
  source: { path?: string; text?: string },
  args: CliArgs,
  concurrency: number,
): Promise<number> {
  info(t("log.startupInteractive"));
  const result = await runInteractive(source.text ?? "", {
    sourcePath: source.path,
    debug: args.debug,
    scriptPath: args.emitScriptPath,
    // 场景级上限：交互模式下场景也跑在子进程里，超时只能由父进程看门狗掐（ADR-0013）。
    scenarioTimeoutMs: readScenarioTimeoutMs(),
    // 并发度只是本次会话的起点，`/setting` 里的「并发量」随时可改（并写回配置）。
    concurrency,
  });

  if (result.writtenBack > 0 && source.path) {
    info(
      t("log.wroteBackScenarios", {
        n: result.writtenBack,
        path: source.path,
      }),
    );
  }
  // 没有落点的追加场景关掉就没：收尾时必须说出来（ADR-0005 决策六）。
  if (result.unwritten > 0) {
    info(t("log.lostScenarios", { n: result.unwritten }));
  }

  // ── 旁路产物：测试报告与回放脚本；显式 --emit-script 优先于 /setting 的开关 ──
  const prefs = readSideOutputPrefs();
  const reportOutcome = writeReportSideOutput(result.report, prefs);
  let scriptError: string | undefined;
  let scriptOutcome: ScriptOutcome;
  if (args.emitScript || prefs.replayScript) {
    try {
      scriptOutcome = buildInteractiveScripts(
        result.recordings,
        args.emitScriptPath,
      );
    } catch (err) {
      // 报告仍要打出来（用户可能等了十几分钟），脚本这头的错如实上 stderr 并反映到退出码。
      scriptError = err instanceof Error ? err.message : String(err);
      scriptOutcome = { kind: "failed", error: scriptError };
    }
  } else {
    scriptOutcome = { kind: "off" };
  }

  const out = args.json ? result.json : result.text;
  if (args.out) writeFileSync(args.out, out + "\n");
  process.stdout.write(out + "\n");
  emitSideOutputs(reportOutcome, scriptOutcome, downloadedFiles());
  if (scriptError) {
    process.stderr.write(t("err.execFailed", { msg: scriptError }) + "\n");
    return 1;
  }
  return exitCodeFor(result.report);
}

/** 交互模式的统一收尾：把抛出的异常翻成可读报错（而不是一个裸栈）。 */
async function runInteractiveSafely(
  source: { path?: string; text?: string },
  args: CliArgs,
  concurrency: number,
): Promise<number> {
  try {
    return await interactiveMode(source, args, concurrency);
  } catch (err) {
    process.stderr.write(
      t("err.execFailed", {
        msg: err instanceof Error ? (err.stack ?? String(err)) : String(err),
      }) + "\n",
    );
    return 1;
  }
}

/**
 * 回放模式入口：加载脚本、提示源用例漂移，然后零模型逐步执行。
 * 退出码语义与自然语言模式一致（全部断言通过 0，否则 1），可直接接 CI。
 */
async function replayMode(args: CliArgs): Promise<number> {
  const path = args.replay as string;
  let script;
  try {
    script = loadReplayScript(path);
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  info(t("log.replayStartup"));
  const drift = sourceDriftNotice(script);
  if (drift) info(t("log.warn", { msg: drift }));

  try {
    const result = await runReplayScript(script, {
      session: args.session,
      semantic: args.semantic,
      debug: args.debug,
      scriptPath: path,
      now: new Date(),
      failFast: args.failFast,
      settleWaits: args.settleWaits,
      locateTimeoutMs: args.locateTimeoutMs,
    });
    const out = args.json ? result.json : result.text;
    if (args.out) writeFileSync(args.out, out + "\n");
    process.stdout.write(out + "\n");
    // 旁路产物：与批处理路径同一条口径——`--no-side-outputs` 关掉默认产出，
    // 否则看 /setting 里的开关。回放模式此前**漏了这一层**：无论开关怎么说都照写 HTML 报告，
    // 于是「零模型的 CI 回放」每次都在工作区留下一份报告文件（ADR-0011 决策三）。
    const prefs: SideOutputPrefs = args.noSideOutputs
      ? { htmlReport: false, replayScript: false }
      : readSideOutputPrefs();
    // 回放用的是现成的脚本、不产出脚本：清单里不列脚本行（ADR-0011 决策五）。
    emitSideOutputs(writeReportSideOutput(result.report, prefs), { kind: "na" }, downloadedFiles());
    return result.report.status === "pass" ? 0 : 1;
  } catch (err) {
    process.stderr.write(
      t("err.execFailed", {
        msg: err instanceof Error ? (err.stack ?? String(err)) : String(err),
      }) + "\n",
    );
    return 1;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  // 语种优先级：CLI `--locale` > 环境变量 `PAGEQA_LOCALE` > 配置文件里保存的 > 默认 zh。
  // parseArgs 已按 `--locale` 切过一次；这里补上「配置文件」这一档（只读，不建文件）。
  setLocale(
    parseLocale(args.locale || process.env.PAGEQA_LOCALE || readSavedLocale()),
  );
  if (args.error) {
    process.stderr.write(t("err.param", { msg: args.error }) + "\n\n");
    process.stdout.write(buildHelp() + "\n");
    return 1;
  }
  if (args.version) {
    // 只打「pageqa <版本>」：脚本要的是版本号本身，不需要帮助文本那套排版。
    process.stdout.write(`pageqa ${packageVersion()}\n`);
    return 0;
  }
  if (args.help) {
    process.stdout.write(buildHelp() + "\n");
    return 0;
  }
  if (args.initConfig) {
    const dir = ensureConfigDir();
    loadConfig(); // 触发配置文件创建
    process.stdout.write(t("config.created", { path: CONFIG_PATH, dir }) + "\n");
    process.stdout.write(
      t("config.current", { json: JSON.stringify(loadConfig(), null, 2) }) +
        "\n",
    );
    return 0;
  }
  // ── 并发上限：CLI > PAGEQA_CONCURRENCY > 配置文件 > 1（逐个跑）──
  // 在这里统一解析（而不是等到套件那一步）是因为它还要参与「要不要进交互模式」的判断。
  const concurrency = args.concurrency ?? readConcurrency();
  if (concurrency > MAX_CONCURRENCY) {
    // 不做静默截断：说 16 却只跑 8，比直接报错更难查。
    process.stderr.write(
      t("err.concurrencyMax", { n: concurrency, max: MAX_CONCURRENCY }) + "\n\n",
    );
    return 1;
  }

  // ── 回放模式：零模型执行已有脚本（与用例输入互斥）──
  if (args.replay) {
    if (args.input) {
      process.stderr.write(t("err.replayWithInput") + "\n\n");
      return 1;
    }
    if (args.emitScript) {
      process.stderr.write(t("err.emitWithReplay") + "\n\n");
      return 1;
    }
    if (args.tui) {
      process.stderr.write(t("err.tuiWithReplay") + "\n\n");
      return 1;
    }
    if (args.only !== undefined) {
      process.stderr.write(t("err.onlyWithReplay") + "\n\n");
      return 1;
    }
    // 回放不走场景调度器（零模型、按脚本顺序执行），显式要求并发是矛盾的。
    // 只看显式开关：配置文件里的默认值不该让 `--replay` 变成错误。
    if (args.concurrency !== undefined && concurrency > 1) {
      process.stderr.write(t("err.concurrencyWithReplay") + "\n\n");
      return 1;
    }
    setDebug(args.debug);
    return await replayMode(args);
  }

  // ── 无参：TTY 下进交互模式（开一个可以随时 /run 加载用例文件的会话）──
  // 非 TTY（管道 / CI）维持原口径：打印帮助并退出码 1——那里没有「人看不看这个终端」
  // 这个判据，而 help 是它唯一的发现途径（ADR-0005 决策一）。
  if (!args.input) {
    const interactive = detectInteractive(args, false, false, concurrency);
    if (interactive.error) {
      process.stderr.write(t("err.param", { msg: interactive.error }) + "\n\n");
      return 1;
    }
    if (interactive.run) {
      setDebug(args.debug);
      return await runInteractiveSafely({}, args, concurrency);
    }
    process.stdout.write(buildHelp() + "\n");
    return 1;
  }

  setDebug(args.debug);
  const rawInput = cleanInput(args.input);
  const isFile = looksLikeScriptFile(rawInput) && existsSync(rawInput);
  if (!isFile && looksLikeScriptFile(rawInput)) {
    // 看起来是脚本文件路径但打不开：明确报错，避免把路径本身当成用例去"测试"
    process.stderr.write(t("err.notFound", { path: rawInput }) + "\n");
    return 1;
  }
  const sourceText = isFile ? readFileSync(rawInput, "utf8") : rawInput;
  // 展开占位符与「反查占位符」必须共用同一时刻：
  // 生成回放脚本时才能把模型看到的具体值（202609191146）还原成 ${timestamp}。
  const now = new Date();
  const input = expandVars(sourceText, now);
  const vars = captureRunVars(now);
  const hasScenarios = /^##\s+/m.test(input);
  const suiteMode = hasScenarios || args.suite;

  // ── `--only`：只跑其中一个场景 ──
  // 它是个批处理选项，且要求用例真的按「## 场景名」分隔：整份用例只有一个场景时，
  // 直接跑它就是它本身，`--only` 没有任何可指定的东西（见 ADR-0013）。
  let onlyPick: ScenarioSelection | undefined;
  let onlyTotal = 0;
  if (args.only !== undefined) {
    if (args.suite) {
      process.stderr.write(t("err.onlyWithSuite") + "\n\n");
      return 1;
    }
    if (!hasScenarios) {
      process.stderr.write(t("err.onlyNeedsScenarios") + "\n\n");
      return 1;
    }
    // 选不出来是**参数错误**，不是执行失败：在开跑前就判掉，走「参数错误 + 候选列表」
    // 这条口径，而不是让它从 try 里抛出去变成一坨栈。
    const all = splitScenarios(input);
    onlyTotal = all.length;
    try {
      onlyPick = selectScenario(all, args.only);
    } catch (err) {
      process.stderr.write(
        t("err.param", {
          msg: err instanceof Error ? err.message : String(err),
        }) + "\n\n",
      );
      return 1;
    }
  }

  // ── 旁路产物：`--no-side-outputs` 关掉「默认产出」，但显式 --emit-script 仍然生效 ──
  const prefs: SideOutputPrefs = args.noSideOutputs
    ? { htmlReport: false, replayScript: false }
    : readSideOutputPrefs();
  // 显式 --emit-script 永远先生效（ADR-0011 决策三）；否则看 /setting 的开关。
  // 默认生成时只贴「当前打开的用例文件」：内联文本没有落点，不生成（决策四）。
  const scriptPath = args.emitScript
    ? (args.emitScriptPath ?? defaultScriptPath(rawInput, isFile))
    : prefs.replayScript && isFile
      ? defaultScriptPath(rawInput, true)
      : undefined;

  // ── 交互模式：跑用例的同时可以提交新场景（会写回落点）──
  const interactive = detectInteractive(args, isFile, true, concurrency);
  if (interactive.error) {
    process.stderr.write(t("err.param", { msg: interactive.error }) + "\n\n");
    return 1;
  }
  if (interactive.run) {
    return await runInteractiveSafely(
      { path: isFile ? rawInput : undefined, text: sourceText },
      args,
      concurrency,
    );
  }

  info(t("log.startup"));
  info(
    isFile
      ? t("log.readScriptFile", { path: rawInput, chars: input.length })
      : t("log.readInline", { chars: input.length }),
  );
  info(
    (suiteMode ? t("log.runModeSuite") : t("log.runModeSingle")) +
      (args.session ? t("log.sessionNote", { id: args.session }) : "") +
      (args.debug ? t("log.debugNote") : ""),
  );
  if (onlyPick) {
    info(
      t("log.onlySelected", {
        selector: args.only ?? "",
        i: onlyPick.index,
        n: onlyTotal,
        name: onlyPick.scenario.name,
      }),
    );
  }
  if (scriptPath) {
    info(t("log.scriptWillEmit", { path: scriptPath }));
  }
  if (args.noSideOutputs) info(t("log.sideOutputsOff"));

  // 用量流水线：把「已经烧了多少」按行打到 stderr。自己跑（单场景 / `--only`）时
  // 直接回调；子进程跑时由子进程回调、父进程原样转出来（ADR-0013 第二步）。
  const usageSink: ((usage: TokenUsage) => void) | undefined = args.usageStream
    ? (usage) => process.stderr.write(formatUsageLine(usage) + "\n")
    : undefined;

  try {
    // 报告里的 `script` 字段保持现状：只有显式 `--emit-script` 才写进去；默认生成的那些
    // 路径由收尾的产物清单交代（ADR-0011 决策五），不往 stdout 报告里塞。
    const reportedScriptPath = args.emitScript ? scriptPath : undefined;
    let result: AgentRunResult;
    /** 套件模式下由父进程合并出的脚本；非套件路径仍走 result.recordings。 */
    let mergedScript: ReplayScript | null = null;
    /** 套件跑到一半模型不可达：报告照给，另补一条干净报错。 */
    let modelGone: { message: string; done: number } | undefined;
    if (onlyPick) {
      // ── 只跑其中一个场景 ──
      // 就走「在本进程里跑一个套件」这条路：输出仍是套件形态（只有一个场景），
      // 与父进程 fork 子进程时调用的那条路径完全同一份代码（ADR-0013 决策二）。
      result = await runSuite(renderScenarios([onlyPick.scenario]), {
        session: args.session,
        debug: args.debug,
        vars,
        scriptPath: reportedScriptPath,
        ...(usageSink ? { onUsage: usageSink } : {}),
      });
    } else if (suiteMode) {
      // ── 套件：每个场景一个子进程，父进程串行 fork 并汇总（ADR-0013）──
      const outcome = await runSuiteInChildren({
        script: input,
        // 子进程拿的是**未展开**的输入（文件路径或原文）：占位符由它自己展开，
        // 这样录制回放脚本时才能把具体值还回 `${...}` 写法。
        input: rawInput,
        sourcePath: isFile ? rawInput : null,
        session: args.session,
        debug: args.debug,
        timeoutMs: readScenarioTimeoutMs(),
        // 要让父进程合并脚本，才需要子进程把录制写到临时文件里。
        wantScript: scriptPath !== undefined,
        reportedScriptPath,
        usageStream: args.usageStream,
        concurrency,
        ...(usageSink ? { onChildUsage: usageSink } : {}),
      });
      result = {
        report: outcome.report,
        text: outcome.text,
        json: outcome.json,
        transcript: outcome.transcript,
        usage: outcome.usage,
        recordings: [],
      };
      mergedScript = outcome.script;
      modelGone = outcome.modelUnreachable;
    } else {
      result = await runAgent(input, {
        session: args.session,
        debug: args.debug,
        vars,
        scriptPath: reportedScriptPath,
        ...(usageSink ? { onUsage: usageSink } : {}),
      });
    }
    let scriptError: string | undefined;
    let scriptOutcome: ScriptOutcome;
    if (scriptPath) {
      try {
        // 套件模式用的是父进程从各子进程合并出来的那一份（ADR-0013 决策六）；
        // 其余路径仍然就地组装（单场景 / --only 都只有一个录制结果）。
        const script =
          mergedScript ??
          buildReplayScript(result.recordings, {
            sourcePath: isFile ? rawInput : null,
            sourceText,
          });
        writeReplayScript(scriptPath, script);
        scriptOutcome = { kind: "written", paths: [scriptPath] };
      } catch (err) {
        scriptError = err instanceof Error ? err.message : String(err);
        scriptOutcome = { kind: "failed", error: scriptError };
      }
    } else {
      // 开关开着却没有落点（内联文本）：说清楚为什么没有，别让「默认开着却没有」像坏了。
      scriptOutcome = prefs.replayScript
        ? { kind: "no-target", count: 1 }
        : { kind: "off" };
    }
    const out = args.json ? result.json : result.text;
    if (args.out) {
      writeFileSync(args.out, out + "\n");
    }
    process.stdout.write(out + "\n");
    emitSideOutputs(
      writeReportSideOutput(result.report, prefs),
      scriptOutcome,
      downloadedFiles(),
    );
    if (scriptError) {
      process.stderr.write(t("err.execFailed", { msg: scriptError }) + "\n");
      return 1;
    }
    if (modelGone) {
      // 套件跑到一半端点没了：报告照给（已完成场景的结论不该被丢掉），
      // 但必须让人一眼看到「这是环境不对，不是这批用例挂了」。
      process.stderr.write(
        `${modelGone.message}\n${t("err.modelUnreachableHintMid", {
          done: modelGone.done,
        })}\n`,
      );
      return 1;
    }
    return exitCodeFor(result.report);
  } catch (err) {
    // 并发 + 共享 session 是参数语义冲突：原样给出可执行的改法（去掉 --session / 把并发设为 1），
    // 一条用例都没跑，同样不该往 stdout 塞报告。
    if (err instanceof ConcurrencySessionConflictError) {
      process.stderr.write(err.message + "\n\n");
      return 1;
    }
    // 模型不可达是「环境不对」，不是「跑挂了」：给干净的报错 + 出路，不打印一坨栈。
    // 这时一条用例都没执行，stdout 上不该出现一份伪装成结果的报告。
    process.stderr.write(
      (err instanceof ModelUnreachableError
        ? `${err.message}\n${t("err.modelUnreachableHint")}`
        : t("err.execFailed", {
            msg: err instanceof Error ? (err.stack ?? String(err)) : String(err),
          })) + "\n",
    );
    return 1;
  }
}

// 只有作为主模块执行（pageqa bin）时才启动 CLI；被单测 import 时只取 parseArgs。
// 主模块判定要对符号链接归一化：全局安装常位于符号链接路径下
// （如 nvm 的 `node` 目录被软链成 `nodejs`，或 pnpm 的软链 store），此时
// `process.argv[1]` 是符号链接路径，而 `import.meta.url` 是 node 解析后的真实路径，
// 直接按 href 比较会不相等，导致 main() 不执行、CLI 静默退出。两边各取 realpath 再比即可。
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    const entry = realpathSync(process.argv[1]);
    const self = realpathSync(fileURLToPath(import.meta.url));
    if (entry === self) return true;
  } catch {
    // 解析失败（极少见）退回原始 href 比较，保持旧行为
  }
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(
        t("err.execFailed", {
          msg: err instanceof Error ? (err.stack ?? String(err)) : String(err),
        }) + "\n",
      );
      process.exit(1);
    });
}

// 兜底：main() 的 catch 只能捕获其 Promise 链内的错误。
// 工具执行、事件订阅回调等异步路径上抛出的异常不会被它捕获，
// 若不处理会直接静默崩溃（进程退出码非 0 但无任何报错信息）。
process.on("uncaughtException", (err) => {
  process.stderr.write(
    t("err.uncaught", {
      msg: err instanceof Error ? (err.stack ?? String(err)) : String(err),
    }) + "\n",
  );
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(
    t("err.unhandled", {
      msg: reason instanceof Error ? (reason.stack ?? String(reason)) : String(reason),
    }) + "\n",
  );
  process.exit(1);
});
