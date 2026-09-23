import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../dist/index.js";
import { parseLocale } from "../dist/i18n.js";

// 纯单元测试：parseArgs / parseLocale 都是纯函数（import index.js 不会启动 CLI，有入口守卫）。

describe("CLI 参数解析", () => {
  test("未知选项直接报错，不静默忽略（拼错的 --emti-script 不能当没发生过）", () => {
    const args = parseArgs(["--emti-script", "examples/smoke.md"]);
    assert.match(args.error ?? "", /未知选项：--emti-script/);
  });

  test("选项值以 - 开头时按缺参处理（不吞下一个 flag）", () => {
    const args = parseArgs(["--session", "--json", "case.md"]);
    assert.match(args.error ?? "", /--session 需要/);
  });

  test("-- 之后的 - 开头文本按用例输入处理", () => {
    const args = parseArgs(["--json", "--", "-打开登录页并断言"]);
    assert.equal(args.error, undefined);
    assert.equal(args.input, "-打开登录页并断言");
    assert.equal(args.json, true);
  });

  test("正常解析不受影响", () => {
    const args = parseArgs(["--json", "examples/smoke.md"]);
    assert.equal(args.error, undefined);
    assert.equal(args.input, "examples/smoke.md");
    assert.equal(args.json, true);
  });
});

describe("parseLocale", () => {
  test("en 前缀都算英文（en / en-US / EN）", () => {
    assert.equal(parseLocale("en"), "en");
    assert.equal(parseLocale("en-US"), "en");
    assert.equal(parseLocale("EN"), "en");
  });

  test("未知值与空值回退中文", () => {
    assert.equal(parseLocale("fr"), "zh");
    assert.equal(parseLocale(undefined), "zh");
  });
});
