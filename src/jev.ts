/**
 * Jev（TypeSafe System One）API 客户端
 *
 * Jev 是一个结构化决策模型（System One），不做文本生成，只返回
 * 校准后的概率分布。适合用来增强断言验证的语义判断能力。
 *
 * API 文档：https://docs.typesafe.ai
 * Endpoint: POST https://api.typesafe.ai/v1/systemone
 *
 * 用法：
 *   const client = new JevClient(config);
 *   if (client.enabled) {
 *     const prob = await client.assertText(pageText, expectation);
 *     // prob ∈ [0, 1]，超过阈值即判定成立
 *   }
 */

import { info } from "./log.js";

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_TIMEOUT = 15_000; // 毫秒

export interface JevConfig {
  enabled: boolean;
  apiKey: string;
  model: string;
  threshold: number;
}

/** Noul 类型问题的答案 */
export interface NoulAnswer {
  type: "noul";
  noul: number;
}

/** Choice 类型问题的答案 */
export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

/** Score 类型问题的答案 */
export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevResponse {
  model: string;
  answers: Record<string, Answer>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

/** 瞬时错误状态码：限流/过载，可退避重试（对应 jev-ultrafast 的 429/529/503）。 */
const RETRYABLE_STATUS = new Set([429, 503, 529]);
/** 单次 evaluate 的最多尝试次数。 */
const MAX_ATTEMPTS = 3;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isFiniteNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * 校验单个 Jev 答案的结构与校准概率分布（对应 jev-ultrafast 的 validate_choice）。
 * 异常响应会被拒绝，避免把畸形数据误当成断言结论。
 */
function validateAnswer(id: string, ans: Answer): Answer {
  if (ans.type === "noul") {
    if (!isFiniteNum(ans.noul) || ans.noul < 0 || ans.noul > 1) {
      throw new Error(`Jev 答案 "${id}" 非法：noul 必须是 [0,1] 内的有限数。`);
    }
    return ans;
  }
  if (ans.type === "choice") {
    const probs = ans.probabilities;
    const keys = Object.keys(probs);
    const numList = [...Object.values(probs), ans.confidence];
    const sum = keys.reduce((s, k) => s + (probs[k] as number), 0);
    const max = keys.reduce((m, k) => Math.max(m, probs[k] as number), -Infinity);
    const valid =
      typeof ans.choice === "string" &&
      keys.includes(ans.choice) &&
      numList.every((n) => isFiniteNum(n) && n >= 0 && n <= 1) &&
      Math.abs(sum - 1) < 0.02 &&
      (probs[ans.choice] as number) >= max - 1e-6;
    if (!valid) {
      throw new Error(
        `Jev 选择答案 "${id}" 非法：概率未构成校准分布（和≈1、choice 为最大概率、各值∈[0,1]）。`,
      );
    }
    return ans;
  }
  if (ans.type === "score") {
    const probs = ans.probabilities;
    const keys = Object.keys(probs);
    const numList = [...Object.values(probs), ans.confidence];
    const sum = keys.reduce((s, k) => s + (probs[k] as number), 0);
    const valid =
      keys.every((k) => k in ans.legend) &&
      numList.every((n) => isFiniteNum(n) && n >= 0 && n <= 1) &&
      Math.abs(sum - 1) < 0.02 &&
      isFiniteNum(ans.score);
    if (!valid) {
      throw new Error(`Jev 评分答案 "${id}" 非法：概率分布或 score 格式错误。`);
    }
    return ans;
  }
  throw new Error(`Jev 答案 "${id}" 非法：未知答案类型。`);
}

/** Jev 客户端 —— 封装对 TypeSafe API 的调用 */
export class JevClient {
  private readonly cfg: JevConfig;
  private readonly debug: boolean;

  constructor(cfg: JevConfig, debug = false) {
    this.cfg = cfg;
    this.debug = debug;
  }

  /** 当 API 密钥不为空时视为可用 */
  get enabled(): boolean {
    return this.cfg.enabled && Boolean(this.cfg.apiKey);
  }

  get threshold(): number {
    return this.cfg.threshold;
  }

  /**
   * 向 Jev API 发送评估请求（含重试与响应校验）
   * @param state   待评估的内容（字符串 / 对象 / 数组）
   * @param questions  问题定义，key 为答案返回时的 id
   */
  async evaluate(
    state: string,
    questions: Record<string, unknown>,
  ): Promise<JevResponse> {
    const stateLen = state.length;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const t0 = Date.now();
      if (this.debug) {
        process.stderr.write(
          `[jev] POST /v1/systemone attempt=${attempt + 1}/${MAX_ATTEMPTS} model=${this.cfg.model} state_len=${stateLen}\n`,
        );
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

      try {
        const resp = await fetch(DEFAULT_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.cfg.apiKey}`,
          },
          body: JSON.stringify({
            model: this.cfg.model,
            state,
            questions,
          }),
          signal: controller.signal,
        });

        // 限流/过载：退避后重试（指数退避 500ms / 1000ms）。
        if (!resp.ok) {
          if (RETRYABLE_STATUS.has(resp.status) && attempt < MAX_ATTEMPTS - 1) {
            const delay = 500 * 2 ** attempt;
            clearTimeout(timer);
            if (this.debug) {
              process.stderr.write(
                `[jev] HTTP ${resp.status} 可重试，退避 ${delay}ms 后第 ${attempt + 2} 次\n`,
              );
            }
            await sleep(delay);
            continue;
          }
          const body = await resp.text();
          throw new Error(`Jev API ${resp.status}: ${body}`);
        }

        const result = (await resp.json()) as JevResponse;
        // 校验每个答案的结构与校准概率分布，拒绝对畸形响应的误判。
        for (const [id, ans] of Object.entries(result.answers ?? {})) {
          validateAnswer(id, ans);
        }
        if (this.debug) {
          const answer = result.answers?.["assertion_check"];
          const noul = answer?.type === "noul" ? answer.noul : undefined;
          process.stderr.write(
            `[jev] 响应 ${resp.status} 耗时=${Date.now() - t0}ms noul=${noul} usage=${JSON.stringify(result.usage)}\n`,
          );
        }
        return result;
      } catch (err) {
        clearTimeout(timer);
        const isAbort = err instanceof Error && err.name === "AbortError";
        // 超时与网络抖动视为瞬时错误，退避后重试。
        const isNetwork =
          err instanceof Error &&
          (err.name === "TypeError" || /UND_ERR/.test((err as { code?: string }).code ?? ""));
        if ((isAbort || isNetwork) && attempt < MAX_ATTEMPTS - 1) {
          const delay = 500 * 2 ** attempt;
          if (this.debug) {
            process.stderr.write(
              `[jev] 瞬时错误（${isAbort ? "timeout" : "network"}），退避 ${delay}ms 后第 ${attempt + 2} 次\n`,
            );
          }
          await sleep(delay);
          continue;
        }
        if (isAbort) throw new Error(`Jev 请求超时（>${DEFAULT_TIMEOUT}ms）`);
        throw err;
      }
    }

    throw new Error(`Jev 服务不可用（已重试 ${MAX_ATTEMPTS} 次）`);
  }

  /**
   * 语义判断：页面文本是否匹配断言期望
   * @returns 匹配概率 [0, 1]
   */
  async assertText(pageText: string, expectation: string): Promise<number> {
    const t0 = Date.now();
    if (this.debug) {
      process.stderr.write(
        `[jev] assertText 期望="${expectation}" page_len=${pageText.length}\n`,
      );
    }

    const resp = await this.evaluate(pageText, {
      assertion_check: {
        type: "noul",
        instructions: `以下是一段浏览器页面的快照文本。请判断它是否包含或等效于给定的断言期望。考虑大小写变体、同义词、近义表达和格式差异。"${expectation}"`,
        criteria: {
          yes: "页面文本中包含或等效于期望的内容",
          no: "页面文本中没有找到与期望相关的内容",
        },
      },
    });

    const answer = resp.answers?.["assertion_check"];
    const noul = answer?.type === "noul" ? answer.noul : 0;
    const cost = Date.now() - t0;
    const pass = noul >= this.cfg.threshold;
    // 始终输出一次：未开 --debug 时也能看到 Jev 何时被调用、匹配度与结论。
    info(
      `[pageqa] [jev] 语义复核 期望="${expectation}" 匹配度 ${(noul * 100).toFixed(1)}%` +
        ` 阈值 ${(this.cfg.threshold * 100).toFixed(0)}% → ${pass ? "成立" : "不成立"} (${cost}ms)`,
    );
    if (this.debug) {
      process.stderr.write(
        `[jev] assertText 结果 noul=${noul} 阈值=${this.cfg.threshold} 耗时=${cost}ms\n`,
      );
    }
    return noul;
  }
}
