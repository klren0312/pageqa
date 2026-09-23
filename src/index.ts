#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelUnreachableError, runAgent, runSuite } from "./agent.js";
import {
  ensureConfigDir,
  CONFIG_PATH,
  loadConfig,
  readSavedLocale,
  readSideOutputPrefs,
} from "./config.js";
import type { TestReport } from "./report.js";
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
  /** `--tui`：显式要求进入交互模式。 */
  tui: boolean;
  /** `--no-tui`：显式拒绝交互模式（本机只想看滚动日志时用）。 */
  noTui: boolean;
  /** `--locale <zh|en>`：界面/日志/报告的显示语种（默认 zh）。 */
  locale: string;
  /** 参数解析错误（如带值选项缺少参数）；有值时 main 会提示并退出。 */
  error?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    json: false,
    suite: false,
    initConfig: false,
    help: false,
    version: false,
    debug: false,
    emitScript: false,
    semantic: false,
    failFast: false,
    tui: false,
    noTui: false,
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
        if (v === undefined) {
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
      case "--init-config":
        args.initConfig = true;
        break;
      case "--locale": {
        const v = argv[++i];
        if (v === undefined) {
          args.error = t("err.localeRequired", { arg: "--locale" });
          return args;
        }
        args.locale = v;
        setLocale(parseLocale(v));
        break;
      }
      case "--out": {
        const v = argv[++i];
        if (v === undefined) {
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
        if (v === undefined) {
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
      case "--tui":
        args.tui = true;
        break;
      case "--no-tui":
        args.noTui = true;
        break;
      default:
        if (!a.startsWith("-")) {
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
 * - 其余（`./replay`、`out.json`、`reports/run1`）→ 当作输出路径。
 */
function looksLikeScriptPath(token: string): boolean {
  if (token.startsWith("-")) return false;
  if (/\.(md|txt)$/i.test(token)) return false;
  return /^[A-Za-z0-9_./\\-]+$/.test(token);
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
): { run: boolean; error?: string } {
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (args.tui) {
    if (args.noTui)
      return { run: false, error: t("err.tuiConflict") };
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
  now: Date,
  vars: RunVarValue[],
  args: CliArgs,
): Promise<number> {
  info(t("log.startupInteractive"));
  const result = await runInteractive(source.text ?? "", {
    sourcePath: source.path,
    vars,
    now,
    debug: args.debug,
    scriptPath: args.emitScriptPath,
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
  emitSideOutputs(reportOutcome, scriptOutcome);
  if (scriptError) {
    process.stderr.write(t("err.execFailed", { msg: scriptError }) + "\n");
    return 1;
  }
  return exitCodeFor(result.report);
}

/** 交互模式的统一收尾：把抛出的异常翻成可读报错（而不是一个裸栈）。 */
async function runInteractiveSafely(
  source: { path?: string; text?: string },
  now: Date,
  vars: RunVarValue[],
  args: CliArgs,
): Promise<number> {
  try {
    return await interactiveMode(source, now, vars, args);
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
    });
    const out = args.json ? result.json : result.text;
    if (args.out) writeFileSync(args.out, out + "\n");
    process.stdout.write(out + "\n");
    // 回放用的是现成的脚本、不产出脚本：清单里不列脚本行（ADR-0011 决策五）。
    emitSideOutputs(writeReportSideOutput(result.report), { kind: "na" });
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
    setDebug(args.debug);
    return await replayMode(args);
  }

  // ── 无参：TTY 下进交互模式（开一个可以随时 /run 加载用例文件的会话）──
  // 非 TTY（管道 / CI）维持原口径：打印帮助并退出码 1——那里没有「人看不看这个终端」
  // 这个判据，而 help 是它唯一的发现途径（ADR-0005 决策一）。
  if (!args.input) {
    const interactive = detectInteractive(args, false, false);
    if (interactive.error) {
      process.stderr.write(t("err.param", { msg: interactive.error }) + "\n\n");
      return 1;
    }
    if (interactive.run) {
      setDebug(args.debug);
      // 占位符时刻取自会话启动那一刻：`/run` 加载的场景与追加场景共用它（ADR-0005 决策八）。
      const now = new Date();
      return await runInteractiveSafely({}, now, captureRunVars(now), args);
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
  const prefs = readSideOutputPrefs();
  // 显式 --emit-script 永远先生效（ADR-0011 决策三）；否则看 /setting 的开关。
  // 默认生成时只贴「当前打开的用例文件」：内联文本没有落点，不生成（决策四）。
  const scriptPath = args.emitScript
    ? (args.emitScriptPath ?? defaultScriptPath(rawInput, isFile))
    : prefs.replayScript && isFile
      ? defaultScriptPath(rawInput, true)
      : undefined;

  // ── 交互模式：跑用例的同时可以提交新场景（会写回落点）──
  const interactive = detectInteractive(args, isFile, true);
  if (interactive.error) {
    process.stderr.write(t("err.param", { msg: interactive.error }) + "\n\n");
    return 1;
  }
  if (interactive.run) {
    return await runInteractiveSafely(
      { path: isFile ? rawInput : undefined, text: sourceText },
      now,
      vars,
      args,
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
  if (scriptPath) {
    info(t("log.scriptWillEmit", { path: scriptPath }));
  }

  try {
    // 报告里的 `script` 字段保持现状：只有显式 `--emit-script` 才写进去；默认生成的那些
    // 路径由收尾的产物清单交代（ADR-0011 决策五），不往 stdout 报告里塞。
    const reportedScriptPath = args.emitScript ? scriptPath : undefined;
    const result = suiteMode
      ? await runSuite(input, {
          session: args.session,
          debug: args.debug,
          vars,
          scriptPath: reportedScriptPath,
        })
      : await runAgent(input, {
          session: args.session,
          debug: args.debug,
          vars,
          scriptPath: reportedScriptPath,
        });
    let scriptError: string | undefined;
    let scriptOutcome: ScriptOutcome;
    if (scriptPath) {
      try {
        const script = buildReplayScript(result.recordings, {
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
    emitSideOutputs(writeReportSideOutput(result.report, prefs), scriptOutcome);
    if (scriptError) {
      process.stderr.write(t("err.execFailed", { msg: scriptError }) + "\n");
      return 1;
    }
    return exitCodeFor(result.report);
  } catch (err) {
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
