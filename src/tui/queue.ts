/**
 * 运行队列：交互模式下待跑场景的串行执行。
 *
 * 串行是有意的：条用例各自要独占一个 bsk session 与浏览器窗口，并发跑会让窗口抢焦点、
 * LLM 端点限流、报告归属混乱（见 ADR-0002）。
 *
 * 「提交了就一定会跑」是队列对用户的承诺，因此一个场景结束（通过／失败／已取消）后
 * 自动开始下一个，不停下来等指令。
 */
import { debugLog } from "../log.js";

/** 场景在队列里的状态。 */
export type ScenarioState =
  | "queued"
  | "running"
  | "pass"
  | "fail"
  | "cancelled";

/** 队列里的一个场景。 */
export interface QueuedScenario {
  readonly id: number;
  readonly name: string;
  /** 场景正文（用例原文，占位符形式）。 */
  readonly body: string;
  /** 是否由用户在交互模式里追加（区别于源用例文件里已有的场景）。 */
  readonly added: boolean;
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
  ) {}

  /** 入队。`added` 表示它是本次运行中由用户追加的（而非源用例文件里已有的）。 */
  add(name: string, body: string, added: boolean): QueuedScenario {
    const item: QueuedScenario = {
      id: this.nextId++,
      name,
      body,
      added,
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

  running(): QueuedScenario | undefined {
    return this.items.find((i) => i.state === "running");
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
   * 中止正在运行的场景（Esc／Ctrl+C）。
   * 只负责发出信号：真正的「记为已取消」由执行方在 `runAgent` 返回后判定，
   * 这样报告里的「已取消」始终来自真实的中止结果，而不是这里的乐观推测。
   */
  abortRunning(): QueuedScenario | undefined {
    const item = this.running();
    if (!item || item.abort.signal.aborted) return item;
    item.abort.abort();
    this.onChange();
    return item;
  }

  /**
   * 开始泵：把 queued 的场景逐个串行执行，跑完自动取下一个。
   * 重复调用是安全的（已在泵中就直接返回），因此可以在每次入队后无脑调用。
   */
  pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    void (async () => {
      try {
        for (;;) {
          const next = this.items.find((i) => i.state === "queued");
          if (!next) break;
          next.state = "running";
          next.startedAt = Date.now();
          this.onChange();
          try {
            next.state = await this.execute(next);
          } catch (err) {
            // 执行方抛错不该让整个队列停摆：记失败、继续下一个。
            next.state = "fail";
            debugLog(
              "[tui] 场景执行抛错：" +
                (err instanceof Error ? err.message : String(err)),
            );
          }
          next.finishedAt = Date.now();
          this.onChange();
        }
      } finally {
        this.pumping = false;
        this.onChange();
      }
    })();
  }
}
