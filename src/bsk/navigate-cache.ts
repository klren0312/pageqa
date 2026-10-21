/**
 * 导航后要不要再硬刷新一次。
 *
 * 背景：浏览器遵守 HTTP 缓存，同 URL 二次 `navigate` 可能直接用旧副本，页面看起来是旧的。
 * 旧实现每次导航后都 `reload --hard`，等于所有页面都付两次文档加载。这里读 Navigation
 * Timing：只有确认文档来自缓存、或者拿不到判断依据时才刷新；明确从网络取回时跳过。
 *
 * **保守优先**：未知一律刷新。跨域文档的 `transferSize` 常为 0（没有 Timing-Allow-Origin），
 * 会被当成未知，行为退回旧版；宁可多刷一次，也不把旧页面当成新页面。
 */

/** Navigation Timing 里与缓存判断相关的字段。 */
export interface NavigationTimingSample {
  /** 文档传输字节数；0 通常意味着缓存、跨域或数据不可用。 */
  transferSize?: number;
  /** 文档解码后的字节数（诊断用）。 */
  decodedBodySize?: number;
  /** Chrome 的 `cache` / `http` 等投递类型；旧浏览器没有这个字段。 */
  deliveryType?: string;
}

/**
 * 是否需要在导航后再硬刷新。
 *
 * 只有 `transferSize > 0`（明确发生了网络传输）才跳过刷新；其余（缓存、未知、
 * 跨域拿不到数据）都刷新——这是旧行为，也是不会把旧页面当新页面的那一边。
 */
export function shouldHardReload(
  sample: NavigationTimingSample | null | undefined,
): boolean {
  if (!sample) return true;
  if (sample.deliveryType === "cache") return true;
  return !(
    typeof sample.transferSize === "number" &&
    Number.isFinite(sample.transferSize) &&
    sample.transferSize > 0
  );
}

/** 在页面里读一次 Navigation Timing 的表达式（同步，不依赖定时器）。 */
export const NAVIGATION_TIMING_EXPR = [
  "(() => {",
  "  try {",
  "    var nav = performance.getEntriesByType('navigation')[0];",
  "    if (!nav) return null;",
  "    return {",
  "      transferSize: typeof nav.transferSize === 'number' ? nav.transferSize : null,",
  "      decodedBodySize: typeof nav.decodedBodySize === 'number' ? nav.decodedBodySize : null,",
  "      deliveryType: typeof nav.deliveryType === 'string' ? nav.deliveryType : '',",
  "    };",
  "  } catch (e) { return null; }",
  "})()",
].join("\n");

/** 解析探针输出；认不出来返回 null（调用方按未知处理，即照旧硬刷新）。 */
export function parseNavigationTiming(
  out: string,
): NavigationTimingSample | null {
  const text = out.trim();
  if (!text || text === "null") return null;
  try {
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    return {
      ...(typeof o.transferSize === "number" ? { transferSize: o.transferSize } : {}),
      ...(typeof o.decodedBodySize === "number"
        ? { decodedBodySize: o.decodedBodySize }
        : {}),
      ...(typeof o.deliveryType === "string"
        ? { deliveryType: o.deliveryType }
        : {}),
    };
  } catch {
    return null;
  }
}
