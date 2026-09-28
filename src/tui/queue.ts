/**
 * 运行队列：交互模式下待跑场景的调度。
 *
 * **默认串行**，并发上限可以用 `/setting` 里的「并发量」调（1/2/3/4/6/8）。串行仍是默认，
 * 因为它是「场景之间可能有隐含顺序依赖」的保护（「创建 → 编辑 → 删除」并行跑不是失败，
 * 是数据错乱）；并发等于用户声明「这些场景互不依赖」。见 ADR-0013 决策三。
 *
 * 「提交了就一定会跑」是队列对用户的承诺，因此一个场景结束（通过／失败／已取消）后
 * 立刻补上下一个，不停下来等指令。
 */
import { debugLog } from "../log.js";

/** 并发上限的兜底：与 CLI 侧同名常量同一个含义（见 suite.ts 的 MAX_CONCURRENCY）。 */
const QUEUE_MAX_CONCURRENCY = 8;

/** 场景在队列里的状态。 */
export type ScenarioState =
  | "queued"
  | "running"
  | "pass"
  | "fail"
  | "cancelled";

/**
 * 场景来源（Scenario Origin，见 CONTEXT.md）：场景进入运行队列的出处。
 *
 * - `file`：来自某个用例文件——启动时指定的那个，或运行时 `/run` 加载的；
 * - `added`：用户在交互模式里追加的；`path` 是提交那一刻的落点（没有落点则缺省）。
 *
 * 写回只发生在 `added` 上，回放脚本则按 `path` 分组（见 ADR-0005 决策四/七）。
 */
export type ScenarioOrigin =
  | { kind: "file"; path: string }
  | { kind: "added"; path?: string };

/** 队列里的一个场景。 */
export interface QueuedScenario {
  readonly id: number;
  readonly name: string;
  /** 场景正文（用例原文，占位符形式）。 */
  readonly body: string;
  /** 场景来源（见 `ScenarioOrigin`）。 */
  readonly origin: ScenarioOrigin;
  state: ScenarioState;
  /**
   * 中止信号。
   * - 运行中按 Esc／Ctrl+C → `abort()`，一路传到 bsk 子进程；
   * - 排队中被 `/cancel` → 直接改状态，不会启动。
   */
  readonly abort: AbortController;
  /** 中止说明（`state === "cancelled"` 时给出）。 */
  cancelNote?: string;
  startedAt?: number;
  finishedAt?: number;
}

/** 执行一个场景并给出终态（由调用方注入，队列不关心怎么跑）。 */
export type ScenarioExecutor = (
  item: QueuedScenario,
) => Promise<ScenarioState>;

export class ScenarioQueue {
  private readonly items: QueuedScenario[] = [];
  private nextId = 1;
  private pumping = false;

  constructor(
    private readonly execute: ScenarioExecutor,
    /** 任何状态变化后回调（界面据此重绘）。 */
    private readonly onChange: () => void,
    /**
     * 并发上限的来源。**每次派发前现取**，因此在跑的场景不受影响、
     * 之后派发的立刻用新值——`/setting` 改完就生效，不需要重开会话。
     * 不给就是 1（串行），与历史行为逐字一致。
     */
    private readonly concurrency: () => number = () => 1,
  ) {}

  /** 当前生效的并发上限（夹在 1..8，坏值退回 1）。 */
  private limit(): number {
    const raw = this.concurrency();
    if (!Number.isInteger(raw)) return 1;
    return Math.max(1, Math.min(raw, QUEUE_MAX_CONCURRENCY));
  }

  /** 入队。`origin` 记录它来自哪个用例文件，还是用户本次追加的。 */
  add(name: string, body: string, origin: ScenarioOrigin): QueuedScenario {
    const item: QueuedScenario = {
      id: this.nextId++,
      name,
      body,
      origin,
      state: "queued",
      abort: new AbortController(),
    };
    this.items.push(item);
    this.onChange();
    return item;
  }

  all(): readonly QueuedScenario[] {
    return this.items;
  }

  /** 正在跑的**第一个**（串行时就是唯一一个）。界面要展示全部时用 `runningAll()`。 */
  running(): QueuedScenario | undefined {
    return this.items.find((i) => i.state === "running");
  }

  /** 同时在跑的全部场景，按入队顺序。 */
  runningAll(): QueuedScenario[] {
    return this.items.filter((i) => i.state === "running");
  }

  waiting(): QueuedScenario[] {
    return this.items.filter((i) => i.state === "queued");
  }

  /** 队列已空且没有在跑。 */
  idle(): boolean {
    return !this.pumping && this.items.every((i) => i.state !== "running");
  }

  /**
   * 取消一个**尚未开始**的场景。
   * 已经跑起来的归 Esc 管（这里 deliberately 不碰它：中途改状态会和执行方的写入打架）。
   */
  cancel(id: number, note = "已从运行队列中取消"): QueuedScenario | undefined {
    const item = this.items.find((i) => i.id === id && i.state === "queued");
    if (!item) return undefined;
    item.state = "cancelled";
    item.cancelNote = note;
    this.onChange();
    return item;
  }

  /** 取消全部待办（Ctrl+C 收工时用），返回被取消的场景数。 */
  cancelAllWaiting(note = "已从运行队列中取消"): number {
    const waiting = this.waiting();
    for (const item of waiting) {
      item.state = "cancelled";
      item.cancelNote = note;
    }
    if (waiting.length > 0) this.onChange();
    return waiting.length;
  }

  /**
   * 中止**全部**正在运行的场景（Esc／Ctrl+C），返回被发了信号的那些。
   *
   * 并发之后「当前场景」不再唯一，所以一次到位：Esc 的语义是「我不想再等这些了」，
   * 逐个停会让人以为按了没反应（见 ADR-0013）。
   *
   * 只负责发出信号：真正的「记为已取消」由执行方在 `runAgent` 返回后判定，
   * 这样报告里的「已取消」始终来自真实的中止结果，而不是这里的乐观推测。
   */
  abortRunning(): QueuedScenario[] {
    const running = this.runningAll().filter((i) => !i.abort.signal.aborted);
    for (const item of running) item.abort.abort();
    if (running.length > 0) this.onChange();
    return running;
  }

  /**
   * 派发一个场景并把它的 promise 挂进在飞集合；返回的 promise **永不 reject**
   * （执行方抛错记失败，不让整个队列停摆）。
   */
  private dispatch(
    item: QueuedScenario,
    inFlight: Set<Promise<void>>,
  ): Promise<void> {
    item.state = "running";
    item.startedAt = Date.now();
    this.onChange();
    const task = (async () => {
      try {
        item.state = await this.execute(item);
      } catch (err) {
        item.state = "fail";
        debugLog(
          "[tui] 场景执行抛错：" +
            (err instanceof Error ? err.message : String(err)),
        );
      }
      item.finishedAt = Date.now();
      this.onChange();
    })();
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
    return task;
  }

  /**
   * 开始泵：有空位就补下一个，跑完自动接着补。
   * 重复调用是安全的（已在泵中就直接返回），因此可以在每次入队后无脑调用。
   *
   * 并发上限每一轮都现取：`/setting` 把它调大，下一刻就多派发几个；调小不会掐掉
   * 已经在跑的（那等于用户没要求的中止）——等它们结束，之后自然按新的来。
   */
  pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    void (async () => {
      const inFlight = new Set<Promise<void>>();
      try {
        for (;;) {
          while (inFlight.size < this.limit()) {
            const next = this.items.find((i) => i.state === "queued");
            if (!next) break;
            this.dispatch(next, inFlight);
          }
          if (inFlight.size === 0) break;
          await Promise.race(inFlight);
        }
      } finally {
        this.pumping = false;
        this.onChange();
      }
    })().catch((err) => {
      // 兜底：调度器自身出意外不能让 TUI 带着未处理的 rejection 退出
      // （index.ts 的 unhandledRejection 会直接 process.exit(1)）。
      this.pumping = false;
      debugLog(
        "[tui] 队列调度异常：" +
          (err instanceof Error ? err.message : String(err)),
      );
    });
  }
}
