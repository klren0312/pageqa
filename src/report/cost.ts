/**
 * token 金额估算：把用量折成钱。
 *
 * 为什么必须自己维护价目：`@earendil-works/pi-ai` 的 `Model` 上确实有 `cost` 字段
 * （`ModelCost`：input / output / cacheRead / cacheWrite），但**内置目录不填它**——
 * 实测 42 个 provider 的模型目录里 `cost` 出现 0 次，免费网关更是在 `toModel` 里
 * 硬编码成 0。也就是说「按目录价估算」这条路走不通，价只能来自这里。
 *
 * 因此这个模块的两个设计点：
 * 1. **价目 = 内置快照 < config 覆盖**。快照让人开箱就能看到估算，但它会过期
 *    （厂商降价、新模型、缓存价调整），所以 `config.json` 的 `modelPricing` 说了算。
 * 2. **匹配不到就不估算**。宁可说「未配置价格」，也不按 0 计——`$0.00` 会被读成
 *    「这个模型免费」，而真相只是没查到价，那是比没有更坏的误解。
 *
 * 全部是纯函数（不碰配置文件、不看语言环境），因此「四种 token 各按自己的价」
 * 「覆盖优先」「未命中返回 null」这些口径都能直接单测。
 */

/** 每百万 token 的美元单价。 */
export interface TokenPrice {
  /** 喂进模型的输入 token（不含缓存）。 */
  input: number;
  /** 模型输出的 token。 */
  output: number;
  /** 命中缓存的输入 token（各厂商通常为 input 的一折）。 */
  cacheRead: number;
  /** 写进缓存的输入 token（通常比 input 贵一点点）。 */
  cacheWrite: number;
}

/**
 * USD → CNY 的默认汇率。
 *
 * 只是个**显示便利**：价目本身仍是美元（各厂商公开价目都是美元），这个系数只用
 * 来在报告里并列一个人民币数。默认值取 2026 年的大致水平；实际生效值由
 * `config.json` 的 `usdToCny`（或 `PAGEQA_USD_TO_CNY`）决定，注入点在 `report.ts`——
 * 这里保持纯数据，不读配置。
 */
export const DEFAULT_USD_TO_CNY = 7.1;

/** 非法单价的兜底：负数与非数字一律当 0（不猜「大概多少」）。 */
function normalizeRate(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * 把用户配置里的一份 `{input,output,cacheRead,cacheWrite}` 解析成 {@link TokenPrice}。
 *
 * 四项都可以只填一部分：缓存价最常被漏配，缺的那项按 0 计而不是按 input 折算——
 * 猜一个价的后果是估算偏高或偏低，而 0 至少是「这一项没算」的诚实表达。
 * 输入形状不认识（不是对象、四项全不是数）时返回 null。
 */
export function parseTokenPrice(raw: unknown): TokenPrice | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const input = normalizeRate(o.input);
  const output = normalizeRate(o.output);
  const cacheRead = normalizeRate(o.cacheRead);
  const cacheWrite = normalizeRate(o.cacheWrite);
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null;
  return { input, output, cacheRead, cacheWrite };
}

/**
 * 按 `provider` + `model` 取单价；**config 覆盖优先于内置快照**。
 *
 * `*` 是该 provider 下所有模型的通配价（`"deepseek": { "*": {...} }`），
 * 模型 id 完全匹配的条目优先于它——后者才配得上「chat 与 reasoner 不同价」这种事。
 *
 * 匹配顺序：config 的精确 id → config 的 `*` → 快照的精确 id → 快照的 `*`。
 * 两边都没有则返回 null（调用方据此回答「未配置价格」）。
 */
export function resolveTokenPrice(
  provider: string,
  model: string,
  configPricing: Record<string, Record<string, unknown>> | undefined,
  snapshot: Readonly<Record<string, Record<string, unknown>>>,
): TokenPrice | null {
  for (const source of [configPricing, snapshot]) {
    if (!source) continue;
    const byModel = source[provider];
    if (!byModel) continue;
    // 精确 id 优先，其次才是通配
    const exact = byModel[model];
    const wildcard = byModel["*"];
    const price = parseTokenPrice(exact) ?? parseTokenPrice(wildcard);
    if (price) return price;
  }
  return null;
}

/**
 * 一次运行的费用明细（美元）。
 *
 * 分项照原样留着：报告要把「哪一类 token 花了多少」摊开给人看，只给一个总数就没法
 * 判断「该不该压缩上下文」「缓存到底省没省到钱」。
 */
export interface CostEstimate {
  /** 输入 token 的费用。 */
  input: number;
  /** 输出 token 的费用。 */
  output: number;
  /** 命中缓存的输入 token 的费用。 */
  cacheRead: number;
  /** 写缓存的输入 token 的费用。 */
  cacheWrite: number;
  /** 四项之和（美元）。 */
  total: number;
}

/** 只算「用到的 token 数」的最小形状（{@link TokenUsage} 的结构性子集）。 */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 每百万 token 的价格 → 单个 token 的价格。 */
const PER_TOKEN = 1_000_000;

/** 按单价算费用。四项各按自己的价，缺的项单价为 0 即不计。 */
export function estimateCost(counts: TokenCounts, price: TokenPrice): CostEstimate {
  const input = (counts.input / PER_TOKEN) * price.input;
  const output = (counts.output / PER_TOKEN) * price.output;
  const cacheRead = (counts.cacheRead / PER_TOKEN) * price.cacheRead;
  const cacheWrite = (counts.cacheWrite / PER_TOKEN) * price.cacheWrite;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/** 两份费用相加（套件逐场景累加）。缺项按 0 计。 */
export function mergeCost(a?: CostEstimate, b?: CostEstimate): CostEstimate {
  if (!a) return b ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
  };
}

/**
 * 金额 → 人类可读（纯函数，不看语言环境）。
 *
 * 分段保留有效位：$0.0086 写成 `0.01` 就成了「一分钱」，而一次测试跑几十轮正好
 * 落在这个量级。所以小额给更多位，大额收到两位——同一个字段要同时经得起
 * 「单次跑的几分钱」和「跑了一个月的几百刀」。
 */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "0";
  if (usd <= 0) return "0";
  // 比 0.0001 还小：四位小数会把它舍成 "0"，而那正是本模块最不想要的
  // 「看起来免费」。给一个下界写法，至少表达出「花过钱，只是很少」。
  if (usd < 0.0001) return "<0.0001";
  if (usd < 0.01) {
    // 小数：最多 4 位，去掉尾部的 0（0.0086 / 0.0005 这种）
    const s = usd.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    return s;
  }
  if (usd < 100) return usd.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return Math.round(usd).toString();
}
