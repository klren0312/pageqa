import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildSettleProbeExpression,
  describeSample,
  isSettled,
  parseSettleSample,
} from "../dist/bsk/settle.js";

// 纯单元测试：探针表达式是**同步**的，所以可以在进程内用最小的 document/performance 替身
// 真的执行一遍，而不是只做字符串断言。

/** 在替身环境里求值探针。 */
function runProbe({ readyState = "complete", animations = [], resources = [], now = 10_000 } = {}) {
  const doc = {
    readyState,
    getAnimations: () => animations.map((playState) => ({ playState })),
  };
  const perf = {
    now: () => now,
    getEntriesByType: () => resources,
  };
  const fn = new Function(
    "document",
    "performance",
    `return ${buildSettleProbeExpression()};`,
  );
  return fn(doc, perf);
}

describe("buildSettleProbeExpression", () => {
  test("是合法 JS", () => {
    assert.doesNotThrow(() => new Function(`return ${buildSettleProbeExpression()};`));
  });

  test("同步读取 readyState / 运行中动画 / 上个资源结束多久", () => {
    const sample = runProbe({
      readyState: "interactive",
      animations: ["running", "finished", "running"],
      resources: [{ responseEnd: 9_400 }, { responseEnd: 9_900, startTime: 9_000 }],
      now: 10_000,
    });
    assert.deepEqual(sample, {
      readyState: "interactive",
      animations: 2,
      sinceLastResourceMs: 100,
    });
  });

  test("没有任何资源时 sinceLastResourceMs 为 null（而不是 -1 这种假数字）", () => {
    assert.deepEqual(runProbe({ resources: [] }), {
      readyState: "complete",
      animations: 0,
      sinceLastResourceMs: null,
    });
  });

  test("页面怪异（没有 getAnimations / 没有 Resource Timing）时也不抛异常", () => {
    const fn = new Function("document", "performance", `return ${buildSettleProbeExpression()};`);
    const out = fn({ readyState: "loading" }, { now: () => 0 });
    assert.deepEqual(out, { readyState: "loading", animations: 0, sinceLastResourceMs: null });
  });

  test("探针本身不做任何等待：同步返回", () => {
    const t = Date.now();
    runProbe();
    assert.ok(Date.now() - t < 50);
  });
});

describe("parseSettleSample", () => {
  test("解析正常返回（含末尾换行）", () => {
    assert.deepEqual(
      parseSettleSample('{"readyState":"complete","animations":0,"sinceLastResourceMs":420}\n'),
      { readyState: "complete", animations: 0, sinceLastResourceMs: 420 },
    );
  });

  test("sinceLastResourceMs 缺失或非法 → null（不是 0）", () => {
    assert.equal(parseSettleSample('{"readyState":"complete","animations":0}').sinceLastResourceMs, null);
    assert.equal(
      parseSettleSample('{"readyState":"complete","animations":0,"sinceLastResourceMs":null}')
        .sinceLastResourceMs,
      null,
    );
  });

  test("页面抛异常（stdout 为空或非 JSON）→ null，调用方退回固定等待", () => {
    assert.equal(parseSettleSample(""), null);
    assert.equal(parseSettleSample("   \n"), null);
    assert.equal(parseSettleSample("ReferenceError: document is not defined"), null);
    assert.equal(parseSettleSample("[1,2,3]"), null);
    assert.equal(parseSettleSample("null"), null);
  });

  test("缺关键字段 → null（宁可退回固定等待，也不猜）", () => {
    assert.equal(parseSettleSample('{"animations":0}'), null);
    assert.equal(parseSettleSample('{"readyState":"","animations":0}'), null);
    assert.equal(parseSettleSample('{"readyState":"complete"}'), null);
    assert.equal(parseSettleSample('{"readyState":"complete","animations":"0"}'), null);
  });
});

describe("isSettled", () => {
  const criteria = { networkQuietMs: 200 };
  const sample = (over = {}) => ({
    readyState: "complete",
    animations: 0,
    sinceLastResourceMs: null,
    ...over,
  });

  test("已加载 + 无动画 + 没有资源 → 稳定", () => {
    assert.equal(isSettled(sample(), criteria), true);
  });

  test("还在 loading → 不稳定（哪怕没有动画）", () => {
    assert.equal(isSettled(sample({ readyState: "loading" }), criteria), false);
  });

  test("有动画在播 → 不稳定（CSS 过渡就是弹窗/菜单的展开方式）", () => {
    assert.equal(isSettled(sample({ animations: 1 }), criteria), false);
  });

  test("网络安静窗口是闭区间：刚够阈值即稳定，差一点则再等", () => {
    assert.equal(isSettled(sample({ sinceLastResourceMs: 199 }), criteria), false);
    assert.equal(isSettled(sample({ sinceLastResourceMs: 200 }), criteria), true);
    assert.equal(isSettled(sample({ sinceLastResourceMs: 5_000 }), criteria), true);
  });
});

describe("describeSample", () => {
  test("压成一行，无资源时如实写「无」", () => {
    assert.equal(
      describeSample({ readyState: "complete", animations: 0, sinceLastResourceMs: 420 }),
      "readyState=complete，动画=0，上个资源结束于 420ms 前",
    );
    assert.equal(
      describeSample({ readyState: "loading", animations: 2, sinceLastResourceMs: null }),
      "readyState=loading，动画=2，上个资源结束于（无）",
    );
  });
});
