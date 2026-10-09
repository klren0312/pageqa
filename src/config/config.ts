import { homedir } from "node:os";
import { join } from "node:path";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

/**
 * 用户级配置：在用户主目录下创建配置目录与文件，持久化 LLM 后端设置。
 *
 * 配置目录：~/.pageqa（Windows 为 %USERPROFILE%/.pageqa）
 * 配置文件：config.json，字段：
 *   - baseUrl:       反代/兼容 OpenAI 的 base URL
 *   - apiKey:        访问密钥
 *   - model:         模型 ID
 *   - modelProvider: 模型所属 provider（自定义端点 `pageqa`，或内置 provider 如 `anthropic`）
 *
 * 优先级（高 -> 低）：
 *   环境变量 PAGEQA_LLM_*  >  用户配置文件  >  内置默认值
 *
 * 首次运行（配置文件不存在）会自动创建带默认值的配置文件，便于用户日后修改。
 */

import type { JevConfig } from "../llm/jev.js";

/**
 * 自定义 OpenAI 兼容端点的 provider id。
 *
 * 之所以在配置层也定义一份：`modelProvider` 的默认值必须能在不 import 模型目录
 * （会拉起一整棵内置 provider 依赖树）的前提下确定，因此这里不能反向依赖 models.ts。
 * models.ts 会 re-export 同一个常量，两处必须保持一致。
 */
export const PAGEQA_PROVIDER_ID = "pageqa";

export interface PageQaConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * 模型所属 provider。默认 `pageqa`（自定义端点，走 baseUrl/apiKey）；
   * 交互模式里 /login 登录内置 provider 后 /model 选定，会写回这里，下次启动即生效。
   */
  modelProvider: string;
  /**
   * 「怎么显式关闭端点的思考模式」（pi-ai 的 `compat.thinkingFormat`）。
   *
   * **默认就是关**：不配时按模型 id 自动判断该端点认哪个关闭字段（见 {@link guessThinkingFormat}），
   * 因此混元 / DeepSeek / Qwen / GLM 这类混合推理模型**开箱即关**——它们在 OpenAI 兼容端点上
   * 默认开着思考，模型会先吐一大段思考内容：慢、烧 token，还把 agent 的步骤编号与结论搅乱。
   *
   * 想改写法就填 {@link THINKING_FORMATS} 里的取值（各自发出的字段见 {@link THINKING_OFF_FIELD}）；
   * 填 `none`/`off` 表示「不要关」（请求里不带任何思考相关字段，端点用它自己的默认）；
   * 填不认识的值会如实提示并退回自动判断。
   *
   * 两条兜底让「默认关」不至于弄坏谁：字段按模型 id 猜（认不出就用最常见的
   * `deepseek` 约定），而**严格端点直接拒绝**时探活会自动去掉字段重试一次（见 models.ts）。
   */
  thinkingFormat?: string;
  jev: JevConfig;
  /** 界面/日志/报告语种（"zh" | "en"）；交互模式 /setting 会写回这里。 */
  locale?: string;
  /**
   * 是否生成 HTML 测试报告（**旁路产物**之一）。**缺失视为开**。
   *
   * 刻意不放进 DEFAULTS：写回配置时会先把 DEFAULTS 摊平进文件，把默认值放进
   * DEFAULTS 等于每次改语言都往用户配置里补两个他从没碰过的布尔值（见 ADR-0011 决策一）。
   */
  htmlReport?: boolean;
  /** 是否默认生成回放脚本（**旁路产物**之一）。**缺失视为开**，理由同上。 */
  replayScript?: boolean;
  /**
   * 下载产物的落盘目录：`download` 动作捕获到的文件写在这里。**缺失用默认目录**
   * （`~/.pageqa/downloads`），理由同上——不放进 DEFAULTS。
   *
   * 相对路径按当前工作目录解析；不存在的目录由捕获时按需创建。
   */
  downloadDir?: string;
  /**
   * 断言成立后是否清理捕获到的文件。**缺失视为开**（通过就清掉，回归不堆垃圾）。
   *
   * 只作用于「默认落盘路径 + 断言成立」这一种情况：用例显式给了 `out`、或断言不成立
   * （失败时的文件正是排查对象）时一律保留。要留档就把这项设为 false，或在用例里写 `out`。
   */
  downloadCleanup?: boolean;
  /**
   * 场景收尾是否自动截一张图并写进报告。**缺失视为开**，理由同 `downloadCleanup`：
   * 真实用例不会写「截图留证」这一步，而失败现场恰恰最需要它。显式写 `false` 可关。
   */
  autoScreenshot?: boolean;
  /**
   * 单个场景的执行时长上限（毫秒）。**缺失视为不限**（0），理由同 `htmlReport`：
   * 它是个默认应该关着、只有 CI 才需要的门禁。见 ADR-0013 决策八。
   */
  scenarioTimeoutMs?: number;
  /**
   * 同时执行几个场景（**上限**，不是要求）。**缺失视为 1**（逐个跑），理由同上：
   * 串行是「场景之间可能有隐含顺序依赖」的默认保护，并行必须由人显式声明。
   * 见 ADR-0013 决策三。
   */
  concurrency?: number;
}

const DEFAULTS: PageQaConfig = {
  baseUrl: "http://127.0.0.1:3000/v1",
  apiKey: "codebuddy-proxy-key",
  model: "hunyuan-2.0-instruct",
  modelProvider: PAGEQA_PROVIDER_ID,
  jev: {
    enabled: false,
    apiKey: "",
    model: "jev-latest",
    threshold: 0.5,
  },
  locale: "zh",
};

export const CONFIG_DIR = join(homedir(), ".pageqa");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

/**
 * 下载产物的默认落盘目录。
 *
 * 刻意不落在当前工作目录（那是用例文件与报告的所在地，下载文件是**被测网站给的字节**，
 * 混进去既容易误提交、也容易和用例同名文件撞上），也不落在用户的浏览器下载目录
 * （pageqa 未必知道它在哪，且会污染用户自己的下载历史）。
 */
export const DEFAULT_DOWNLOAD_DIR = join(CONFIG_DIR, "downloads");

/** 读取配置：合并 默认值 < 用户文件 < 环境变量。返回最终生效配置。 */
export function loadConfig(): PageQaConfig {
  const fromFile = readConfigFile();
  const fromJev: Partial<JevConfig> = fromFile.jev ?? {};
  return {
    baseUrl:
      process.env.PAGEQA_LLM_BASE_URL ?? fromFile.baseUrl ?? DEFAULTS.baseUrl,
    apiKey:
      process.env.PAGEQA_LLM_API_KEY ?? fromFile.apiKey ?? DEFAULTS.apiKey,
    model: process.env.PAGEQA_LLM_MODEL ?? fromFile.model ?? DEFAULTS.model,
    modelProvider:
      process.env.PAGEQA_LLM_PROVIDER ??
      fromFile.modelProvider ??
      DEFAULTS.modelProvider,
    // 原样透传，取值校验统一放在 llm.ts 的 normalizeThinkingFormat（只有那里会发这个字段）
    thinkingFormat:
      process.env.PAGEQA_LLM_THINKING_FORMAT ?? fromFile.thinkingFormat,
    jev: {
      enabled: (() => {
        if (process.env.PAGEQA_JEV_ENABLED !== undefined) {
          return process.env.PAGEQA_JEV_ENABLED.toLowerCase() === "true";
        }
        return fromJev.enabled ?? DEFAULTS.jev.enabled;
      })(),
      apiKey:
        process.env.PAGEQA_JEV_API_KEY ?? fromJev.apiKey ?? DEFAULTS.jev.apiKey,
      model:
        process.env.PAGEQA_JEV_MODEL ?? fromJev.model ?? DEFAULTS.jev.model,
      threshold: (() => {
        const env = process.env.PAGEQA_JEV_THRESHOLD;
        if (env != null) {
          const n = Number(env);
          if (!isNaN(n)) return n;
        }
        return fromJev.threshold ?? DEFAULTS.jev.threshold;
      })(),
    },
    locale: process.env.PAGEQA_LOCALE ?? fromFile.locale ?? DEFAULTS.locale,
  };
}

/**
 * 只读地解析配置文件原文（**不会**创建文件）；不存在或损坏时返回空对象。
 *
 * 单独开这个口子，是为了让「按配置决定行为」这类读取不必先落一个配置文件——
 * `--help`、参数报错、旁路产物开关都不该产生磁盘副作用。
 */
function readRawConfig(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const parsed: unknown = JSON.parse(readConfigText());
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * 读配置文件文本并剥掉 BOM。
 *
 * Windows 上的记事本、PowerShell 的 `Set-Content -Encoding utf8`、以及不少编辑器保存 JSON
 * 时会带上 UTF-8 BOM，而 `JSON.parse` 见到 BOM 直接抛错——那会让**整份配置**被当成空的，
 * 用户「明明关了开关却还是生成」的困惑就来自这里。
 */
function readConfigText(): string {
  return readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "");
}

/** 只读地取配置文件里已保存的语种（**不会**创建文件）。 */
export function readSavedLocale(): string | undefined {
  const raw = readRawConfig();
  return typeof raw.locale === "string" ? raw.locale : undefined;
}

/** 旁路产物的两个开关（见 ADR-0011）：默认全开，缺失即视为开。 */
export interface SideOutputPrefs {
  /** 生成 HTML 测试报告到 `pageqa-report/`。 */
  htmlReport: boolean;
  /** 默认生成回放脚本（贴当前打开的用例文件；`--emit-script` 显式请求优先）。 */
  replayScript: boolean;
}

/** 旁路产物开关的默认值：两个都开。 */
export const SIDE_OUTPUT_DEFAULTS: SideOutputPrefs = {
  htmlReport: true,
  replayScript: true,
};

/**
 * 旁路产物全关：供 CLI 的 `--no-side-outputs` 使用（见 ADR-0011 决策三）。
 *
 * 与 `SIDE_OUTPUT_DEFAULTS` 拆开：前者是「缺省即开」的兜底，后者是「显式全关」。
 * 两者都不是用户配置文件里会落地的形态——`--no-side-outputs` 不写配置，只作用于当次运行。
 */
export const SIDE_OUTPUTS_DISABLED: SideOutputPrefs = {
  htmlReport: false,
  replayScript: false,
};

/**
 * 只读地取旁路产物开关（**不会**创建文件）；键缺失或类型不对即视为默认的「开」。
 *
 * 只认布尔值：配置文件是用户手写的，`"false"` 这种字符串不该被当成关——
 * 静默地把字符串当真会让人以为「我明明关了」。
 */
export function readSideOutputPrefs(): SideOutputPrefs {
  const raw = readRawConfig();
  return {
    htmlReport:
      typeof raw.htmlReport === "boolean"
        ? raw.htmlReport
        : SIDE_OUTPUT_DEFAULTS.htmlReport,
    replayScript:
      typeof raw.replayScript === "boolean"
        ? raw.replayScript
        : SIDE_OUTPUT_DEFAULTS.replayScript,
  };
}

/**
 * 只读地取下载产物目录（**不会**创建文件）；未配置或类型不对时用默认目录。
 *
 * 与 `readSideOutputPrefs` 同一个口子：读配置决定行为，不产生磁盘副作用。
 */
export function readDownloadDir(): string {
  const raw = readRawConfig();
  const configured =
    typeof raw.downloadDir === "string" ? raw.downloadDir.trim() : "";
  return configured || DEFAULT_DOWNLOAD_DIR;
}

/**
 * 只读地取「断言成立后是否清理下载产物」（**不会**创建文件）。
 *
 * **缺失视为开**，与 ADR-0011 决策一同一套口径；只认布尔值，字符串 `"false"` 不当成关
 * （静默把字符串当真会让人以为「我明明关了」）。
 */
export function readDownloadCleanup(): boolean {
  const raw = readRawConfig();
  return typeof raw.downloadCleanup === "boolean" ? raw.downloadCleanup : true;
}

/**
 * 只读地取「场景收尾是否自动截一张图」（**不会**创建文件）。
 *
 * **缺失视为开**：真实用例不会专门写一行「截图留证」，而失败现场恰恰最需要它——
 * 实测（2026-09-29）用真实业务用例跑完，报告里一张图都没有，因为用例里根本没写「截图」。
 * 要关掉（例如 CI 里不愿产出图片文件）就显式写 `false`。与 `downloadCleanup` 同一套口径：
 * 只认布尔值，字符串 `"false"` 不当成关。
 */
export function readAutoScreenshot(): boolean {
  const raw = readRawConfig();
  return typeof raw.autoScreenshot === "boolean" ? raw.autoScreenshot : true;
}

/**
 * 只读地取「单个场景的执行时长上限」（毫秒；`0` 表示不限）。
 *
 * **默认不限**：README 把「十几分钟的长流程」当常态，凭空定一个默认上限就是给自己
 * 造一个新的失败来源。既有的超时都是「贴着单条命令」的（bsk 命令默认 60s、download
 * 等待上限可配、`wait-ms` 按等待时长放宽），场景级上限是**新增的一层**，不做默认值猜测。
 *
 * 只认正数：手写成字符串 `"300000"` 也接受（配置文件是手写的），但类型不对、非数字、
 * 非正数一律按「不限」处理——宁可不管，也不要因为一个坏值把长流程半路掐死。
 */
export function readScenarioTimeoutMs(): number {
  const raw = readRawConfig();
  const value = process.env.PAGEQA_SCENARIO_TIMEOUT ?? raw.scenarioTimeoutMs;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * 只读地取「同时跑几个场景」的上限：`PAGEQA_CONCURRENCY` > 配置文件 > 1。
 *
 * **默认 1（逐个跑）**：串行是「场景之间可能有隐含顺序依赖」的默认保护
 * （「创建 → 编辑 → 删除」这种用例并行跑不是失败，是数据错乱，更难查）。
 * 并行等于用户声明「这些场景互不依赖」，这个声明只能由人来做。
 *
 * 只认正整数；坏值一律回落到 1，而不是猜一个并发度——猜错的代价是同时开出一堆
 * 浏览器窗口。上限由 `MAX_CONCURRENCY` 把关（那条在 CLI 里报错，这里不做静默截断）。
 */
export function readConcurrency(): number {
  const value = process.env.PAGEQA_CONCURRENCY ?? readRawConfig().concurrency;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/**
 * 把并发度持久化（保留其它字段）；供交互模式 /setting 的「并发量」使用。
 *
 * 与 `saveSideOutputPref` 同一个口子：它只负责写文件，**本次会话立即生效**是调用方
 * （TUI 的队列读的是内存里那个值）的事——两件事分开，谁也不替谁假装。
 */
export function saveConcurrency(n: number): void {
  updateUserConfig({ concurrency: n });
}

/** 把某一个旁路产物开关持久化（保留其它字段）；供交互模式 /setting 使用。 */
export function saveSideOutputPref(
  key: keyof SideOutputPrefs,
  enabled: boolean,
): void {
  updateUserConfig({ [key]: enabled });
}

/**
 * `compat.thinkingFormat` 的合法取值（pi-ai 的并集，见 node_modules/@earendil-works/pi-ai）。
 *
 * 它决定的不是「思考强度」，而是**在请求体里用什么写法告诉端点「别思考」**——各家
 * OpenAI 兼容端点的开关字段并不统一，没有一个字段是通用的。
 */
export const THINKING_FORMATS = [
  "openai",
  "openrouter",
  "deepseek",
  "together",
  "baseten",
  "zai",
  "qwen",
  "chat-template",
  "qwen-chat-template",
  "string-thinking",
  "ant-ling",
] as const;

export type ThinkingFormat = (typeof THINKING_FORMATS)[number];

/**
 * 每个取值在「**不**请求思考」时请求体里实际发出的字段。
 *
 * pageqa 从不请求思考档位，所以配了 thinkingFormat 的效果就是「每次请求显式关掉思考」。
 * 空串 = 该格式发不出关闭开关（只在请求了思考档位时才带字段），配了等于没配——
 * 这也是启动时要如实说出来的原因。
 */
export const THINKING_OFF_FIELD: Record<ThinkingFormat, string> = {
  openai: "",
  openrouter: 'reasoning: { effort: "none" }',
  deepseek: 'thinking: { type: "disabled" }',
  together: "reasoning: { enabled: false }",
  baseten: "",
  zai: 'thinking: { type: "disabled" }',
  qwen: "enable_thinking: false",
  "chat-template": "chat_template_kwargs（还需另配 chatTemplateKwargs）",
  "qwen-chat-template":
    "chat_template_kwargs: { enable_thinking: false, preserve_thinking: true }",
  "string-thinking": 'thinking: "none"',
  "ant-ling": "",
};

/**
 * 校验 thinkingFormat 取值；空/不认识一律返回 undefined（= 用自动判断）。
 *
 * 刻意**不猜一个格式顶替**：猜错会往请求体里塞一个端点不认识的字段，严格端点直接 400
 * ——但这条风险已经由两道兜底消化：格式按模型 id 自动选（见 guessThinkingFormat），
 * 且探活失败时会自动去掉这个字段重试（见 models.ts 的 probeModel）。
 */
export function normalizeThinkingFormat(
  value: string | undefined,
): ThinkingFormat | undefined {
  const v = (value ?? "").trim();
  return (THINKING_FORMATS as readonly string[]).includes(v)
    ? (v as ThinkingFormat)
    : undefined;
}

/** 显式表示「不要关思考」的写法（填进 `thinkingFormat` 即关闭这项行为）。 */
export const THINKING_OFF_TOKENS = [
  "none",
  "off",
  "false",
  "no",
  "disable",
  "disabled",
  "0",
] as const;

/** `thinkingFormat` 的解析结果。 */
export type ThinkingSetting =
  /** 没配：按模型 id 自动判断发哪个关闭字段（**默认**，即「默认关闭思考」）。 */
  | { kind: "auto" }
  /** 显式不要关：请求里不带任何思考相关字段（端点用它自己的默认）。 */
  | { kind: "off" }
  /** 配了但不认识的取值：如实说出来，然后按「自动」处理。 */
  | { kind: "invalid"; value: string }
  /** 显式指定关闭字段的写法。 */
  | { kind: "format"; format: ThinkingFormat };

/** 解析配置里的 `thinkingFormat`（含「显式关闭」与「不认识」两种特殊取值）。 */
export function parseThinkingSetting(
  value: string | undefined,
): ThinkingSetting {
  const v = (value ?? "").trim();
  if (!v) return { kind: "auto" };
  if ((THINKING_OFF_TOKENS as readonly string[]).includes(v.toLowerCase())) {
    return { kind: "off" };
  }
  const format = normalizeThinkingFormat(v);
  return format ? { kind: "format", format } : { kind: "invalid", value: v };
}

/**
 * 按模型 id / baseUrl 猜「这个端点认哪个关闭字段」。
 *
 * 只是一次猜测，所以配错了也不会坏事：发出去的字段端点要么认（关掉了），要么忽略
 * （等于回到没关），而**严格端点直接拒绝**的那种由探活兜底——第一次探活失败会自动
 * 去掉字段重试一次，并把这次降级写进模型对象，本进程后续都不再发它。
 *
 * 兜底选 deepseek（`thinking: {"type":"disabled"}`）：国产 OpenAI 兼容端点里最常见的
 * 约定，混元 / DeepSeek / GLM 一类都用它。
 */
const THINKING_FORMAT_HINTS: readonly (readonly [RegExp, ThinkingFormat])[] = [
  [/qwen|qwq/i, "qwen"],
  [/deepseek/i, "deepseek"],
  [/hunyuan|混元|\bhy-?\d/i, "deepseek"],
  [/glm|智谱|zai/i, "zai"],
];

const THINKING_FORMAT_FALLBACK: ThinkingFormat = "deepseek";

/** 按模型 id / baseUrl 猜该端点认哪个关闭字段；认不出就用兜底值。 */
export function guessThinkingFormat(modelId: string, baseUrl = ""): ThinkingFormat {
  const haystack = `${modelId} ${baseUrl}`;
  for (const [re, format] of THINKING_FORMAT_HINTS) {
    if (re.test(haystack)) return format;
  }
  return THINKING_FORMAT_FALLBACK;
}

/**
 * 把配置片段合并写回用户配置文件（保留其它字段，缺省字段补默认值）。
 *
 * 交互模式里的 /toggle-language 与 /model 都走这里：它们改的是同一个文件的
 * 不同字段，各写各的会互相覆盖（后写的那次会把文件读到的旧内容整份盖掉）。
 */
function updateUserConfig(patch: Record<string, unknown>): void {
  ensureConfigDir();
  let current: Record<string, unknown> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      // 带 BOM 的文件也要能读：读失败会把用户已有的字段整份丢掉（只留下本次 patch）。
      current = JSON.parse(readConfigText()) as Record<string, unknown>;
    } catch {
      current = {};
    }
  }
  const merged = { ...DEFAULTS, ...current, ...patch };
  writeConfigFile(merged);
}

/**
 * 写 config.json（含 apiKey），权限与 auth.json 对齐为 0o600。
 *
 * 旧版本写出的文件权限较宽，这里对已存在的文件也尽力收紧一次；
 * Windows 上 chmod 可能无效，失败忽略（权限问题不该拖垮写配置）。
 */
function writeConfigFile(data: object): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // 平台不支持 chmod 时忽略。
  }
}

/**
 * 把语种持久化到用户配置文件（保留其它字段）。
 * 供交互模式 /toggle-language 使用：切一次语言就记一次，下次启动直接生效。
 */
export function saveLocale(locale: string): void {
  updateUserConfig({ locale });
}

/**
 * 把选定的模型持久化为「启动默认」（保留其它字段）。
 *
 * 供交互模式 /model 使用：**选中即调用**（ADR-0015）——同一次选择既切换本次会话，
 * 也写回这里成为下次启动的默认，不再需要额外的「设为默认」按键。
 */
export function saveModelSelection(provider: string, model: string): void {
  updateUserConfig({ modelProvider: provider, model });
}

/** 读取用户配置文件；不存在则创建默认文件并返回默认值。 */
function readConfigFile(): Partial<PageQaConfig> {
  if (!existsSync(CONFIG_PATH)) {
    return createDefaultConfigFile();
  }
  try {
    const parsed = JSON.parse(readConfigText()) as Partial<PageQaConfig>;
    return {
      baseUrl: parsed.baseUrl ?? DEFAULTS.baseUrl,
      apiKey: parsed.apiKey ?? DEFAULTS.apiKey,
      model: parsed.model ?? DEFAULTS.model,
      modelProvider: parsed.modelProvider ?? DEFAULTS.modelProvider,
      ...(typeof parsed.thinkingFormat === "string"
        ? { thinkingFormat: parsed.thinkingFormat }
        : {}),
      jev: parsed.jev ?? DEFAULTS.jev,
      locale: parsed.locale ?? DEFAULTS.locale,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * 写出带默认值的配置文件（首次运行时调用）。
 *
 * 从 readConfigFile 中拆出，使“读配置的副作用会在磁盘上建文件”这件事显式可见，
 * 而不是隐藏在名为“读取”的函数里。
 */
function createDefaultConfigFile(): Partial<PageQaConfig> {
  ensureConfigDir();
  writeConfigFile(DEFAULTS);
  return { ...DEFAULTS };
}

/** 确保配置目录存在（首次运行时创建 ~/.pageqa）。 */
export function ensureConfigDir(): string {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  return CONFIG_DIR;
}
