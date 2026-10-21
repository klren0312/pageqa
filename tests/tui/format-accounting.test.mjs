import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FormatAccounting } from "../../dist/tui/format-accounting.js";

const PRICING = {
  p: { m: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
};

const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

describe("格式化调用的用量与费用记账", () => {
  test("按四项单价累计费用，总量与当前批次分别记账", () => {
    const accounting = new FormatAccounting(PRICING);
    accounting.record(
      { provider: "p", id: "m" },
      {
        input: 1_000_000,
        output: 500_000,
        cacheRead: 100_000,
        cacheWrite: 50_000,
        totalTokens: 1_650_000,
      },
    );

    assert.equal(accounting.total.calls, 1);
    assert.equal(accounting.total.input, 1_000_000);
    assert.equal(accounting.total.total, 1_650_000);
    assert.equal(accounting.session.input, 1_000_000);
    near(accounting.pricedCost.input, 1);
    near(accounting.pricedCost.output, 1);
    near(accounting.pricedCost.cacheRead, 0.3);
    near(accounting.pricedCost.cacheWrite, 0.2);
    near(accounting.pricedCost.total, 2.5);
  });

  test("多次调用合并费用；resetSession 只清当前批次", () => {
    const accounting = new FormatAccounting(PRICING);
    accounting.record(
      { provider: "p", id: "m" },
      { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    );
    accounting.record(
      { provider: "p", id: "m" },
      { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    );
    near(accounting.pricedCost.total, 2);
    assert.equal(accounting.total.calls, 2);
    assert.equal(accounting.session.calls, 2);

    accounting.resetSession();
    assert.equal(accounting.session.calls, 0);
    assert.equal(accounting.session.input, 0);
    assert.equal(accounting.total.calls, 2);
    near(accounting.pricedCost.total, 2);
  });

  test("用户取消的调用只进总账，不进当前批次", () => {
    const accounting = new FormatAccounting(PRICING);
    accounting.record(
      { provider: "p", id: "m" },
      { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      { session: false },
    );

    assert.equal(accounting.total.calls, 1);
    assert.equal(accounting.session.calls, 0);
    near(accounting.pricedCost.total, 1);
  });

  test("任一次调用无价目时不给部分费用，但用量照记", () => {
    const accounting = new FormatAccounting(PRICING);
    accounting.record(
      { provider: "p", id: "m" },
      { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    );
    assert.ok(accounting.pricedCost);

    accounting.record(
      { provider: "__missing__", id: "x" },
      { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 },
    );
    assert.equal(accounting.pricedCost, undefined);
    assert.equal(accounting.total.calls, 2);
    assert.equal(accounting.total.input, 1_001_000);
  });

  test("没有调用时没有费用", () => {
    const accounting = new FormatAccounting(PRICING);
    assert.equal(accounting.pricedCost, undefined);
    assert.equal(accounting.total.calls, 0);
  });

  test("mergeInto 汇入用量与已定价费用", () => {
    const accounting = new FormatAccounting(PRICING);
    accounting.record(
      { provider: "p", id: "m" },
      { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    );
    const target = {
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 15,
        calls: 1,
      },
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
    };

    accounting.mergeInto(target);
    assert.equal(target.usage.calls, 2);
    assert.equal(target.usage.input, 1_000_010);
    near(target.cost.total, 4);
  });

  test("mergeInto 遇到未定价调用时删掉不完整的费用", () => {
    const accounting = new FormatAccounting(PRICING);
    accounting.record(
      { provider: "__missing__", id: "x" },
      { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    );
    const target = {
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 15,
        calls: 1,
      },
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
    };

    accounting.mergeInto(target);
    assert.equal(target.usage.calls, 2);
    assert.equal("cost" in target, false);
  });

  test("mergeInto 在没有格式化调用时保持目标不变", () => {
    const accounting = new FormatAccounting(PRICING);
    const target = { usage: undefined, cost: undefined };

    accounting.mergeInto(target);
    assert.deepEqual(target, { usage: undefined, cost: undefined });
  });
});
