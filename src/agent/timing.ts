/**
 * 耗时构成统计：一次运行里，墙钟时间都花在哪了。
 *
 * 为什么需要它（这是它存在的**唯一**理由）：讨论「怎么提速」时最缺的不是猜测，而是分布。
 * 这些数字本来就散在各处——LLM 往返次数在 `usage.calls` 里、每条 bsk 命令的耗时在回放的
 * trace（`[replay-ok] #k click 123ms`）与 stderr 的逐步日志里、墙钟只有报告末尾一个总数——
 * 没人把它们合起来看过，于是「该优化哪里」只能靠感觉。有了这张表才能回答两个真问题：
 * - 「少一次 LLM 往返」值多少？（看 LLM 次数 × 平均耗时）
 * - 「命令本身快不快」？（看浏览器命令的次数 × 平均耗时，以及哪一类最贵）
 *
 * 数据来源与口径：
 * - **LLM**：`turn_start` → `turn_end` 的墙钟**减去**该轮内的工具耗时。pi-agent-core 的一轮
 *   包含「provider 请求 + 该轮工具执行」（见 agent-loop.js：turn_end 在 toolResults 之后发），
 *   所以不减就把它算进 LLM 里了。
 * - **工具/命令**：`tool_execution_start` → `tool_execution_end` 的墙钟（按 toolCallId 配对）。
 *   并行工具调用时各条的耗时可能互相重叠，累加值会略大于真实占用——这里如实累加，
 *   因为「这些命令各自花了多久」比「它们合起来占了多少墙钟」更有指导意义。
 * - **其它**：墙钟减去上面两部分，含编排、等待、收尾与进程启动。
 *
 * 纯计算 + 纯渲染（不碰 I/O、不看语言环境），便于单测；落点由调用方决定
 * （agent.ts / replay.ts 把它写进日志，TUI 与批处理都从日志里看到）。
 */

import { t } from "../shared/i18n.js";
import type { TokenUsage } from "../report/report.js";

/**
 * 毫秒 → 人类可读。
 *
 * 1 秒以下**保留毫秒**：命令耗时大多落在这个量级，写成 `0.1s` 会把 60ms 与 140ms
 * 说成同一件事，而这张表的全部意义就是把「贵在哪」看清楚。1 秒以上用与 HTML 报告
 * 同款的 `1.2s` / `1m5s` 写法。
 */
export function formatMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return (ms / 1000).toFixed(1) + "s";
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

/** 一类工具/命令的累计。 */
export interface TimingCommandStat {
  /** 工具名（`click` / `snapshot`…）或回放步骤类型（`assert_text`…）。 */
  name: string;
  calls: number;
  totalMs: number;
  /** 失败次数（工具报错；回放里是抛错的那一类，不含「元素未找到」的跳过）。 */
  errors: number;
}

export interface TimingSummary {
  /** 本次运行的墙钟（毫秒）。 */
  wallMs: number;
  llm: { calls: number; totalMs: number };
  commands: { calls: number; totalMs: number; errors: number; byName: TimingCommandStat[] };
  /** 墙钟里既不属于 LLM、也不属于工具的余量（编排/等待/收尾）。 */
  otherMs: number;
  usage?: TokenUsage;
}

/** 命令明细表最多渲染几行（其余折成一行「还有 N 种」）。 */
const MAX_COMMAND_LINES = 6;

/**
 * 事件流的累加器。
 *
 * 只做加法，不做判断：事件顺序由 pi-agent-core 保证，这里按到达顺序配对时间戳。
 * 没配对上的一律忽略（例如被中止的那一轮 `turn_start` 没有 `turn_end`），
 * 不上报半条数据——统计可以把一次运行说少，但不能说错。
 */
export class TimingCollector {
  private turnStartedAt: number | null = null;
  private llmTotal = 0;
  private llmCalls = 0;
  /** 当前这一轮里已结束的工具耗时（用于从轮耗时里减掉）。 */
  private turnToolMs = 0;
  private readonly toolStartedAt = new Map<string, number>();
  private readonly byName = new Map<string, TimingCommandStat>();
  private errors = 0;

  noteTurnStart(now: number = Date.now()): void {
    this.turnStartedAt = now;
    this.turnToolMs = 0;
  }

  noteTurnEnd(now: number = Date.now()): void {
    if (this.turnStartedAt === null) return;
    const turnMs = Math.max(0, now - this.turnStartedAt);
    // 一轮 = provider 请求 + 该轮工具执行：不减掉工具耗时就会把浏览器时间算进模型时间里，
    // 那正是这张表最要避免的一种错法。
    this.llmTotal += Math.max(0, turnMs - this.turnToolMs);
    this.llmCalls += 1;
    this.turnStartedAt = null;
    this.turnToolMs = 0;
  }

  noteToolStart(toolCallId: string): void {
    this.toolStartedAt.set(toolCallId, Date.now());
  }

  noteToolEnd(toolCallId: string, name: string, isError = false): void {
    const startedAt = this.toolStartedAt.get(toolCallId);
    this.toolStartedAt.delete(toolCallId);
    if (startedAt === undefined) return;
    this.noteCommand(name, Math.max(0, Date.now() - startedAt), isError);
  }

  /** 直接记一条已知道耗时的命令（回放的每一步走这里，它自己已经量过）。 */
  noteCommand(name: string, ms: number, isError = false): void {
    const stat = this.byName.get(name) ?? { name, calls: 0, totalMs: 0, errors: 0 };
    stat.calls += 1;
    stat.totalMs += Math.max(0, ms);
    if (isError) {
      stat.errors += 1;
      this.errors += 1;
    }
    this.byName.set(name, stat);
    // 只在这条命令落在某一轮之内时才从该轮里扣：回放的命令不在任何轮里。
    if (this.turnStartedAt !== null) this.turnToolMs += Math.max(0, ms);
  }

  /** 汇总；`wallMs` 由调用方给（它才知道这次运行从哪算起）。 */
  summary(wallMs: number, usage?: TokenUsage): TimingSummary {
    let commandCalls = 0;
    let commandMs = 0;
    for (const stat of this.byName.values()) {
      commandCalls += stat.calls;
      commandMs += stat.totalMs;
    }
    const byName = [...this.byName.values()].sort(
      (a, b) => b.totalMs - a.totalMs || a.name.localeCompare(b.name),
    );
    return {
      wallMs: Math.max(0, wallMs),
      llm: { calls: this.llmCalls, totalMs: this.llmTotal },
      commands: { calls: commandCalls, totalMs: commandMs, errors: this.errors, byName },
      // 余量可能为负（并行工具让累加值大于轮耗时）：夹到 0，不报一个负的「其它」。
      otherMs: Math.max(0, Math.max(0, wallMs) - this.llmTotal - commandMs),
      ...(usage ? { usage } : {}),
    };
  }
}

/** 占比（0..100 的整数）；总数为 0 时返回 0（不产生 NaN）。 */
function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

/** 平均耗时（毫秒，四舍五入）；次数为 0 时返回 0。 */
export function avgMs(totalMs: number, calls: number): number {
  if (calls <= 0) return 0;
  return Math.round(totalMs / calls);
}

/**
 * 渲染成若干行（交给调用方写日志）。
 *
 * 一次运行**至少**给两行：墙钟在哪去 + 模型/命令两行；命令明细按耗时降序取前若干条。
 * 刻意不打印「占比很小」的明细——那些行会把真正贵的那几条挤下去。
 */
export function renderTiming(summary: TimingSummary): string[] {
  const lines: string[] = [t("timing.title", { wall: formatMs(summary.wallMs) })];
  const { wallMs, llm, commands } = summary;

  if (llm.calls > 0) {
    lines.push(
      t("timing.llm", {
        calls: llm.calls,
        total: formatMs(llm.totalMs),
        pct: percent(llm.totalMs, wallMs),
        avg: formatMs(avgMs(llm.totalMs, llm.calls)),
      }),
    );
  }
  if (commands.calls > 0) {
    lines.push(
      t("timing.commands", {
        calls: commands.calls,
        total: formatMs(commands.totalMs),
        pct: percent(commands.totalMs, wallMs),
        avg: formatMs(avgMs(commands.totalMs, commands.calls)),
        errors: commands.errors
          ? t("timing.commands.errors", { errors: commands.errors })
          : "",
      }),
    );
    for (const stat of commands.byName.slice(0, MAX_COMMAND_LINES)) {
      lines.push(
        t("timing.commandLine", {
          // 对齐放在渲染层（i18n 模板不做排版）：工具名都是 ASCII，padEnd 就够了。
          name: stat.name.padEnd(10),
          calls: stat.calls,
          total: formatMs(stat.totalMs),
          avg: formatMs(avgMs(stat.totalMs, stat.calls)),
          errors: stat.errors ? t("timing.commandLine.errors", { errors: stat.errors }) : "",
        }),
      );
    }
    const rest = commands.byName.length - MAX_COMMAND_LINES;
    if (rest > 0) lines.push(t("timing.commandRest", { n: rest }));
  }
  lines.push(
    t("timing.other", {
      total: formatMs(summary.otherMs),
      pct: percent(summary.otherMs, wallMs),
    }),
  );
  if (summary.usage && summary.usage.calls > 0) {
    lines.push(
      t("timing.tokens", {
        input: summary.usage.input,
        output: summary.usage.output,
        cache: summary.usage.cacheRead,
        calls: summary.usage.calls,
      }),
    );
  }
  return lines;
}
