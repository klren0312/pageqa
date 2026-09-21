#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, runSuite } from "./agent.js";
import { ensureConfigDir, CONFIG_PATH, loadConfig } from "./config.js";
import {
  buildReplayScript,
  loadReplayScript,
  runReplayScript,
  sourceDriftNotice,
  writeReplayScript,
} from "./replay.js";
import { captureRunVars, expandVars, VAR_HELP } from "./vars.js";
import { info, setDebug } from "./log.js";

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
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--session": {
        const v = argv[++i];
        if (v === undefined) {
          args.error = "--session 需要一个 session id 参数";
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
      case "--out": {
        const v = argv[++i];
        if (v === undefined) {
          args.error = "--out 需要一个文件路径参数";
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
          args.error = "--replay 需要一个回放脚本路径";
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
      default:
        if (!a.startsWith("-")) {
          // 只接受一个用例输入。此前是「后者覆盖前者」，`--emit-script ./replay`
          // 这类写法一旦没被识别成输出路径，就会静默把用例换成 `./replay` 去跑，
          // 看起来像正常启动、实际测的是完全无关的文本。这里改为直接报错。
          if (args.input !== undefined) {
            args.error =
              `多余的位置参数：${a}（只接受一个用例输入` +
              `；路径含空格请用引号包裹，输出路径请放在 --emit-script 之后）`;
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

const HELP = `pageqa - 自然语言驱动的页面测试工具（pi-agent-core + browserskill）

用法:
  pageqa [options] <input>

  <input>          自然语言脚本文件(.md/.txt，路径含空格请用引号包裹)，
                   或用引号包裹的内联文本
                  只接受一个用例输入；多给一个会直接报错
                  脚本中可用『## 场景名』分隔多个测试场景，自动批量运行
                  路径中粘贴带来的不可见字符（Bidi/零宽）会被自动清理；
                  若路径以 .md/.txt 结尾但文件不存在，会直接报错而非当作内联文本

选项:
  --session <id>   指定已存在的 bsk session（默认自动创建）
                  无论新建还是复用，用例跑完后都会自动关闭该 session
                  并关掉它对应的浏览器窗口（Agent Window）
  --json           输出 JSON 报告
  --suite          强制按多场景套件运行（即使只有一个场景）
  --emit-script [path]
                   运行结束后把本次成功的操作序列固化成回放脚本（Replay Script）
                  不给 path 时写到源用例同目录 <用例名>.replay.json
                  （内联文本写 ./pageqa.replay.json）
                  path 建议写成路径形式（如 ./replay、reports/run1.json），
                  含空白请用引号包裹；紧跟其后的若是 .md/.txt 或含空白的文本，
                  会被当作用例输入而不是输出路径
                  无论 PASS/FAIL 都会生成，便于排查与续写
  --replay <file>  零模型回放已有的回放脚本（详见下方「回放脚本」）
  --semantic       回放时断言改用 Jev 语义判断（默认字符串包含）
  --init-config    在用户目录创建/重置配置文件
  --out <file>     将报告写入文件
  --debug          显示调试日志（bsk 命令、快照体积、上下文裁剪、Jev 请求详情）
  -h, --help       显示帮助

回放脚本（零模型重跑同一用例）:
  pageqa --replay <file.replay.json> [--session <id>] [--json] [--semantic] [--fail-fast]
                   按脚本逐步驱动浏览器，**不调用任何大模型**，断言默认走字符串包含
                   --semantic 可改用 Jev 语义判断（需已在配置里启用 Jev）
                   元素定位用录制时的语义定位符在当次快照里重新解析，
                   因此页面小幅调整后脚本仍可命中；源用例变更会在 stderr 提示
                   --fail-fast 任一失败即停止该场景；默认会跑完剩余步骤，
                   以便一次拿到整条用例的完整健康报告（失败仍会让退出码非零）

进度日志:
  - 运行进度会带时间戳实时输出到 stderr（bsk daemon 启动、session、每一步工具调用、
    续跑与最终结论等），stdout 只输出最终报告，两者互不干扰；长流程可据此判断进行到哪一步。
  - 加 --debug 可看到更细的 bsk 命令与耗时明细。

脚本占位符:
${VAR_HELP}

配置:
  - 首次运行会在用户目录自动创建配置文件：~/.pageqa/config.json
    （Windows: %USERPROFILE%\\.pageqa\\config.json）
  - 可编辑该文件设置 baseUrl / apiKey / model
  - 也可用环境变量覆盖（优先级高于配置文件）：
      PAGEQA_LLM_BASE_URL / PAGEQA_LLM_API_KEY / PAGEQA_LLM_MODEL
  - Jev 语义判断（可选，用于增强断言精度；仅在字面匹配未命中时调用）：
      PAGEQA_JEV_ENABLED=true   启用 Jev 辅助断言
      PAGEQA_JEV_API_KEY=<key>  TypeSafe API 密钥
      PAGEQA_JEV_MODEL=<model>  Jev 模型（默认 jev-latest）
      PAGEQA_JEV_THRESHOLD=<n>  判定阈值 0-1（默认 0.5）
  - 运行 pageqa --init-config 可显式创建/重置配置文件

前置:
  - 已安装并启动 bsk daemon，且连接了一个浏览器（bsk session start）
  - 有一个可用的 OpenAI 兼容 LLM 端点（默认 http://127.0.0.1:3000/v1，模型 hunyuan-2.0-instruct，
    可通过 ~/.pageqa/config.json 或 PAGEQA_LLM_* 环境变量覆盖）

示例:
  pageqa --session ulao "打开 https://example.com 并断言标题包含 Example"
  pageqa examples/smoke.md --json
  pageqa examples/smoke.md --debug
`;

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

  info("[pageqa] ===== 回放启动 =====");
  const drift = sourceDriftNotice(script);
  if (drift) info(`[pageqa] 警告：${drift}`);

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
      `回放失败: ${err instanceof Error ? err.stack : String(err)}\n`,
    );
    return 1;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(`参数错误：${args.error}\n\n`);
    process.stdout.write(HELP + "\n");
    return 1;
  }
  if (args.help) {
    process.stdout.write(HELP + "\n");
    return 0;
  }
  if (args.initConfig) {
    const dir = ensureConfigDir();
    loadConfig(); // 触发配置文件创建
    process.stdout.write(`配置文件已创建/确认：${CONFIG_PATH}\n目录：${dir}\n`);
    process.stdout.write(
      `当前生效配置：${JSON.stringify(loadConfig(), null, 2)}\n`,
    );
    return 0;
  }
  // ── 回放模式：零模型执行已有脚本（与用例输入互斥）──
  if (args.replay) {
    if (args.input) {
      process.stderr.write("参数错误：--replay 不能与用例输入同时使用\n\n");
      return 1;
    }
    if (args.emitScript) {
      process.stderr.write(
        "参数错误：--emit-script 用于生成回放脚本，不能与 --replay 同时使用\n\n",
      );
      return 1;
    }
    setDebug(args.debug);
    return await replayMode(args);
  }

  if (!args.input) {
    process.stdout.write(HELP + "\n");
    return 1;
  }

  setDebug(args.debug);
  const rawInput = cleanInput(args.input);
  const isFile = looksLikeScriptFile(rawInput) && existsSync(rawInput);
  if (!isFile && looksLikeScriptFile(rawInput)) {
    // 看起来是脚本文件路径但打不开：明确报错，避免把路径本身当成用例去"测试"
    process.stderr.write(
      `找不到脚本文件：${rawInput}\n` +
        `  - 请确认路径存在且拼写正确\n` +
        `  - 若路径含空格，请用引号包裹（如 "C:\\dir\\my case.md"）\n` +
        `  - 若只想跑内联文本，请不要让文本以 .md/.txt 结尾\n`,
    );
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

  info("[pageqa] ===== 启动 =====");
  info(
    `[pageqa] 已读取${isFile ? `脚本文件 ${rawInput}` : "内联用例"}（${input.length} 字符）`,
  );
  info(
    `[pageqa] 运行模式：${suiteMode ? "多场景套件" : "单场景"}` +
      `${args.session ? `，session=${args.session}` : ""}` +
      `${args.debug ? "，debug=on（stderr 含调试明细）" : ""}`,
  );
  if (scriptPath) {
    info(`[pageqa] 运行结束将生成回放脚本：${scriptPath}`);
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
        `[pageqa] 回放脚本已生成：${scriptPath}` +
          `（${script.scenarios.length} 个场景，共 ${steps} 步）`,
      );
      info(`[pageqa] 下次可零模型回放：pageqa --replay ${scriptPath}`);
    }
    const out = args.json ? result.json : result.text;
    if (args.out) {
      writeFileSync(args.out, out + "\n");
    }
    process.stdout.write(out + "\n");
    return result.report.status === "pass" ? 0 : 1;
  } catch (err) {
    process.stderr.write(
      `执行失败: ${err instanceof Error ? err.stack : String(err)}\n`,
    );
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `执行失败: ${err instanceof Error ? err.stack : String(err)}\n`,
    );
    process.exit(1);
  });

// 兜底：main() 的 catch 只能捕获其 Promise 链内的错误。
// 工具执行、事件订阅回调等异步路径上抛出的异常不会被它捕获，
// 若不处理会直接静默崩溃（进程退出码非 0 但无任何报错信息）。
process.on("uncaughtException", (err) => {
  process.stderr.write(
    `执行失败（未捕获异常）: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(
    `执行失败（未处理的 Promise rejection）: ${
      reason instanceof Error ? reason.stack : String(reason)
    }\n`,
  );
  process.exit(1);
});
