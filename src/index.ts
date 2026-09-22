#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, runSuite } from "./agent.js";
import {
  ensureConfigDir,
  CONFIG_PATH,
  loadConfig,
  readSavedLocale,
} from "./config.js";
import type { TestReport } from "./report.js";
import { runInteractive } from "./tui/app.js";
import {
  buildReplayScript,
  loadReplayScript,
  runReplayScript,
  sourceDriftNotice,
  writeReplayScript,
} from "./replay.js";
import {
  captureRunVars,
  expandVars,
  VAR_HELP,
  type RunVarValue,
} from "./vars.js";
import { info, setDebug } from "./log.js";
import { parseLocale, setLocale, t } from "./i18n.js";

interface CliArgs {
  input?: string;
  session?: string;
  json: boolean;
  out?: string;
  suite: boolean;
  initConfig: boolean;
  help: boolean;
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
 * 内联文本没有源文件，落到当前工作目录。
 */
function defaultScriptPath(rawInput: string, isFile: boolean): string {
  if (!isFile) return "pageqa.replay.json";
  return join(
    dirname(rawInput),
    basename(rawInput, extname(rawInput)) + ".replay.json",
  );
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
    if (!isFile) {
      return { run: false, error: t("err.tuiNeedsFile") };
    }
    if (!tty) {
      return { run: false, error: t("err.tuiNeedsTty") };
    }
    return { run: true };
  }
  if (args.noTui || process.env.PAGEQA_NO_TUI) return { run: false };
  // 自动识别：只在两个流都是 TTY、未给 --json、且确实是源用例文件时才进。
  // 内联文本不进——没有源用例文件可写回（见 ADR-0002 决策七）。
  return { run: Boolean(tty && !args.json && isFile) };
}

/**
 * 交互模式入口：把控制权交给 TUI，退出后回到批处理口径输出汇总报告。
 *
 * 回放脚本必须在**写回完成之后**再生成：`source.hash` 依据的是源用例文件内容，
 * 而交互过程会把追加场景写进它——沿用启动时读到的那份，会让第一次回放就报「源用例已变更」。
 */
async function interactiveMode(
  sourcePath: string,
  sourceText: string,
  now: Date,
  vars: RunVarValue[],
  args: CliArgs,
  scriptPath: string | undefined,
): Promise<number> {
  info(t("log.startupInteractive"));
  const result = await runInteractive(sourceText, {
    sourcePath,
    sourceText,
    vars,
    now,
    debug: args.debug,
    scriptPath,
  });

  if (result.writtenBack > 0) {
    info(t("log.wroteBackScenarios", { n: result.writtenBack, path: sourcePath }));
  }
  if (scriptPath) {
    const finalSource = readFileSync(sourcePath, "utf8");
    const script = buildReplayScript(result.recordings, {
      sourcePath,
      sourceText: finalSource,
    });
    writeReplayScript(scriptPath, script);
    const steps = script.scenarios.reduce((n, s) => n + s.steps.length, 0);
    info(
      t("log.replayScriptGeneratedInteractive", {
        path: scriptPath,
        scenes: script.scenarios.length,
        steps,
      }),
    );
    info(t("log.replayNext", { path: scriptPath }));
  }

  const out = args.json ? result.json : result.text;
  if (args.out) writeFileSync(args.out, out + "\n");
  process.stdout.write(out + "\n");
  return exitCodeFor(result.report);
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

  if (!args.input) {
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
  const scriptPath = args.emitScript
    ? (args.emitScriptPath ?? defaultScriptPath(rawInput, isFile))
    : undefined;

  // ── 交互模式：跑用例的同时可以提交新场景（会写回源用例文件）──
  const interactive = detectInteractive(args, isFile);
  if (interactive.error) {
    process.stderr.write(t("err.param", { msg: interactive.error }) + "\n\n");
    return 1;
  }
  if (interactive.run) {
    try {
      return await interactiveMode(rawInput, sourceText, now, vars, args, scriptPath);
    } catch (err) {
      process.stderr.write(
        t("err.execFailed", {
          msg: err instanceof Error ? (err.stack ?? String(err)) : String(err),
        }) + "\n",
      );
      return 1;
    }
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
    const result = suiteMode
      ? await runSuite(input, {
          session: args.session,
          debug: args.debug,
          vars,
          scriptPath,
        })
      : await runAgent(input, {
          session: args.session,
          debug: args.debug,
          vars,
          scriptPath,
        });
    if (scriptPath) {
      const script = buildReplayScript(result.recordings, {
        sourcePath: isFile ? rawInput : null,
        sourceText,
      });
      writeReplayScript(scriptPath, script);
      const steps = script.scenarios.reduce((n, s) => n + s.steps.length, 0);
      info(
        t("log.replayScriptGenerated", {
          path: scriptPath,
          scenes: script.scenarios.length,
          steps,
        }),
      );
      info(t("log.replayNext", { path: scriptPath }));
    }
    const out = args.json ? result.json : result.text;
    if (args.out) {
      writeFileSync(args.out, out + "\n");
    }
    process.stdout.write(out + "\n");
    return exitCodeFor(result.report);
  } catch (err) {
    process.stderr.write(
      t("err.execFailed", {
        msg: err instanceof Error ? (err.stack ?? String(err)) : String(err),
      }) + "\n",
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
