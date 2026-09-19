import { createModels, createProvider, type Model, type Api } from "@earendil-works/pi-ai";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";
import { loadConfig } from "./config.js";

/**
 * LLM 后端：基于 @earendil-works/pi-ai 构造一个指向可配置的 OpenAI 兼容端点的自定义 provider。
 *
 * 配置优先级（高 -> 低）：环境变量 PAGEQA_LLM_*  >  用户配置文件（~/.pageqa/config.json）  >  内置默认值。
 * 首次运行会自动在用户主目录创建配置文件，便于用户修改模型/端点地址/密钥。
 */

const PROVIDER_ID = "pageqa";

interface LlmModelConfig {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
}

const MODELS: LlmModelConfig[] = [
  { id: "hunyuan-2.0-instruct", name: "Hunyuan 2.0 Instruct", contextWindow: 32000, maxOutput: 64000 },
  { id: "hy3", name: "Hy3", contextWindow: 192000, maxOutput: 64000 },
  { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", contextWindow: 1_000_000, maxOutput: 128_000 },
];

/** 构造一个静态解析的 ApiKeyAuth（避免交互式 env 探测）。 */
function staticApiKeyAuth(apiKey: string, baseUrl: string) {
  return {
    name: "OpenAI Compatible",
    resolve: async () => ({ auth: { apiKey, baseUrl }, source: "static" }),
  };
}

export interface LlmBackend {
  models: ReturnType<typeof createModels>;
  model: Model<Api>;
}

export function createLlmBackend(): LlmBackend {
  const cfg = loadConfig();
  const DEFAULT_BASE_URL = cfg.baseUrl;
  const DEFAULT_API_KEY = cfg.apiKey;
  const DEFAULT_MODEL = cfg.model;
  const models = createModels();
  const provider = createProvider({
    id: PROVIDER_ID,
    name: "OpenAI Compatible (自定义端点)",
    auth: { apiKey: staticApiKeyAuth(DEFAULT_API_KEY, DEFAULT_BASE_URL) },
    models: MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl: DEFAULT_BASE_URL,
      input: ["text"],
      reasoning: false,
      contextWindow: m.contextWindow,
      maxTokens: m.maxOutput,
      maxOutput: m.maxOutput,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        maxTokensField: "max_tokens",
        supportsLongCacheRetention: false,
      },
    })),
    api: openaiCompletions,
  });
  models.setProvider(provider);

  const model = models.getModel(PROVIDER_ID, DEFAULT_MODEL);
  if (!model) {
    throw new Error(
      `未找到模型 ${DEFAULT_MODEL}（provider=${PROVIDER_ID}）。请检查 ~/.pageqa/config.json 中的 model 与 baseUrl 配置。`,
    );
  }
  return { models, model };
}
