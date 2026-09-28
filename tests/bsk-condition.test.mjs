import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildConfirmExpression,
  buildProbeExpression,
  describeCondition,
  needsConfirm,
  parseConfirm,
  parseProbe,
  pollUntil,
  probeSaysMaybe,
} from "../dist/bsk/condition.js";

// 纯单元测试：探针表达式是**同步**的，用最小的 document 替身在进程内真的跑一遍；
// 轮询框架的 sleep/now 都是注入的，因此时间边界（首次采样、超时、间隔夹取）可以精确断言。

function runProbe(expr, { query = () => null, text = "", innerText } = {}) {
  const doc = {
    body: { textContent: text, innerText: innerText ?? text },
    documentElement: { textContent: text },
    querySelector: query,
  };
  return new Function("document", `return ${expr};`)(doc);
}

describe("buildProbeExpression（便宜的那次采样）", () => {
  test("是合法 JS，且不依赖定时器", () => {
    assert.doesNotThrow(() => new Function(`return ${buildProbeExpression({ text: "x" })};`));
  });

  test("selector：命不命中如实反映", () => {
    const expr = buildProbeExpression({ selector: ".row" });
    assert.equal(runProbe(expr, { query: (s) => (s === ".row" ? {} : null) }).selectorHit, true);
    assert.equal(runProbe(expr).selectorHit, false);
  });

  test("gone：看的是元素**现在还在不在**", () => {
    const expr = buildProbeExpression({ gone: ".loading" });
    assert.equal(runProbe(expr, { query: () => ({}) }).selectorPresent, true);
    assert.equal(runProbe(expr).selectorPresent, false);
  });

  test("text：先用 textContent 粗筛（便宜，不触发布局）", () => {
    const expr = buildProbeExpression({ text: "导出成功" });
    assert.equal(runProbe(expr, { text: "…导出成功，共 3 行" }).textPresent, true);
    assert.equal(runProbe(expr, { text: "还没好" }).textPresent, false);
  });

  test("CSS 选择器非法（页面里抛异常）不影响其它判定，也不抛出", () => {
    const expr = buildProbeExpression({ selector: "!!!", gone: ".x" });
    const out = runProbe(expr, {
      query: (s) => {
        if (s === "!!!") throw new Error("bad selector");
        return null;
      },
    });
    assert.equal(out.selectorHit, false);
    assert.equal(out.selectorPresent, false);
  });

  test("三种条件可以同时出现在表达式里，但只有给到的那一种会被求值", () => {
    const expr = buildProbeExpression({ selector: ".a" });
    assert.match(expr, /var TXT = null;/);
    assert.match(expr, /var GONE = null;/);
  });
});

describe("buildConfirmExpression（读可见文本）", () => {
  test("判定可见命中，并给出页面当前可见文本的摘要", () => {
    const expr = buildConfirmExpression({ text: "导出成功" });
    const hit = runProbe(expr, { text: "无关", innerText: "列表\n导出成功\n完成" });
    assert.equal(hit.visibleHit, true);
    assert.equal(hit.excerpt, "列表 导出成功 完成");

    const miss = runProbe(expr, { text: "隐藏文本", innerText: "页面上没有它" });
    assert.equal(miss.visibleHit, false);
    assert.equal(miss.excerpt, "页面上没有它");
  });

  test("摘要有长度上限（证据不能长到把报告淹掉）", () => {
    const expr = buildConfirmExpression({ text: "x" });
    const out = runProbe(expr, { innerText: "啊".repeat(500) });
    assert.equal(out.excerpt.length, 160);
  });
});

describe("解析与判定", () => {
  test("parseProbe：认不出的输出返回 null（调用方按「这次没取到」继续轮询）", () => {
    assert.deepEqual(parseProbe('{"selectorHit":true,"selectorPresent":false,"textPresent":false}\n'), {
      selectorHit: true,
      selectorPresent: false,
      textPresent: false,
    });
    assert.equal(parseProbe(""), null);
    assert.equal(parseProbe("ReferenceError: document is not defined"), null);
    assert.equal(parseProbe("[1,2,3]"), null);
    assert.equal(parseProbe("null"), null);
  });

  test("parseConfirm：缺 excerpt 时给空串（不编内容）", () => {
    assert.deepEqual(parseConfirm('{"visibleHit":true}'), { visibleHit: true, excerpt: "" });
    assert.equal(parseConfirm("boom"), null);
  });

  test("probeSaysMaybe：文本类只看「字在不在 DOM 里」，最终结论交给复核", () => {
    const probe = { selectorHit: true, selectorPresent: false, textPresent: true };
    assert.equal(probeSaysMaybe({ selector: ".a" }, probe), true);
    assert.equal(probeSaysMaybe({ gone: ".a" }, probe), true); // selectorPresent=false → 已消失
    assert.equal(probeSaysMaybe({ text: "x" }, probe), true);
    assert.equal(probeSaysMaybe({}, probe), false);
    assert.equal(needsConfirm({ text: "x" }), true);
    assert.equal(needsConfirm({ selector: ".a" }), false);
    assert.equal(needsConfirm({ gone: ".a" }), false);
  });

  test("describeCondition：三种条件各说各话，空条件不装懂", () => {
    assert.equal(describeCondition({ text: "导出成功" }), "文本「导出成功」");
    assert.equal(describeCondition({ selector: ".row" }), "元素 .row");
    assert.equal(describeCondition({ gone: ".loading" }), "元素 .loading 消失");
    assert.equal(describeCondition({}), "（未指定条件）");
  });
});

describe("pollUntil（注入时钟的时间边界）", () => {
  /** 造一个可控的时钟与 sleep：sleep 推进时钟并记录每次睡多久。 */
  function fakeClock() {
    let t = 0;
    const sleeps = [];
    return {
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      sleeps,
      advance: (ms) => {
        t += ms;
      },
    };
  }

  test("第一次采样就命中：不睡、只采样一次", async () => {
    const clock = fakeClock();
    const out = await pollUntil({
      timeoutMs: 1_000,
      intervalMs: 150,
      now: clock.now,
      sleep: clock.sleep,
      sample: async () => ({ hit: true }),
      isHit: (s) => s.hit,
    });
    assert.deepEqual(out, { hit: true, last: { hit: true }, waitedMs: 0, polls: 1 });
    assert.deepEqual(clock.sleeps, []);
  });

  test("第 3 次采样命中：等待时长等于两次间隔，而不是超时上限", async () => {
    const clock = fakeClock();
    let n = 0;
    const out = await pollUntil({
      timeoutMs: 10_000,
      intervalMs: 150,
      now: clock.now,
      sleep: clock.sleep,
      sample: async () => ({ n: ++n }),
      isHit: (s) => s.n === 3,
    });
    assert.equal(out.hit, true);
    assert.equal(out.polls, 3);
    assert.equal(out.waitedMs, 300);
  });

  test("一直不命中：等满上限后返回，且最后一次间隔被夹到剩余时间", async () => {
    const clock = fakeClock();
    const out = await pollUntil({
      timeoutMs: 400,
      intervalMs: 150,
      now: clock.now,
      sleep: clock.sleep,
      sample: async () => ({ hit: false }),
      isHit: (s) => s.hit,
    });
    assert.equal(out.hit, false);
    assert.equal(out.waitedMs, 400);
    // 150 + 150 + 100：最后一段只睡到上限，不会冲过头
    assert.deepEqual(clock.sleeps, [150, 150, 100]);
    assert.equal(out.polls, 4);
  });

  test("采样取不到（null）按未命中处理，不误判为命中", async () => {
    const clock = fakeClock();
    const out = await pollUntil({
      timeoutMs: 200,
      intervalMs: 150,
      now: clock.now,
      sleep: clock.sleep,
      sample: async () => null,
      isHit: () => true, // 即便判定逻辑说命中，没有样本也不能算
    });
    assert.equal(out.hit, false);
    assert.equal(out.last, null);
  });

  test("异步判定（文本条件要两次探针）也走同一条循环", async () => {
    const clock = fakeClock();
    let n = 0;
    const out = await pollUntil({
      timeoutMs: 1_000,
      intervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      sample: async () => ({ n: ++n }),
      isHit: async (s) => s.n >= 2,
    });
    assert.equal(out.hit, true);
    assert.equal(out.polls, 2);
  });
});
