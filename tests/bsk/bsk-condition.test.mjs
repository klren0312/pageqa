import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildConfirmExpression,
  buildProbeExpression,
  clampWaitMs,
  conditionState,
  describeCondition,
  describeProbe,
  describeState,
  ELEMENT_STATES,
  isElementState,
  MAX_TEXT_WAIT_MS,
  needsConfirm,
  parseConfirm,
  parseProbe,
  pollUntil,
  probeSaysMaybe,
} from "../../dist/bsk/condition.js";

// 纯单元测试：探针表达式是**同步**的，用最小的 document 替身在进程内真的跑一遍；
// 轮询框架的 sleep/now 都是注入的，因此时间边界（首次采样、超时、间隔夹取）可以精确断言。

/**
 * 跑一次探针。
 *
 * `visible` 控制假元素算不算可见：给了 `checkVisibility` 就按它（与页面里的首选项一致），
 * 不给就落到 computed style 兜底分支——两条分支都必须能被测到，否则「降级路径说可见、
 * 原生等待说不可见」这种差异会漏网。
 */
function runProbe(expr, { query = () => null, text = "", innerText, visible = true } = {}) {
  const style = {
    display: visible ? "block" : "none",
    visibility: "visible",
    opacity: "1",
  };
  const doc = {
    body: { textContent: text, innerText: innerText ?? text },
    documentElement: { textContent: text },
    querySelector: query,
  };
  const win = {
    getComputedStyle: () => style,
  };
  return new Function("document", "window", `return ${expr};`)(doc, win);
}

/** 一个永远「可见」的假元素（`checkVisibility` 优先分支）。 */
function element(checkVisibility) {
  return {
    ...(checkVisibility === undefined ? {} : { checkVisibility: () => checkVisibility }),
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
  };
}

describe("buildProbeExpression（便宜的那次采样）", () => {
  test("是合法 JS，且不依赖定时器", () => {
    assert.doesNotThrow(() => new Function(`return ${buildProbeExpression({ text: "x" })};`));
  });

  test("selector：命不命中如实反映", () => {
    const expr = buildProbeExpression({ selector: ".row" });
    assert.equal(
      runProbe(expr, { query: (s) => (s === ".row" ? element(true) : null) }).selectorHit,
      true,
    );
    assert.equal(runProbe(expr).selectorHit, false);
  });

  test("selector：命中不等于可见（与 bsk 的 attached / visible 两个事实对应）", () => {
    const expr = buildProbeExpression({ selector: ".mask" });
    const hidden = runProbe(expr, { query: () => element(false) });
    assert.equal(hidden.selectorHit, true);
    assert.equal(hidden.selectorVisible, false);

    const shown = runProbe(expr, { query: () => element(true) });
    assert.equal(shown.selectorVisible, true);
  });

  test("selector：没有 checkVisibility 的页面走 computed style / 盒子兜底", () => {
    const expr = buildProbeExpression({ selector: ".mask" });
    // 无 checkVisibility + display:none → 不可见
    assert.equal(
      runProbe(expr, { query: () => element(), visible: false }).selectorVisible,
      false,
    );
    // 无 checkVisibility + 可见样式 → 可见
    assert.equal(runProbe(expr, { query: () => element() }).selectorVisible, true);
    // 零尺寸盒子 → 不可见（opacity/visibility 都正常）
    assert.equal(
      runProbe(expr, {
        query: () => ({ getBoundingClientRect: () => ({ width: 0, height: 0 }) }),
      }).selectorVisible,
      false,
    );
  });

  test("gone：看的是元素**现在还在不在 / 可不可见**", () => {
    const expr = buildProbeExpression({ gone: ".loading" });
    assert.equal(runProbe(expr, { query: () => element(true) }).gonePresent, true);
    // v-show 隐藏的遮罩留在 DOM 里：还在，但不可见——这正是 gone 要等的那件事
    const hiddenMask = runProbe(expr, { query: () => element(false) });
    assert.equal(hiddenMask.gonePresent, true);
    assert.equal(hiddenMask.goneVisible, false);
    assert.equal(runProbe(expr).gonePresent, false);
  });

  test("text：先用 textContent 粗筛（便宜，不触发布局）", () => {
    const expr = buildProbeExpression({ text: "导出成功" });
    assert.equal(runProbe(expr, { text: "…导出成功，共 3 行" }).textPresent, true);
    assert.equal(runProbe(expr, { text: "还没好" }).textPresent, false);
  });

  test("text：换行/多空格与跨节点拆分不会被误判为未出现", () => {
    const expr = buildProbeExpression({ text: "处理中 10 份" });
    // innerText 常把同一行文案拆成换行；textContent 甚至可能没有空格。
    assert.equal(runProbe(expr, { text: "处理中\n10\n份" }).textPresent, true);
    assert.equal(runProbe(expr, { text: "处理中10份" }).textPresent, true);
    assert.equal(runProbe(expr, { text: "处理中 11 份" }).textPresent, false);
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
    assert.equal(out.selectorVisible, false);
    assert.equal(out.gonePresent, false);
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

  test("可见文本匹配同样归一化空白与跨节点拆分", () => {
    const expr = buildConfirmExpression({ text: "处理中 10 份" });
    assert.equal(
      runProbe(expr, { innerText: "全部工单 30 份\n处理中\n10\n份\n" }).visibleHit,
      true,
    );
    assert.equal(
      runProbe(expr, { innerText: "全部工单 30 份 处理中10份" }).visibleHit,
      true,
    );
    assert.equal(
      runProbe(expr, { innerText: "全部工单 30 份 处理中 11 份" }).visibleHit,
      false,
    );
  });
});

describe("等待预算", () => {
  test("文本条件最多等 5 秒，元素条件保留原预算", () => {
    assert.equal(MAX_TEXT_WAIT_MS, 5_000);
    assert.equal(clampWaitMs({ text: "x" }, 30_000), 5_000);
    assert.equal(clampWaitMs({ text: "x" }, 3_000), 3_000);
    assert.equal(clampWaitMs({ selector: ".row" }, 15_000), 15_000);
    assert.equal(clampWaitMs({ gone: ".mask" }, 30_000), 30_000);
  });
});

describe("解析与判定", () => {
  test("parseProbe：认不出的输出返回 null（调用方按「这次没取到」继续轮询）", () => {
    assert.deepEqual(
      parseProbe(
        '{"selectorHit":true,"selectorVisible":false,"gonePresent":true,"goneVisible":false,"textPresent":false}\n',
      ),
      {
        selectorHit: true,
        selectorVisible: false,
        gonePresent: true,
        goneVisible: false,
        textPresent: false,
      },
    );
    // 缺字段一律当 false：认不出来时不能凭空说「可见」。
    assert.deepEqual(parseProbe('{"selectorHit":true}'), {
      selectorHit: true,
      selectorVisible: false,
      gonePresent: false,
      goneVisible: false,
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
    const probe = {
      selectorHit: true,
      selectorVisible: true,
      gonePresent: false,
      goneVisible: false,
      textPresent: true,
    };
    assert.equal(probeSaysMaybe({ selector: ".a" }, probe), true);
    assert.equal(probeSaysMaybe({ gone: ".a" }, probe), true); // 不在 DOM 也不可见 → 已消失
    assert.equal(probeSaysMaybe({ text: "x" }, probe), true);
    assert.equal(probeSaysMaybe({}, probe), false);
    assert.equal(needsConfirm({ text: "x" }), true);
    assert.equal(needsConfirm({ selector: ".a" }), false);
    assert.equal(needsConfirm({ gone: ".a" }), false);
  });

  test("probeSaysMaybe：状态矩阵与 bsk 的 satisfied_by(attached, visible) 逐条一致", () => {
    // 四种观测 × 四种状态，全部钉死：两套实现（原生等待 / 探针降级）必须给同一个结论，
    // 否则「旧版 bsk 通过、新版超时」会变成一条查不出来的差异。
    const cases = [
      // [在 DOM, 可见, 期望命中集合]
      [true, true, ["visible", "attached"]],
      [true, false, ["hidden", "attached"]],
      [false, false, ["hidden", "detached"]],
    ];
    for (const [attached, visible, hits] of cases) {
      const probe = {
        selectorHit: attached,
        selectorVisible: visible,
        gonePresent: attached,
        goneVisible: visible,
        textPresent: false,
      };
      for (const state of ELEMENT_STATES) {
        assert.equal(
          probeSaysMaybe({ selector: ".x", state }, probe),
          hits.includes(state),
          `attached=${attached} visible=${visible} state=${state}`,
        );
      }
    }
  });

  test("conditionState：gone 归一成 hidden，selector 缺省 visible，文本没有状态", () => {
    assert.equal(conditionState({ text: "x" }), null);
    assert.equal(conditionState({ gone: ".mask" }), "hidden");
    assert.equal(conditionState({ selector: ".row" }), "visible");
    assert.equal(conditionState({ selector: ".row", state: "detached" }), "detached");
    assert.equal(isElementState("hidden"), true);
    assert.equal(isElementState("clickable"), false);
    assert.equal(isElementState(undefined), false);
  });

  test("describeProbe：超时报告把「在不在 DOM」与「可不可见」分开说", () => {
    const probe = {
      selectorHit: true,
      selectorVisible: false,
      gonePresent: false,
      goneVisible: false,
      textPresent: false,
    };
    assert.equal(describeProbe({ selector: ".x" }, probe), "末次探测：还在 DOM=true，可见=false");
    assert.equal(describeProbe({ gone: ".x" }, probe), "末次探测：还在 DOM=false，可见=false");
  });

  test("describeCondition：三种条件各说各话，空条件不装懂", () => {
    assert.equal(describeCondition({ text: "导出成功" }), "文本「导出成功」");
    assert.equal(describeCondition({ selector: ".row" }), "元素 .row 可见");
    assert.equal(describeCondition({ selector: ".row", state: "attached" }), "元素 .row 已进入 DOM");
    assert.equal(describeCondition({ gone: ".loading" }), "元素 .loading 消失");
    assert.equal(describeCondition({}), "（未指定条件）");
    assert.equal(describeState("detached"), "已离开 DOM");
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
