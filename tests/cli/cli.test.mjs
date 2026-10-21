import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../../dist/index.js";
import { getLocale, parseLocale, setLocale, t } from "../../dist/shared/i18n.js";

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
    "err.concurrencyWithSession",
    // --settle-waits 的说明与起始提示
    "replay.log.settleWaits",
    // --locate-timeout 的报错、等待提示与证据文案
    "err.locateTimeoutRequired",
    "err.locateTimeoutInvalid",
    "replay.log.waitReady",
    "replay.wait.trace",
    "replay.locate.missWaiting",
    "replay.locate.regionPresent",
    "replay.locate.regionOverlay",
    "help.full",
    // `pageqa lint` 子命令的帮助、报错与预检提示
    "help.lint",
    "err.lintNeedsFile",
    "err.lintDir",
    "err.lintNotFound",
    "lint.hint",
    // 动作后附「可交互元素清单」与「引用失效自愈」用到的文案
    "bsk.refs.afterAction",
    "bsk.refs.forRetry",
    "bsk.refs.failed",
    // 思考模式开关（thinkingFormat）的启动提示
    "log.thinkingOff",
    "log.thinkingOffNoop",
    "log.thinkingBad",
    "log.thinkingAuto",
    "log.thinkingOffExplicit",
    "log.thinkingDowngraded",
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

/**
 * 走 `err.param` 的报错文案不能自带前缀。
 *
 * 有两条路径会给消息套一层「参数错误：」：main 里的 `args.error` 与
 * `detectInteractive().error`。文案自己再写一遍就打成「参数错误：参数错误：…」
 * ——`err.concurrencyInvalid` 与 `err.onlyWithTui` 都真实发生过。
 */
describe("会被 err.param 套前缀的报错，自己不带前缀", () => {
  // 只列走 args.error / detectInteractive().error 的键；直接写 stderr 的那些
  // （err.concurrencyMax、err.onlyWithReplay、err.concurrencyWithSession…）自带前缀，不在列。
  const WRAPPED = [
    "err.concurrencyInvalid",
    "err.locateTimeoutInvalid",
    "err.onlyWithTui",
  ];

  test("zh 与 en 都不重复前缀", () => {
    const previous = getLocale();
    try {
      for (const locale of ["zh", "en"]) {
        setLocale(locale);
        for (const key of WRAPPED) {
          assert.doesNotMatch(
            t(key, { value: "x", n: 1, max: 1 }),
            /^(参数错误：|argument error:)/,
            `${locale} 自带前缀：${key}`,
          );
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
    const args = parseArgs(["run", "--json", "--", "-打开登录页并断言"]);
    assert.equal(args.error, undefined);
    assert.equal(args.input, "-打开登录页并断言");
    assert.equal(args.json, true);
    assert.equal(args.explicitRun, true);
  });

  test("正常解析：run 子命令收用例文件与选项", () => {
    const args = parseArgs(["run", "--json", "examples/smoke.md"]);
    assert.equal(args.error, undefined);
    assert.equal(args.input, "examples/smoke.md");
    assert.equal(args.json, true);
    assert.equal(args.explicitRun, true);
  });

  test("裸的 pageqa <用例> 被拒绝，必须显式 run", () => {
    for (const argv of [["examples/smoke.md"], ["case.md"], ["sesions"]]) {
      const args = parseArgs(argv);
      assert.match(args.error ?? "", /已移除直接 `pageqa <用例>`/);
      assert.equal(args.explicitRun, false);
    }
  });

  test("--tui 不接用例；run 不能与 --tui / --replay 同用", () => {
    const tui = parseArgs(["--tui"]);
    assert.equal(tui.error, undefined);
    assert.match(
      parseArgs(["--tui", "examples/smoke.md"]).error ?? "",
      /已移除直接 `pageqa <用例>`/,
    );

    assert.match(
      parseArgs(["run", "--tui", "examples/smoke.md"]).error ?? "",
      /不能与 `--tui`/,
    );
    assert.match(
      parseArgs(["run", "--replay", "a.json"]).error ?? "",
      /不能与 `--replay`/,
    );
    assert.match(parseArgs(["run"]).error ?? "", /需要用例文件或内联文本/);
  });

  test("--quiet-side-outputs 默认关，显式给出才开（子进程专用：收尾不打产物清单）", () => {
    assert.equal(parseArgs(["run", "case.md"]).quietSideOutputs, false);
    const on = parseArgs(["run", "--quiet-side-outputs", "--json", "case.md"]);
    assert.equal(on.error, undefined);
    assert.equal(on.quietSideOutputs, true);
    assert.equal(on.json, true);
  });

  test("--no-pager 是布尔开关", () => {
    assert.equal(parseArgs(["--no-pager"]).noPager, true);
    assert.equal(parseArgs(["-h", "--no-pager"]).noPager, true);
    assert.equal(parseArgs(["-h"]).noPager, false);
  });

  test("--prefer-replay 是布尔开关", () => {
    assert.equal(parseArgs(["run", "case.md"]).preferReplay, false);
    const on = parseArgs(["run", "--prefer-replay", "case.md"]);
    assert.equal(on.error, undefined);
    assert.equal(on.preferReplay, true);
    assert.equal(on.input, "case.md");
  });

  test("--settle-waits 默认关，显式给出才开", () => {
    assert.equal(parseArgs(["--replay", "a.json"]).settleWaits, false);
    const on = parseArgs(["--replay", "a.json", "--settle-waits"]);
    assert.equal(on.error, undefined);
    assert.equal(on.settleWaits, true);
    assert.equal(on.replay, "a.json");
  });

  test("--locate-timeout 收非负整数，不给就用回放里的默认值", () => {
    assert.equal(parseArgs(["--replay", "a.json"]).locateTimeoutMs, undefined);
    const zero = parseArgs(["--replay", "a.json", "--locate-timeout", "0"]);
    assert.equal(zero.error, undefined);
    assert.equal(zero.locateTimeoutMs, 0);
    assert.equal(
      parseArgs(["--replay", "a.json", "--locate-timeout", "1500"])
        .locateTimeoutMs,
      1500,
    );
  });

  test("--locate-timeout 的坏值当场报错（静默回落会让人以为已经关掉了）", () => {
    assert.match(parseArgs(["--locate-timeout"]).error ?? "", /--locate-timeout 需要/);
    // 以 - 开头按「缺参」处理（与 --concurrency 同一条口径，不吞下一个 flag）
    assert.match(
      parseArgs(["--locate-timeout", "-1"]).error ?? "",
      /--locate-timeout 需要/,
    );
    assert.match(
      parseArgs(["--locate-timeout", "两秒"]).error ?? "",
      /只收非负整数/,
    );
    assert.match(
      parseArgs(["--locate-timeout", "1.5"]).error ?? "",
      /只收非负整数/,
    );
    // 不再自带一遍「参数错误：」——main 会套 err.param，自带就成了「参数错误：参数错误：」
    assert.match(
      parseArgs(["--locate-timeout", "1.5"]).error ?? "",
      /^--locate-timeout/,
    );
  });
});

describe("sessions 子命令的参数解析", () => {
  test("不带选项时给出默认行为（自动打开浏览器）", () => {
    const args = parseArgs(["sessions"]);
    assert.equal(args.error, undefined);
    assert.equal(args.sessions?.noOpen, false);
    assert.equal(args.sessions?.port, undefined);
    assert.equal(args.sessions?.dir, undefined);
    // 不能被当成「跑一条叫 sessions 的用例」。
    assert.equal(args.input, undefined);
  });

  test("--port / --dir / --no-open 都能解析", () => {
    const args = parseArgs(["sessions", "--port", "8080", "--dir", "./x", "--no-open"]);
    assert.equal(args.error, undefined);
    assert.equal(args.sessions.port, 8080);
    assert.equal(args.sessions.dir, "./x");
    assert.equal(args.sessions.noOpen, true);
  });

  test("端口坏值当场报错（静默回落会让人以为设置在生效）", () => {
    assert.match(parseArgs(["sessions", "--port"]).error ?? "", /--port 需要/);
    assert.match(parseArgs(["sessions", "--port", "-1"]).error ?? "", /--port 需要/);
    assert.match(parseArgs(["sessions", "--port", "0"]).error ?? "", /1-65535/);
    assert.match(parseArgs(["sessions", "--port", "70000"]).error ?? "", /1-65535/);
    assert.match(parseArgs(["sessions", "--port", "abc"]).error ?? "", /1-65535/);
  });

  test("--dir 缺参、未知选项、多余位置参数都报错", () => {
    assert.match(parseArgs(["sessions", "--dir"]).error ?? "", /--dir 需要/);
    assert.match(parseArgs(["sessions", "--nope"]).error ?? "", /未知选项/);
    assert.match(parseArgs(["sessions", "extra"]).error ?? "", /多余的位置参数/);
  });

  test("run 之后的名字不会被误判成子命令", () => {
    const args = parseArgs(["run", "sessions.md"]);
    assert.equal(args.error, undefined);
    assert.equal(args.sessions, undefined);
    assert.equal(args.input, "sessions.md");
  });
});

describe("update 子命令参数解析", () => {
  test("默认、--check、--json 与 locale", () => {
    assert.equal(parseArgs(["update"]).error, undefined);
    assert.deepEqual(parseArgs(["update"]).update, {
      check: false,
      json: false,
      help: false,
    });
    assert.equal(parseArgs(["update", "--check"]).update?.check, true);
    const json = parseArgs(["update", "--json"]);
    assert.equal(json.update?.json, true);
    assert.equal(json.update?.check, true, "JSON 只检查，不安装");
    assert.equal(parseArgs(["update", "--locale", "en"]).locale, "en");
  });

  test("位置参数与未知选项都报错", () => {
    assert.match(
      parseArgs(["update", "extra"]).error ?? "",
      /不接受位置参数|positional arguments/,
    );
    assert.match(
      parseArgs(["update", "--nope"]).error ?? "",
      /未知选项|unknown option/i,
    );
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
