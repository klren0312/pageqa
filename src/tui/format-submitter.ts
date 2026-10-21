/**
 * 格式化提交的串行队列。
 *
 * 格式化是异步的：并发跑完的顺序不可控，而队列编号与执行顺序必须跟用户敲下的顺序一致。
 * 这里一次只跑一个提交；控制器留在 `pending` 里，Esc / 收工能一次取消全部还没落地的输入。
 *
 * 本模块不碰模型与 TUI：`run` 由调用方注入，出错交给 `onError`，因此串行、取消、
 * 在飞计数这些行为可以直接单测。
 */
export class FormatSubmitter {
  private readonly pending = new Set<AbortController>();
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly onChange: () => void = () => {}) {}

  /** 还没走完的提交数（含正在格式化的那一条）：状态栏与 `/new` 的防呆都看它。 */
  get size(): number {
    return this.pending.size;
  }

  /**
   * 提交一个格式化任务；返回的 promise 在任务（含错误处理）结束后 resolve。
   * 已取消的任务不会再调用 `run`。
   */
  submit(
    run: (signal: AbortSignal) => Promise<void>,
    onError?: (error: unknown, signal: AbortSignal) => void,
  ): Promise<void> {
    const controller = new AbortController();
    this.pending.add(controller);
    this.onChange();
    const job = this.chain.then(async () => {
      try {
        if (!controller.signal.aborted) await run(controller.signal);
      } catch (error) {
        // 取消导致的 reject 不算失败，也不该触发「回退原文」。
        if (!controller.signal.aborted) onError?.(error, controller.signal);
      } finally {
        this.pending.delete(controller);
        this.onChange();
      }
    });
    this.chain = job.catch(() => {});
    return job;
  }

  /**
   * 取消全部还没走完的提交（含正在格式化的那个），返回取消数量。
   *
   * 先从 pending 中移除再 abort：状态栏能立刻归零，而不是等每个任务自己收尾。
   * 已经发出的模型请求会收到中止信号；不响应中止的端点由提交方自己兜底。
   */
  cancelAll(reason?: unknown): number {
    const controllers = [...this.pending];
    this.pending.clear();
    for (const controller of controllers) controller.abort(reason);
    if (controllers.length > 0) this.onChange();
    return controllers.length;
  }
}
