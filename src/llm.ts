import { createModels, createProvider, type Model, type Api } from "@earendil-works/pi-ai";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";

/**
 * LLM 后端：基于 @earendil-works/pi-ai 构造一个指向 CodeBuddy 本地反代的自定义 provider。
 *
 * 默认反代地址 http://127.0.0.1:3000/v1（上游 copilot.tencent.com，模型 hunyuan-2.0-instruct），
 * 无需任何官网 API Key。如反代不可达，可设置环境变量覆盖：
 *   - PAGE_TEST_LLM_BASE_URL
 *   - PAGE_TEST_LLM_API_KEY
 *   - PAGE_TEST_LLM_MODEL
 *
 * 也可通过设置 PAGE_TEST_LLM_PROVIDER / PAGE_TEST_LLM_MODEL 切换到 pi-ai 其他已配置 provider。
 */

const DEFAULT_BASE_URL = process.env.PAGE_TEST_LLM_BASE_URL || "http://127.0.0.1:3000/v1";
const DEFAULT_API_KEY = process.env.PAGE_TEST_LLM_API_KEY || "codebuddy-proxy-key";
const DEFAULT_MODEL = process.env.PAGE_TEST_LLM_MODEL || "hunyuan-2.0-instruct";
const PROVIDER_ID = "codebuddy";

interface CodeBuddyModelConfig {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
}

const MODELS: CodeBuddyModelConfig[] = [
  { id: "hunyuan-2.0-instruct", name: "Hunyuan 2.0 Instruct", contextWindow: 32000, maxOutput: 64000 },
  { id: "hy3", name: "Hy3", contextWindow: 192000, maxOutput: 64000 },
  { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", contextWindow: 1_000_000, maxOutput: 128_000 },
];

/** 构造一个静态解析的 ApiKeyAuth（避免交互式 env 探测）。 */
function staticApiKeyAuth(apiKey: string, baseUrl: string) {
  return {
    name: "CodeBuddy Proxy",
    resolve: async () => ({ auth: { apiKey, baseUrl }, source: "static" }),
  };
}

export interface LlmBackend {
  models: ReturnType<typeof createModels>;
  model: Model<Api>;
}

export function createLlmBackend(): LlmBackend {
  const models = createModels();
  const provider = createProvider({
    id: PROVIDER_ID,
    name: "CodeBuddy (本地反代)",
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
    throw new Error(`未找到模型 ${DEFAULT_MODEL}（provider=${PROVIDER_ID}）。请确认 CodeBuddy 反代可用。`);
  }
  return { models, model };
}
