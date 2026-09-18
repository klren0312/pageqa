import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * 用户级配置：在用户主目录下创建配置目录与文件，持久化 LLM 后端设置。
 *
 * 配置目录：~/.pageqa（Windows 为 %USERPROFILE%/.pageqa）
 * 配置文件：config.json，字段：
 *   - baseUrl: 反代/兼容 OpenAI 的 base URL
 *   - apiKey:  访问密钥
 *   - model:   模型 ID
 *
 * 优先级（高 -> 低）：
 *   环境变量 PAGEQA_LLM_*  >  用户配置文件  >  内置默认值
 *
 * 首次运行（配置文件不存在）会自动创建带默认值的配置文件，便于用户日后修改。
 */

export interface PageQaConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const DEFAULTS: PageQaConfig = {
  baseUrl: "http://127.0.0.1:3000/v1",
  apiKey: "codebuddy-proxy-key",
  model: "hunyuan-2.0-instruct",
};

export const CONFIG_DIR = join(homedir(), ".pageqa");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

/** 读取配置：合并 默认值 < 用户文件 < 环境变量。返回最终生效配置。 */
export function loadConfig(): PageQaConfig {
  const fromFile = readConfigFile();
  return {
    baseUrl: process.env.PAGEQA_LLM_BASE_URL ?? fromFile.baseUrl ?? DEFAULTS.baseUrl,
    apiKey: process.env.PAGEQA_LLM_API_KEY ?? fromFile.apiKey ?? DEFAULTS.apiKey,
    model: process.env.PAGEQA_LLM_MODEL ?? fromFile.model ?? DEFAULTS.model,
  };
}

/** 读取用户配置文件；不存在则创建默认文件并返回默认值。 */
function readConfigFile(): Partial<PageQaConfig> {
  if (!existsSync(CONFIG_PATH)) {
    ensureConfigDir();
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2), "utf8");
    return { ...DEFAULTS };
  }
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<PageQaConfig>;
    return {
      baseUrl: parsed.baseUrl ?? DEFAULTS.baseUrl,
      apiKey: parsed.apiKey ?? DEFAULTS.apiKey,
      model: parsed.model ?? DEFAULTS.model,
    };
  } catch {
    return { ...DEFAULTS };
  }
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
