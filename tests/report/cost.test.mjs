import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  estimateCost,
  formatUsd,
  mergeCost,
  parseTokenPrice,
  resolveTokenPrice,
} from "../../dist/report/cost.js";
import { PRICE_SNAPSHOT } from "../../dist/report/price-snapshot.js";
import {
  attachCost,
  emptyUsage,
  formatCostLine,
  setUsdToCny,
  summarizeSuite,
} from "../../dist/report/report.js";
import { setLocale } from "../../dist/shared/i18n.js";

// 前半段（cost.ts）是纯函数测试：不碰配置文件、不看语言环境。
// 后半段（attachCost / formatCostLine / 套件汇总）在报告层，需要固定语种与汇率；
// 两者都在本文件顶部一次定死，避免用例之间互相影响。
setLocale("zh");

// 这个模块的核心取舍是**四个 token 各按自己的价**：缓存读通常只有 input 的一折，
// 把它按 input 算会高估一个数量级；而漏配的项按 0 计（不是按 input 折算）——
// 猜一个价的后果是估算偏高或偏低，而那正是这个功能最不能出的错。
/**
 * 金额断言用的容差比较。
 *
 * 钱的加法定理会带二进制浮点噪声（0.42 + 0.14 = 0.42000000000000004），
 * 用 `assert.equal` 比会把这类正常误差判成失败。这里按 1e-6 比——金额本身
 * 只显示到 4 位小数，比这更细的差对任何人都没有意义。
 */
function assertUsd(actual, expected, msg) {
  assert.ok(
    Math.abs(actual - expected) < 1e-6,
    msg ?? `期望 ${expected}，实际 ${actual}`,
  );
}

describe("价目解析：config 覆盖优先，未命中返回 null", () => {
  test("快照精确 id 优先于快照通配 *", () => {
    const exact = resolveTokenPrice("deepseek", "deepseek-chat", undefined, PRICE_SNAPSHOT);
    const wildcard = resolveTokenPrice("deepseek", "不存在的模型", undefined, PRICE_SNAPSHOT);
    assert.ok(exact && wildcard);
    // deepseek-chat 有自己的精确价（input 0.27），比 provider 通配价（0.14）贵。
    assert.equal(exact.input, 0.27);
    assert.equal(wildcard.input, 0.14);
  });

  test("config 覆盖快照（同 provider 同模型 id）", () => {
    const price = resolveTokenPrice(
      "deepseek",
      "deepseek-chat",
      { deepseek: { "deepseek-chat": { input: 1, output: 2 } } },
      PRICE_SNAPSHOT,
    );
    assert.deepEqual(price, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  });

  test("config 只配通配也能覆盖快照的精确价", () => {
    const price = resolveTokenPrice(
      "deepseek",
      "deepseek-chat",
      { deepseek: { "*": { input: 5, output: 6 } } },
      PRICE_SNAPSHOT,
    );
    assert.equal(price?.input, 5);
  });

  test("两边都没有则返回 null（调用方据此说「未配置价格」）", () => {
    // 免费网关与自建端点没有公开统一价，必须落到这里而不是猜一个 0。
    assert.equal(resolveTokenPrice("cline", "claude-sonnet-4", undefined, PRICE_SNAPSHOT), null);
    assert.equal(resolveTokenPrice("pageqa", "hunyuan-2.0-instruct", {}, PRICE_SNAPSHOT), null);
  });

  test("形状不对的条目按没配处理", () => {
    assert.equal(parseTokenPrice(undefined), null);
    assert.equal(parseTokenPrice("0.14"), null);
    assert.equal(parseTokenPrice({}), null);
    assert.equal(parseTokenPrice({ input: 0, output: 0 }), null);
    // 负数与非数字一律当 0：不猜「大概多少」。
    assert.deepEqual(parseTokenPrice({ input: -1, output: 2 }), {
      input: 0, output: 2, cacheRead: 0, cacheWrite: 0,
    });
    assert.deepEqual(parseTokenPrice({ input: "0.14", output: 2 }), {
      input: 0, output: 2, cacheRead: 0, cacheWrite: 0,
    });
  });

  test("只配 input/output 也认（缓存价缺省按 0，不折算）", () => {
    assert.deepEqual(parseTokenPrice({ input: 0.14, output: 0.28 }), {
      input: 0.14, output: 0.28, cacheRead: 0, cacheWrite: 0,
    });
  });
});

describe("费用计算：四项各按自己的价", () => {
  const price = { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0.14 };

  test("每百万 token 正好等于单价", () => {
    const est = estimateCost(
      { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
      price,
    );
    // 一百万个 token 正好等于单价本身。
    assertUsd(est.input, 0.14);
    assertUsd(est.output, 0.28);
    assertUsd(est.cacheRead, 0.014);
    assertUsd(est.cacheWrite, 0.14);
    assertUsd(est.total, 0.574);
  });

  test("缓存读按一折计，不按 input 算（否则高估十倍）", () => {
    const est = estimateCost({ input: 0, output: 0, cacheRead: 100_000, cacheWrite: 0 }, price);
    // 100k 个缓存读 token，一折价 = $0.0014；若按 input 价会高 10 倍。
    assertUsd(est.cacheRead, 0.0014);
    assertUsd(est.input, 0);
  });

  test("total 是四项之和（分项照原样留着供对账）", () => {
    const est = estimateCost(
      { input: 52_300, output: 1_800, cacheRead: 48_200, cacheWrite: 1_000 },
      price,
    );
    assertUsd(
      est.total,
      est.input + est.output + est.cacheRead + est.cacheWrite,
      "total 应当恒等于四项之和",
    );
    assertUsd(est.total, 0.008641);
  });

  test("零用量算出零费用", () => {
    const est = estimateCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, price);
    assert.equal(est.total, 0);
  });

  test("合并两份费用用于套件累加", () => {
    const a = estimateCost({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, price);
    const b = estimateCost({ input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }, price);
    const merged = mergeCost(a, b);
    assertUsd(merged.total, 0.42);
    // 缺一侧时原样返回，不补 0（套件里只有一个成员也算得出来）。
    assert.deepEqual(mergeCost(undefined, b), b);
    assert.deepEqual(mergeCost(a, undefined), a);
  });
});

describe("金额显示：量级分段", () => {
  test("小额保留 4 位有效数字（$0.0086 写成 0.01 就没了）", () => {
    // 单次测试跑几十轮正好落在这个量级，四舍五入到分会全变成 0。
    assert.equal(formatUsd(0.0005), "0.0005");
    assert.equal(formatUsd(0.0086), "0.0086");
  });

  test("中额两位、大额取整", () => {
    assert.equal(formatUsd(0.0123), "0.01");
    assert.equal(formatUsd(1.5), "1.5");
    assert.equal(formatUsd(99.9), "99.9");
    assert.equal(formatUsd(1234), "1234");
  });

  test("负数与非数字不当成金额（不输出 -0）", () => {
    assert.equal(formatUsd(0), "0");
    assert.equal(formatUsd(-1), "0");
    assert.equal(formatUsd(Number.NaN), "0");
  });

  test("尾部的 0 去掉（2.50 → 2.5，不进位）", () => {
    assert.equal(formatUsd(2.5), "2.5");
    assert.equal(formatUsd(2.0), "2");
  });

  test("比显示精度还小也别说成 0（$0 会被读成免费）", () => {
    assert.equal(formatUsd(0.00001), "<0.0001");
    // 0.0001 本身仍按四位小数正常显示，不落下界标记。
    assert.equal(formatUsd(0.0001), "0.0001");
  });
});

describe("内置价目快照", () => {
  test("收录了常用 provider，且每条都有 input/output", () => {
    // 至少覆盖这个仓库真的会用到的几家（自建端点 / 内置 provider / 国内网关）。
    for (const id of ["anthropic", "openai", "google", "deepseek", "qwen", "zhipu", "moonshot"]) {
      const byModel = PRICE_SNAPSHOT[id];
      assert.ok(byModel, `快照里应当有 ${id}`);
      assert.ok(byModel["*"], `${id} 应当有 provider 级通配价`);
      assert.ok(byModel["*"].input > 0, `${id} 通配价的 input 应当 > 0`);
      assert.ok(byModel["*"].output > 0, `${id} 通配价的 output 应当 > 0`);
    }
  });

  test("缓存读价不超过 input 价（否则快照本身就错了）", () => {
    for (const [provider, byModel] of Object.entries(PRICE_SNAPSHOT)) {
      for (const [id, p] of Object.entries(byModel)) {
        assert.ok(
          p.cacheRead <= p.input,
          `${provider}/${id} 的缓存读价（${p.cacheRead}）不应当高于 input 价（${p.input}）`,
        );
      }
    }
  });
});

/** 造一份最小报告（`attachCost` 只关心 usage）。 */
function reportWith(usage) {
  return {
    status: "pass",
    assertions: [],
    transcript: "",
    ...(usage ? { usage } : {}),
  };
}

/** 用指定用量造一份 `TokenUsage`（字段全给，避免与 `addUsage` 的缺省口径混淆）。 */
function usageOf(input, output, cacheRead, cacheWrite) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: 0,
    total: input + output + cacheRead + cacheWrite,
    calls: 1,
  };
}

describe("费用挂到报告上（attachCost）", () => {
  test("有价模型：四项各按自己的价，并写进 report.cost", () => {
    const report = reportWith(usageOf(100_000, 10_000, 50_000, 5_000));
    // deepseek-chat：input 0.27 / output 1.1 / 缓存读 0.027 / 缓存写 0.27（缺省 = input）。
    attachCost(report, { provider: "deepseek", id: "deepseek-chat" }, undefined);
    assert.ok(report.cost);
    assertUsd(report.cost.input, 0.027);
    assertUsd(report.cost.output, 0.011);
    assertUsd(report.cost.cacheRead, 0.00135);
    assertUsd(report.cost.cacheWrite, 0.00135);
    assertUsd(report.cost.total, 0.0407);
  });

  test("config 的价目能覆盖快照（自建端点靠它才有估算）", () => {
    const report = reportWith(usageOf(1_000_000, 0, 0, 0));
    attachCost(
      report,
      { provider: "pageqa", id: "hunyuan-2.0-instruct" },
      { pageqa: { "hunyuan-2.0-instruct": { input: 0.5, output: 1 } } },
    );
    assert.ok(report.cost);
    assertUsd(report.cost.total, 0.5);
  });

  test("查不到价就不写 cost（渲染层据此说「未配置价格」而不是 $0.00）", () => {
    const report = reportWith(usageOf(100, 10, 0, 0));
    attachCost(report, { provider: "cline", id: "claude-sonnet-4" }, undefined);
    assert.equal(report.cost, undefined);
    assert.equal("cost" in report, false);
  });

  test("没有模型或没有用量时安静跳过（不抛、不写 0）", () => {
    const noModel = reportWith(usageOf(100, 10, 0, 0));
    attachCost(noModel, undefined, undefined);
    assert.equal("cost" in noModel, false);

    const noUsage = reportWith(undefined);
    attachCost(noUsage, { provider: "deepseek", id: "deepseek-chat" }, undefined);
    assert.equal("cost" in noUsage, false);
  });
});

describe("费用行（formatCostLine）", () => {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 };

  test("美元与人民币并列，汇率来自配置", () => {
    setUsdToCny(10);
    try {
      const line = formatCostLine(cost);
      assert.ok(line.includes("0.01"), `应带美元金额：${line}`);
      assert.ok(line.includes("¥0.1"), `应按配置的汇率换人民币：${line}`);
    } finally {
      // 复位，避免影响同文件后续用例。
      setUsdToCny(7.1);
    }
  });

  test("坏汇率回落默认值（7.1），不把整行金额算错", () => {
    setUsdToCny(0);
    try {
      assert.ok(formatCostLine(cost).includes("¥0.07"));
    } finally {
      setUsdToCny(7.1);
    }
  });

  test("回放模式直说没调用模型（不引用户去配价目表）", () => {
    const line = formatCostLine(undefined, "replay");
    assert.ok(line.includes("回放"), line);
    assert.ok(!line.includes("未配置价格"), line);
  });

  test("没有估算时说「未配置价格」", () => {
    assert.ok(formatCostLine(undefined).includes("未配置价格"));
  });
});

describe("套件费用汇总", () => {
  function member(name, cost) {
    return {
      name,
      usage: emptyUsage(),
      report: { status: "pass", assertions: [], transcript: "", ...(cost ? { cost } : {}) },
    };
  }

  test("花过钱的成员都有估算才写总数（缺一个就不写）", () => {
    const a = { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 };
    const b = { input: 0.04, output: 0, cacheRead: 0.005, cacheWrite: 0, total: 0.045 };
    const all = summarizeSuite([member("A", a), member("B", b)]);
    assert.ok(all.cost);
    assertUsd(all.cost.total, 0.075);
    assertUsd(all.cost.cacheRead, 0.005);

    // 一半场景没价时给总数，会被读成「整套就花了这么多」——宁可没有。
    // B 必须是「真调用过模型但没估算」：一次都没调用的场景（回放 / 排队中被取消）
    // 本来就花 0，不该把总数拖没（见下一条用例）。
    const unpaid = { ...member("B", undefined), usage: { ...emptyUsage(), calls: 1 } };
    const partial = summarizeSuite([member("A", a), unpaid]);
    assert.equal(partial.cost, undefined);
  });

  test("一个估算都没有时不写 cost", () => {
    assert.equal(summarizeSuite([member("A", undefined)]).cost, undefined);
  });

  test("回放 / 没调用过模型的场景不拖累套件费用（零调用 ≠ 未配置价格）", () => {
    const model = { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 };
    const replay = {
      name: "回放",
      usage: emptyUsage(),
      report: { status: "pass", mode: "replay", assertions: [], transcript: "" },
    };
    const mixed = summarizeSuite([member("A", model), replay]);
    assert.ok(mixed.cost);
    assertUsd(mixed.cost.total, 0.01);
    // 混跑时不标「回放模式」：那会让人以为带模型的那条也是零模型跑出来的。
    assert.equal(mixed.mode, undefined);
  });

  test("全是回放：整套标 replay，且不编一个 $0 费用", () => {
    const replay = () => ({
      name: "R",
      usage: emptyUsage(),
      report: { status: "pass", mode: "replay", assertions: [], transcript: "" },
    });
    const summary = summarizeSuite([replay(), replay()]);
    assert.equal(summary.mode, "replay");
    assert.equal(summary.cost, undefined);
    assert.ok(formatCostLine(summary.cost, summary.mode).includes("回放"));
  });
});
