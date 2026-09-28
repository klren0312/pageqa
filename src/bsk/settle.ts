/**
 * 「页面稳定了吗」这一问的**页面侧探针**，以及它的判定规则。
 *
 * 为什么需要它：回放的每一步失败后原本是**盲等 500ms** 再重试（见 replay.ts 的 runStepWithRetry）。
 * 实测下来这笔等待绝大多数花在证明一件早已成立的事上——「元素未找到」最常见的成因是
 * 「页面上根本没有这个元素」（录制时模型顺手点的补救按钮，回放时弹窗早就关了），
 * 再等 500ms 也不会出现。真正需要等待的只有两类：页面还在加载、动画/弹窗还在播。
 *
 * ## 为什么是「同步探针 + 外层轮询」而不是「页面内 await 一个 Promise」
 *
 * 第一版把等待写进页面：`evaluate` 一个返回 Promise 的表达式（MutationObserver + 定时器），
 * 在页面里等地。它有两个**致命的隐藏依赖**：
 * - 后台标签页里 `setInterval`/`setTimeout` 会被节流到约 1s 一次，长时间隐藏后更稀
 *   （Chrome 的 intensive throttling）。也就是说「靠定时器证明页面已经安静」在用户
 *   切走窗口之后会退化成一次几十秒的挂起，最后只能靠 bsk 的工具超时（默认 30s，
 *   我们传的是 maxMs+2s）兜底 —— 比它要替代的 500ms 盲等还慢。
 * - 页面里挂着的观察器还要负责清理，跨调用会泄漏。
 *
 * 所以改成：**每次只问一个同步问题**（当前 readyState / 有多少动画在播 / 上一个资源结束多久了），
 * 轮询由 pageqa 自己做。好处是每个问题都是瞬时回答，不依赖任何页面内的定时器，
 * 因此与标签页可见性无关；代价是加载中/动画中的场景要多几次往返——而 IPC 快路径下一次
 * 往返是毫秒级（见 ipc.ts），稳定页面则**一次就够**。
 *
 * ## 判定规则
 *
 * 三条都成立才算稳定（阈值由调用方给）：
 * 1. `document.readyState !== "loading"`；
 * 2. 没有正在运行的 Web 动画（CSS 过渡/动画就是 element-plus 那类弹窗、菜单的展开方式）；
 * 3. 距离上一个资源结束已过 `networkQuietMs`——刚拿到数据的页面通常还在渲染。
 *
 * 第 3 条读的是 Resource Timing（只含**已完成**的资源，在途请求不在里面），
 * 它是个粗但便宜的信号：宁可多等一小会儿，也别在数据刚到、页面还没排完时下结论。
 */

/** 一次探针的结果：页面此刻的同步快照。 */
export interface SettleSample {
  readyState: string;
  /** 正在运行的 Web 动画数量。 */
  animations: number;
  /** 距离上一个资源结束过去了多久（毫秒）；本页还没有任何资源时为 null。 */
  sinceLastResourceMs: number | null;
}

export interface SettleCriteria {
  /** 距离上一个资源结束多久算「网络安静」。 */
  networkQuietMs: number;
}

/**
 * 同步探针表达式：一次返回上面三个数字，**不做任何等待**。
 *
 * 刻意写成 ES5 风格的函数体：这段代码跑在**被测页面**的上下文里，
 * 不该假设页面自己做了什么 polyfill 或转译。每个 `try` 都是必要的——探针本身
 * 绝不能因为页面怪异（老浏览器没有 `getAnimations`、跨域 iframe 的 timing 被限制）
 * 而抛异常，否则「尽量少等」这件小事会把一步回放判死。
 */
export function buildSettleProbeExpression(): string {
  return [
    "(() => {",
    "  var anims = 0;",
    "  try {",
    "    var list = document.getAnimations ? document.getAnimations() : [];",
    '    for (var i = 0; i < list.length; i++) if (list[i].playState === "running") anims++;',
    "  } catch (e) {}",
    "  var since = null;",
    "  try {",
    '    var rs = performance.getEntriesByType ? performance.getEntriesByType("resource") : [];',
    "    var last = 0;",
    "    for (var j = 0; j < rs.length; j++) {",
    "      var end = rs[j].responseEnd || rs[j].startTime || 0;",
    "      if (end > last) last = end;",
    "    }",
    "    if (last > 0) since = Math.round(performance.now() - last);",
    "  } catch (e) {}",
    "  return { readyState: document.readyState, animations: anims, sinceLastResourceMs: since };",
    "})()",
  ].join("\n");
}

/**
 * 解析探针的 stdout。
 *
 * 表达式返回对象，human 模式下 CLI 打出来的就是这段紧凑 JSON（末尾换行由调用方 trim）。
 * 解析不出来（页面里抛异常时 stdout 为空、CLI 把 throw 文本写到了 stderr）返回 null，
 * 由调用方退回固定短等待。
 */
export function parseSettleSample(stdout: string): SettleSample | null {
  const text = stdout.trim();
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { readyState?: unknown; animations?: unknown; sinceLastResourceMs?: unknown };
  if (typeof o.readyState !== "string" || !o.readyState) return null;
  if (typeof o.animations !== "number" || !Number.isFinite(o.animations)) return null;
  const since =
    typeof o.sinceLastResourceMs === "number" && Number.isFinite(o.sinceLastResourceMs)
      ? o.sinceLastResourceMs
      : null;
  return { readyState: o.readyState, animations: o.animations, sinceLastResourceMs: since };
}

/** 这一份样本是否已经稳定。 */
export function isSettled(sample: SettleSample, criteria: SettleCriteria): boolean {
  if (sample.readyState === "loading") return false;
  if (sample.animations > 0) return false;
  if (sample.sinceLastResourceMs === null) return true;
  return sample.sinceLastResourceMs >= criteria.networkQuietMs;
}

/** 把一份样本压成一行，供日志与 `settle()` 的返回文本使用。 */
export function describeSample(sample: SettleSample): string {
  const last =
    sample.sinceLastResourceMs === null
      ? "（无）"
      : ` ${sample.sinceLastResourceMs}ms 前`;
  return `readyState=${sample.readyState}，动画=${sample.animations}，上个资源结束于${last}`;
}
