import { homedir, platform } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

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

import type { JevConfig } from "./jev.js";

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
  jev: JevConfig;
  /** 界面/日志/报告语种（"zh" | "en"）；交互模式 /toggle-language 会写回这里。 */
  locale?: string;
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
 * 只读地取配置文件里已保存的语种（**不会**创建文件）。
 *
 * 单独开这个口子，是为了让「按配置决定初始语种」这件事不必先落一个配置文件——
 * `--help`、参数报错这类路径不该产生磁盘副作用。
 */
export function readSavedLocale(): string | undefined {
  if (!existsSync(CONFIG_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as {
      locale?: unknown;
    };
    return typeof parsed.locale === "string" ? parsed.locale : undefined;
  } catch {
    return undefined;
  }
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
      current = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      current = {};
    }
  }
  const merged = { ...DEFAULTS, ...current, ...patch };
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf8");
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
 * 供交互模式 /model 的「设为默认」使用（对应 pi-coding-agent 里模型选择器的 Ctrl+S）：
 * 只影响下次启动；本次会话的切换由 TUI 自己持有，不经过这里。
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
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<PageQaConfig>;
    return {
      baseUrl: parsed.baseUrl ?? DEFAULTS.baseUrl,
      apiKey: parsed.apiKey ?? DEFAULTS.apiKey,
      model: parsed.model ?? DEFAULTS.model,
      modelProvider: parsed.modelProvider ?? DEFAULTS.modelProvider,
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
  writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2), "utf8");
  return { ...DEFAULTS };
}

/** 确保配置目录存在（首次运行时创建 ~/.pageqa）。 */
export function ensureConfigDir(): string {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  return CONFIG_DIR;
}

/** 平台无关地展示用户配置目录（便于 README/帮助说明）。 */
export function describeConfigLocation(): string {
  const home = homedir();
  const tail = platform() === "win32" ? "%USERPROFILE%\\.pageqa" : "~/.pageqa";
  return `${CONFIG_DIR} (${tail} → ${home})`;
}
