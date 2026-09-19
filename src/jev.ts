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
   * 向 Jev API 发送评估请求
   * @param state   待评估的内容（字符串 / 对象 / 数组）
   * @param questions  问题定义，key 为答案返回时的 id
   */
  async evaluate(
    state: string,
    questions: Record<string, unknown>,
  ): Promise<JevResponse> {
    const t0 = Date.now();
    if (this.debug) {
      process.stderr.write(
        `[jev] POST /v1/systemone model=${this.cfg.model} state_len=${state.length}\n`,
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

      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Jev API ${resp.status}: ${body}`);
      }

      const result = (await resp.json()) as JevResponse;
      if (this.debug) {
        const answer = result.answers?.["assertion_check"];
        const noul = answer?.type === "noul" ? answer.noul : undefined;
        process.stderr.write(
          `[jev] 响应 ${resp.status} 耗时=${Date.now() - t0}ms noul=${noul} usage=${JSON.stringify(result.usage)}\n`,
        );
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
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
    if (this.debug) {
      process.stderr.write(
        `[jev] assertText 结果 noul=${noul} 阈值=${this.cfg.threshold} 耗时=${Date.now() - t0}ms\n`,
      );
    }
    return noul;
  }
}
