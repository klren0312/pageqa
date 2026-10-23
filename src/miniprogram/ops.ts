import { setTimeout as sleep } from "node:timers/promises";
import {
  literalAssertion,
  type AssertOutcome,
  type AssertTextOptions,
  type BskOps,
} from "../bsk/tools.js";
import type { WaitCondition } from "../bsk/condition.js";
import { slimOptionsFor, slimSnapshot } from "../shared/snapshot.js";
import {
  buildRawSnapshot,
  type BuiltSnapshot,
} from "./snapshot.js";
import {
  closeMiniprogram,
  getCurrentPage,
  getConsoleErrors,
  getMiniProgram,
  resetConsoleErrors,
} from "./connection.js";
import { UnsupportedInDriverError } from "./types.js";

const DEFAULT_WAIT_FOR_TIMEOUT_MS = 3_000;
const WAIT_FOR_POLL_MS = 150;

export interface MiniprogramOpsOptions {
  jevClient?: unknown;
  snapshotBudgetChars?: number | (() => number | undefined);
}

/**
 * 小程序驱动的操作层：实现与 bsk 同形状的 `BskOps`，但只落地有对应物的动作，
 * 其余（upload / download / wheel / hover / scroll / press / focus / blur /
 * selectOption / pickDate / assertNetwork）直接抛「不支持」。
 *
 * agent / replay / locator / 录制链直接消费它，因此无需改动（见 ADR-0020）。
 */
export function createMiniprogramOps(
  session: string,
  opts: MiniprogramOpsOptions = {},
): BskOps {
  let rawSnapshot = "";
  let lastAssertOutcome: AssertOutcome | null = null;
  let lastAssertSemantic = false;
  const refMap = new Map<number, unknown>();
  let opChain: Promise<unknown> = Promise.resolve();

  const run = <T>(
    fn: (signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    const next = opChain.then(
      () => fn(signal),
      () => fn(signal),
    );
    opChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  /**
   * 页面切换/快照在 IDE 侧是异步的：webview 尚未建好时会偶发
   * `getPageMetaByWebviewId(...) is null`，这里重试到成功为止。
   */
  const retryUntil = async (
    fn: () => Promise<void>,
    attempts = 8,
    delayMs = 800,
  ): Promise<void> => {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        await fn();
        return;
      } catch (e) {
        lastErr = e;
        await sleep(delayMs);
      }
    }
    throw lastErr;
  };

  const budget = (): number | undefined =>
    typeof opts.snapshotBudgetChars === "function"
      ? opts.snapshotBudgetChars()
      : opts.snapshotBudgetChars;

  const refreshSnapshot = async (): Promise<void> => {
    const built: BuiltSnapshot = await buildRawSnapshot();
    rawSnapshot = built.text;
    refMap.clear();
    built.handles.forEach((h, i) => refMap.set(i + 1, h));
  };

  const resolveTarget = async (target: string): Promise<unknown> => {
    const t = (target ?? "").trim();
    const m = t.match(/^@?e(\d+)$/);
    if (m) {
      const el = refMap.get(Number(m[1]));
      if (!el) {
        throw new Error(
          `引用 ${t} 在当前快照里不存在（页面可能已变化，请先 snapshot）。`,
        );
      }
      return el;
    }
    const page = await getCurrentPage();
    const el = await page.$(t);
    if (!el) {
      throw new Error(`未找到元素「${t}」（请确认选择器或先 snapshot 取编号）。`);
    }
    return el;
  };

  const unsupported = (name: string) => {
    throw new UnsupportedInDriverError(name);
  };

  return {
    session,

    lastSnapshot: () => rawSnapshot,

    navigate: (url: string, _signal?: AbortSignal) =>
      run(async () => {
        const mp = await getMiniProgram();
        let route = String(url).replace(/^mp:\/\//, "");
        // 微信小程序路由 API 要求前导 `/`（如 /pages/index/index）。
        if (!route.startsWith("/")) route = "/" + route;
        await retryUntil(async () => {
          await mp.reLaunch(route);
        });
        await retryUntil(async () => {
          await refreshSnapshot();
        });
        return rawSnapshot;
      }),

    snapshot: (_signal?: AbortSignal, _options?: { fresh?: boolean }) =>
      run(async () => {
        await refreshSnapshot();
        const slim = slimSnapshot(rawSnapshot, slimOptionsFor(budget()));
        return slim.text;
      }),

    click: (target: string, _signal?: AbortSignal) =>
      run(async () => {
        const el = await resolveTarget(target);
        await (el as any).tap?.();
        // 点击后的界面更新是异步的，而断言读的是**当前快照**：不刷新的话，
        // 断言会拿点击前的页面内容去比对（回放尤其明显：录制序列里若没有额外
        // 一步 snapshot，断言必然失败）。
        await sleep(400);
        await refreshSnapshot();
        return `已点击 ${target}`;
      }),

    fill: (target: string, value: string, _signal?: AbortSignal) =>
      run(async () => {
        const el = await resolveTarget(target);
        const e = el as any;
        if (typeof e.input === "function") await e.input(value);
        else if (typeof e.trigger === "function")
          await e.trigger("input", { value });
        else throw new Error(`元素 ${target} 不是输入框，无法 fill。`);
        await sleep(400);
        await refreshSnapshot();
        return `已在 ${target} 填入「${value}」`;
      }),

    upload: () => unsupported("upload"),
    download: () => unsupported("download"),
    hover: () => unsupported("hover"),
    scroll: () => unsupported("scroll"),
    press: () => unsupported("press"),
    wheel: () => unsupported("wheel"),
    focus: () => unsupported("focus"),
    blur: () => unsupported("blur"),
    selectOption: () => unsupported("select_option"),
    pickDate: () => unsupported("pick_date"),

    screenshot: (_options?: { out?: string }, _signal?: AbortSignal) =>
      run(async () => {
        const mp = await getMiniProgram();
        const { ensureScreenshotDirFor, recordScreenshot, screenshotPath } =
          await import("../report/screenshots.js");
        const dest = screenshotPath(new Date(), "miniprogram", _options?.out);
        ensureScreenshotDirFor(dest);
        const res = await mp.screenshot({ path: dest });
        const path = typeof res === "string" ? res : dest;
        recordScreenshot(path);
        return path;
      }),

    getHtml: (_options?: { target?: string }, _signal?: AbortSignal) =>
      run(async () => {
        const target = _options?.target ?? "";
        if (!target) throw new Error("get_html 需要一个 target（@eN 或选择器）。");
        const el = await resolveTarget(target);
        const e = el as any;
        return typeof e.wxml === "function" ? await e.wxml() : "";
      }),

    wait: (ms: number, _signal?: AbortSignal) =>
      run(async () => {
        await sleep(ms);
        return `已等待 ${ms}ms`;
      }),

    settle: (maxMs?: number, _signal?: AbortSignal) =>
      run(async () => {
        const cap = maxMs ?? 800;
        const a = await buildRawSnapshot();
        await sleep(Math.min(300, cap));
        const b = await buildRawSnapshot();
        if (a.text === b.text) return "页面已稳定";
        await sleep(Math.max(0, cap - 300));
        return `已等待页面稳定（上限 ${cap}ms）`;
      }),

    waitFor: (
      cond: WaitCondition,
      timeoutMs?: number,
      _signal?: AbortSignal,
    ) =>
      run(async () => {
        const text =
          (cond as any)?.text ?? (cond as any)?.pattern ?? "";
        const limit = timeoutMs ?? DEFAULT_WAIT_FOR_TIMEOUT_MS;
        const deadline = Date.now() + limit;
        while (Date.now() < deadline) {
          await refreshSnapshot();
          if (text && rawSnapshot.includes(text)) {
            return `条件已达成（页面已出现「${text}」）`;
          }
          await sleep(WAIT_FOR_POLL_MS);
        }
        return text
          ? `条件未在 ${limit}ms 内达成（页面未出现「${text}」）`
          : `条件未在 ${limit}ms 内达成`;
      }),

    assertText: (
      expectation: string,
      options?: AssertTextOptions,
      _signal?: AbortSignal,
    ) =>
      run(async () => {
        const absent = options?.absent ?? false;
        const lit = literalAssertion(rawSnapshot, expectation, absent);
        lastAssertSemantic = false;
        if (lit) {
          lastAssertOutcome = {
            expectation,
            pass: lit.pass,
            evidence: lit.evidence,
          };
          return lit.evidence;
        }
        // 字面未命中：小程序驱动暂不做 Jev 语义复核（避免引入额外依赖与误判），直接判不成立。
        lastAssertOutcome = {
          expectation,
          pass: false,
          evidence: `页面中未找到「${expectation}」（小程序驱动仅做字面匹配）`,
        };
        return lastAssertOutcome.evidence;
      }),

    assertNoConsoleError: (options?: { ignore?: string[] }, _signal?: AbortSignal) =>
      run(async () => {
        const errors = getConsoleErrors();
        const ignore = options?.ignore ?? [];
        const filtered = errors.filter(
          (e) => !ignore.some((p) => e.includes(p)),
        );
        const pass = filtered.length === 0;
        const evidence = pass
          ? "未发现 JavaScript 报错"
          : `发现 ${filtered.length} 条报错：${filtered.slice(0, 5).join(" | ")}`;
        lastAssertOutcome = {
          expectation: "无 JavaScript 报错",
          pass,
          evidence,
        };
        resetConsoleErrors();
        return evidence;
      }),

    assertNetwork: () => unsupported("assert_network"),

    lastAssertSemantic: () => lastAssertSemantic,

    lastAssert: () => lastAssertOutcome,
  };
}
