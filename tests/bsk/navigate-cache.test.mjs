import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  NAVIGATION_TIMING_EXPR,
  parseNavigationTiming,
  shouldHardReload,
} from "../../dist/bsk/navigate-cache.js";

const runTimingExpr = (entries) =>
  new Function(
    "performance",
    `return ${NAVIGATION_TIMING_EXPR};`,
  )({ getEntriesByType: () => entries });

describe("navigate 缓存判定", () => {
  test("文档明确走了网络：跳过硬刷新", () => {
    assert.equal(shouldHardReload({ transferSize: 12_345 }), false);
  });

  test("缓存、跨域未知、拿不到数据：保守硬刷新", () => {
    assert.equal(shouldHardReload(null), true);
    assert.equal(shouldHardReload({}), true);
    assert.equal(shouldHardReload({ transferSize: 0, decodedBodySize: 5000 }), true);
    assert.equal(shouldHardReload({ transferSize: 0, deliveryType: "cache" }), true);
    assert.equal(shouldHardReload({ transferSize: Number.NaN }), true);
  });

  test("探针表达式读取 Navigation Timing", () => {
    assert.deepEqual(
      runTimingExpr([
        { transferSize: 0, decodedBodySize: 2048, deliveryType: "cache" },
      ]),
      { transferSize: 0, decodedBodySize: 2048, deliveryType: "cache" },
    );
    assert.equal(runTimingExpr([]), null);
  });

  test("parseNavigationTiming：认不出或 null 都交给未知处理", () => {
    assert.deepEqual(
      parseNavigationTiming(
        '{"transferSize":123,"decodedBodySize":456,"deliveryType":"http"}',
      ),
      { transferSize: 123, decodedBodySize: 456, deliveryType: "http" },
    );
    assert.equal(parseNavigationTiming("null"), null);
    assert.equal(parseNavigationTiming("boom"), null);
    assert.equal(parseNavigationTiming("[]"), null);
  });
});
