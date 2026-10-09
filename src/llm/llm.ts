import { createProvider, type Provider } from "@earendil-works/pi-ai";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";
import {
  guessThinkingFormat,
  loadConfig,
  parseThinkingSetting,
  PAGEQA_PROVIDER_ID,
  THINKING_FORMATS,
  THINKING_OFF_FIELD,
  type PageQaConfig,
} from "../config/config.js";
import { info } from "../shared/log.js";
import { t } from "../shared/i18n.js";

/**
 * 自定义 LLM provider：基于 @earendil-works/pi-ai 构造一个指向可配置 OpenAI 兼容端点的 provider。
 *
 * 这是 pageqa 的**默认**后端（配置里的 baseUrl/apiKey/model）。交互模式接入的内置
 * provider（anthropic / openai / deepseek …，见 models.ts）是叠加在它之上的额外选择，
 * 因此这里的 provider 永远注册在最前面，pageqa 的 `modelProvider` 指向它。
 *
 * 配置优先级（高 -> 低）：环境变量 PAGEQA_LLM_*  >  用户配置文件（~/.pageqa/config.json）  >  内置默认值。
 * 首次运行会自动在用户主目录创建配置文件，便于用户修改模型/端点地址/密钥。
 *
 * 代理：这里**不**注入 fetch。自定义端点与内置 provider 走同一条路——pi-ai 在每次请求
 * 时才构造 SDK 客户端，客户端默认取当时的 `globalThis.fetch`，而代理路由在进程启动时
 * 就已替换了它（见 proxy.ts 的 `installProxyRouting`）。刻意只留这一个装配点：两个入口
 * 各自代理一次，统计会翻倍、fallback 也会套一层。
 */

/** 内置预设模型：给出精确的上下文窗口与输出上限（未收录的模型见 resolveModels 的保守兜底）。 */
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

/** 预设之外的模型使用的保守上下文窗口/输出上限（未知模型按最小预设处理，避免超出端点实际限制）。 */
const FALLBACK_CONTEXT_WINDOW = 32_000;
const FALLBACK_MAX_OUTPUT = 64_000;

/**
 * 解析实际要注册的模型清单：预设模型沿用精确的 contextWindow/maxOutput；
 * 用户配置了预设之外的模型时，动态补一条保守条目，使「改配置即用」成立
 * （README 承诺 baseUrl/apiKey/model 均可配置、无需改代码）。
 */
function resolveModels(modelId: string): LlmModelConfig[] {
  if (MODELS.some((m) => m.id === modelId)) return MODELS;
  return [
    ...MODELS,
    {
      id: modelId,
      name: modelId,
      contextWindow: FALLBACK_CONTEXT_WINDOW,
      maxOutput: FALLBACK_MAX_OUTPUT,
    },
  ];
}

/** 构造一个静态解析的 ApiKeyAuth（避免交互式 env 探测）。 */
function staticApiKeyAuth(apiKey: string, baseUrl: string) {
  return {
    name: "OpenAI Compatible",
    resolve: async () => ({ auth: { apiKey, baseUrl }, source: "static" }),
  };
}

/**
 * 由配置文件构造自定义端点 provider。
 *
 * 抽成独立函数（原先内联在 createLlmBackend 里）是为了让模型目录能在同一个
 * `Models` 集合里同时容纳「自定义端点」与「内置 provider」，见 models.ts。
 */
export function createPageqaProvider(
  cfg: PageQaConfig = loadConfig(),
): Provider {
  const baseUrl = cfg.baseUrl;
  const registered = resolveModels(cfg.model);
  /**
   * 「显式关闭端点的思考模式」——**默认就关**。
   *
   * 关键在 pi-ai 那一侧：**关思考的开关只在模型声明自己是 reasoning 模型时才发**
   * （`openai-completions.js` 里 `zai`/`qwen`/`deepseek`/… 每个分支都带 `&& model.reasoning`）。
   * 所以只给 thinkingFormat 不开 reasoning 没用——两者必须同时到位。
   *
   * 三种来源：显式配置 > 按模型 id 自动猜（默认）> 不用了（`thinkingFormat: "none"`）。
   * 猜错不会坏事：端点要么认、要么忽略，而拒绝这种字段的严格端点由探活兜底
   * （第一次失败会自动去掉字段重试，见 models.ts 的 probeModel）。
   */
  const setting = parseThinkingSetting(cfg.thinkingFormat);
  if (setting.kind === "invalid") {
    info(
      t("log.thinkingBad", {
        value: setting.value,
        list: THINKING_FORMATS.join(" / "),
      }),
    );
  }
  const thinkingFormat =
    setting.kind === "format"
      ? setting.format
      : setting.kind === "off"
        ? undefined
        : guessThinkingFormat(cfg.model, baseUrl);
  const guessed = setting.kind !== "format";
  if (!thinkingFormat) {
    info(t("log.thinkingOffExplicit"));
  } else {
    const field = THINKING_OFF_FIELD[thinkingFormat];
    info(
      field
        ? guessed
          ? t("log.thinkingAuto", {
              model: cfg.model,
              format: thinkingFormat,
              field,
            })
          : t("log.thinkingOff", { format: thinkingFormat, field })
        : t("log.thinkingOffNoop", { format: thinkingFormat }),
    );
  }
  return createProvider({
    id: PAGEQA_PROVIDER_ID,
    name: "OpenAI Compatible (自定义端点)",
    auth: { apiKey: staticApiKeyAuth(cfg.apiKey, baseUrl) },
    models: registered.map((m) => ({
      id: m.id,
      name: m.name,
      api: "openai-completions",
      provider: PAGEQA_PROVIDER_ID,
      baseUrl,
      input: ["text"],
      // 见上方注释：关思考的字段只在 reasoning 为真时才发，所以两者必须同时打开。
      reasoning: thinkingFormat !== undefined,
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
        ...(thinkingFormat ? { thinkingFormat } : {}),
      },
    })),
    api: openaiCompletions,
  });
}
