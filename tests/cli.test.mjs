import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../dist/index.js";
import { getLocale, parseLocale, setLocale, t } from "../dist/i18n.js";

// 纯单元测试：parseArgs / parseLocale 都是纯函数（import index.js 不会启动 CLI，有入口守卫）。

/**
 * 并发量相关文案必须两种语种都有。
 *
 * 加一个功能时最容易漏的就是「中文加了、英文忘了」——`t()` 缺译时会把 key 原样返回，
 * 于是界面上出现一行 `tui.setting.concurrency`，只有人肉跑到那里才会发现。
 */
describe("并发量的文案两种语种都不缺", () => {
  const KEYS = [
    "log.suiteParallel",
    "tui.runningMany",
    "tui.usage.cacheHit",
    "tui.abortScene",
    "tui.abortingCurrent",
    "tui.setting.concurrency",
    "tui.setting.concurrencyTitle",
    "tui.setting.concurrencyOne",
    "tui.setting.concurrencyMany",
    "tui.setting.concurrencyCurrent",
    "tui.setting.concurrencySaved",
    "err.concurrencyRequired",
    "err.concurrencyInvalid",
    "err.concurrencyMax",
    "err.concurrencyWithReplay",
  ];

  test("zh 与 en 都能渲染出文案（而不是把 key 原样返回）", () => {
    const previous = getLocale();
    try {
      for (const locale of ["zh", "en"]) {
        setLocale(locale);
        for (const key of KEYS) {
          assert.notEqual(t(key), key, `${locale} 缺译：${key}`);
        }
      }
    } finally {
      setLocale(previous);
    }
  });
});

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
