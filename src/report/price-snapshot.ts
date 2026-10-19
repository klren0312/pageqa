/**
 * 内置价目快照（2026-10 采集，单位：美元 / 每百万 token）。
 *
 * 为什么要有它：没有快照的话，用户在 `config.json` 配好 `modelPricing` 之前
 * 一个估算都看不到，而这个功能等于不存在。快照让人**开箱就能看到花了多少钱**。
 *
 * 为什么它能被覆盖：价目会过期。厂商降价（DeepSeek 一年内降过数次）、新模型上线、
 * 缓存价调整——快照注定会与账单脱节。所以 `config.json` 的 `modelPricing`
 * 永远优先（见 {@link resolveTokenPrice} 的顺序：config 精确 → config `*` → 快照）。
 *
 * 收录原则：只收**这个仓库真的会用到的**——pageqa 的模型来自自定义端点
 * （`PAGEQA_LLM_*`）、内置 provider（/login 登录 Anthropic / OpenAI / Google…）
 * 与免费网关。免费网关与自建端点没有统一公开价，一律不收（它们靠 config）。
 *
 * 数字取自各厂商公开的模型定价页。**这是快照不是承诺**：改动只需动这个文件，
 * 不需要改任何逻辑。每个模型的注释留了采集日期，方便判断是否该刷新。
 */

import type { TokenPrice } from "./cost.js";

/** 只写{@link TokenPrice} 要求的那四项（缓存价常与 input 同价，故多数条目省略它）。 */
interface PriceSpec {
  /** 输入价（美元 / 百万 token）。 */
  i: number;
  /** 输出价。 */
  o: number;
  /** 命中缓存的输入价；省略 = 不单独计（0）。 */
  cr?: number;
  /** 写缓存的输入价；省略 = 与 input 同价。 */
  cw?: number;
}

/** 展开成完整的 {@link TokenPrice}：缓存价缺省时按「写 = input、读 = 0」处理。 */
function price(spec: PriceSpec): TokenPrice {
  return {
    input: spec.i,
    output: spec.o,
    cacheRead: spec.cr ?? 0,
    cacheWrite: spec.cw ?? spec.i,
  };
}

/**
 * 按 provider → 模型 id 组织的价目。
 *
 * provider 用 `PAGEQA_PROVIDER_ID` / pi-ai 的 provider id（`anthropic` / `openai` /
 * `google` / `deepseek`…）。`*` 键是 provider 级通配价，见 {@link resolveTokenPrice}。
 */
export const PRICE_SNAPSHOT: Readonly<Record<string, Record<string, TokenPrice>>> = {
  // ── Anthropic（2026-10 采集）──
  // Claude 的缓存读约为 input 的 1/10、缓存写约为 1.25 倍。
  anthropic: {
    "*": price({ i: 3, o: 15, cr: 0.3 }),
    "claude-opus-4": price({ i: 15, o: 75, cr: 1.5 }),
    "claude-sonnet-4-5": price({ i: 3, o: 15, cr: 0.3 }),
    "claude-3-5-haiku": price({ i: 0.8, o: 4, cr: 0.08 }),
  },

  // ── OpenAI（2026-10 采集）──
  openai: {
    "*": price({ i: 2.5, o: 10 }),
    "gpt-4o-mini": price({ i: 0.15, o: 0.6, cr: 0.075 }),
    "gpt-4o": price({ i: 2.5, o: 10, cr: 1.25 }),
    "gpt-5": price({ i: 1.25, o: 10, cr: 0.125 }),
  },

  // ── Google（2026-10 采集）──
  google: {
    "*": price({ i: 1.25, o: 5 }),
    "gemini-2.0-flash": price({ i: 0.1, o: 0.4, cr: 0.025 }),
    "gemini-2.5-flash": price({ i: 0.3, o: 2.5, cr: 0.075 }),
    "gemini-2.5-pro": price({ i: 1.25, o: 10, cr: 0.31 }),
  },

  // ── DeepSeek（2026-10 采集）──
  // 国产模型里最常被 pageqa 用户自建端点接的一个：缓存命中价约为 input 的 1/10。
  deepseek: {
    "*": price({ i: 0.14, o: 0.28, cr: 0.014 }),
    "deepseek-chat": price({ i: 0.27, o: 1.1, cr: 0.027 }),
    "deepseek-reasoner": price({ i: 0.55, o: 2.19, cr: 0.055 }),
  },

  // ── 阿里百炼 / DashScope（通义系列，2026-10 采集）──
  qwen: {
    "*": price({ i: 0.8, o: 2 }),
    "qwen-flash": price({ i: 0.04, o: 0.4 }),
    "qwen-plus": price({ i: 0.4, o: 1.2 }),
    "qwen-max": price({ i: 1.6, o: 6.4 }),
    "qwen3-coder-plus": price({ i: 1, o: 5 }),
  },

  // ── 智谱 / GLM（2026-10 采集）──
  zhipu: {
    "*": price({ i: 0.5, o: 2 }),
    "glm-4-flash": price({ i: 0.01, o: 0.1 }),
    "glm-4-plus": price({ i: 0.7, o: 2.8 }),
    "glm-4.6": price({ i: 0.6, o: 2.2 }),
  },

  // ── 月之暗面 / Kimi（2026-10 采集）──
  moonshot: {
    "*": price({ i: 2, o: 8 }),
    "kimi-k2": price({ i: 0.6, o: 2.5 }),
    "moonshot-v1-8k": price({ i: 0.2, o: 2 }),
    "moonshot-v1-32k": price({ i: 1, o: 4 }),
  },
};

/**
 * 快照覆盖了哪些 provider（给报错提示用：告诉用户「这个提供商没价，去配」）。
 *
 * 只列 key 不列模型：模型 id 随上游变化快，列出来反而像一份承诺。
 */
export const PRICED_PROVIDER_IDS: readonly string[] = Object.keys(PRICE_SNAPSHOT);
