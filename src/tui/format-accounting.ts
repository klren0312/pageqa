/**
 * 格式化调用的用量与费用记账。
 *
 * 格式化在主进程执行，不在任何场景的 `AgentRunResult` 里，所以单独累计：
 * - `total` 覆盖整个进程，退出报告用；
 * - `session` 只覆盖当前批次，输入框下方的 token 行用（`/new` 重置；
 *   用户主动取消的调用只进总账）；
 * - `pricedCost` 只在**所有**调用都能定价时给出——报一半的费用比不报更误导。
 */
import {
  addUsage,
  emptyUsage,
  mergeUsage,
  tokenPriceFor,
  type RawUsage,
  type TokenUsage,
} from "../report/report.js";
import {
  estimateCost,
  mergeCost,
  type CostEstimate,
} from "../report/cost.js";

export class FormatAccounting {
  private totalUsage: TokenUsage = emptyUsage();
  private sessionUsage: TokenUsage = emptyUsage();
  private cost: CostEstimate | undefined;
  private unpriced = false;

  constructor(
    private readonly modelPricing:
      | Record<string, Record<string, unknown>>
      | undefined,
  ) {}

  /**
   * 记录一次模型回复的用量。
   *
   * 截断/报错/取消的回复也要记：token 已经烧了，只是没有可用的格式化结果。
   * 用户主动取消的回复仍进总账，但不进当前批次——它可能在 `/new` 之后才落地，
   * 计到新会话的实时数字里会让人误以为新会话已经烧了这些 token。
   */
  record(
    model: { provider: string; id: string },
    usage: RawUsage,
    opts: { session?: boolean } = {},
  ): void {
    this.totalUsage = addUsage(this.totalUsage, usage);
    if (opts.session !== false) {
      this.sessionUsage = addUsage(this.sessionUsage, usage);
    }
    const price = tokenPriceFor(model.provider, model.id, this.modelPricing);
    if (!price) {
      this.unpriced = true;
      return;
    }
    this.cost = mergeCost(
      this.cost,
      estimateCost(
        {
          input: usage.input ?? 0,
          output: usage.output ?? 0,
          cacheRead: usage.cacheRead ?? 0,
          cacheWrite: usage.cacheWrite ?? 0,
        },
        price,
      ),
    );
  }

  get total(): TokenUsage {
    return this.totalUsage;
  }

  get session(): TokenUsage {
    return this.sessionUsage;
  }

  /** 任一调用无价目时为 undefined：此时总费用缺一块，不应给出部分金额。 */
  get pricedCost(): CostEstimate | undefined {
    return this.unpriced ? undefined : this.cost;
  }

  /** `/new` 只重置当前批次；全程总量与费用留到退出报告。 */
  resetSession(): void {
    this.sessionUsage = emptyUsage();
  }

  /**
   * 把全程用量与费用汇入套件报告。
   *
   * 有未定价的调用时删掉 `cost`：总费用缺一块，报一个只含场景的金额会让人以为
   * 那就是全部（与 `summarizeSuite` 对成员费用的口径一致）。
   */
  mergeInto(target: { usage?: TokenUsage; cost?: CostEstimate }): void {
    if (this.totalUsage.calls === 0) return;
    target.usage = mergeUsage(target.usage ?? emptyUsage(), this.totalUsage);
    const cost = this.pricedCost;
    if (cost) {
      target.cost = mergeCost(target.cost, cost);
    } else {
      delete target.cost;
    }
  }
}
