import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createProbeCache } from "../../dist/agent/model-probe-cache.js";

describe("套件级模型探活缓存", () => {
  test("TTL 内复用成功结果，过期后重新探活", async () => {
    let now = 0;
    let calls = 0;
    const ensure = createProbeCache(
      async () => {
        calls += 1;
      },
      { ttlMs: 1_000, now: () => now },
    );

    await ensure();
    now = 999;
    await ensure();
    assert.equal(calls, 1);

    now = 1_000;
    await ensure();
    assert.equal(calls, 2);
  });

  test("并发调用共享同一次探活", async () => {
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const ensure = createProbeCache(
      async () => {
        calls += 1;
        await gate;
      },
      { ttlMs: 1_000, now: () => 0 },
    );

    const first = ensure();
    const second = ensure();
    assert.equal(calls, 1);
    release();
    await Promise.all([first, second]);
    assert.equal(calls, 1);
  });

  test("失败不写缓存，下一次会重试", async () => {
    let calls = 0;
    const ensure = createProbeCache(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
      },
      { ttlMs: 1_000, now: () => 0 },
    );

    await assert.rejects(ensure, /boom/);
    await ensure();
    assert.equal(calls, 2);
  });
});
