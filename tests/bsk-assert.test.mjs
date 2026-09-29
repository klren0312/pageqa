import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isBrowserInternalUrl,
  isConsoleOffender,
  literalAssertion,
  parseStatusSpec,
  statusMatches,
} from "../dist/bsk/tools.js";

// 断言判定的字面部分是纯函数，这里直接钉住三条用真实事故换来的规则。
// 背景（examples/smoke.md 的 A3）：用例写的是「断言页面**不包含** X」，
// 但字符串包含匹配只能表达「页面有这段文字」，于是 X 被当正向期望传进来，
// 一条本该通过的断言必然返回「不成立」；Jev 复核又给出一个 3% 的匹配度，
// 把「页面上没有这段文字」判成了 FAIL。
const PAGE = [
  'RootWebArea "Example Domain"',
  '  StaticText "This domain is for use in documentation examples"',
  '  link "Learn more"',
].join("\n");

describe("literalAssertion：正向断言", () => {
  test("字面命中即成立，证据写清看到了什么", () => {
    const r = literalAssertion(PAGE, "Learn more");
    assert.equal(r.pass, true);
    assert.match(r.evidence, /页面中包含「Learn more」/);
  });

  test("字面未命中返回 null（这一种才值得再请 Jev 复核）", () => {
    assert.equal(literalAssertion(PAGE, "查无此文"), null);
  });
});

describe("literalAssertion：反向断言（absent）", () => {
  test("页面确实没有这段文字 → 成立", () => {
    const r = literalAssertion(PAGE, "THIS_TEXT_SHOULD_NOT_EXIST_XYZ", true);
    assert.equal(r.pass, true);
    assert.match(r.evidence, /页面中未找到「THIS_TEXT_SHOULD_NOT_EXIST_XYZ」/);
  });

  test("页面里有这段文字 → 不成立，证据点明断言要求不包含", () => {
    const r = literalAssertion(PAGE, "Learn more", true);
    assert.equal(r.pass, false);
    assert.match(r.evidence, /页面中包含「Learn more」（断言要求不包含）/);
  });

  test("反向断言不走语义复核：不返回 null", () => {
    // 「页面上有没有和 X 意思相近的文字」不是可校验的命题，交给 Jev 只会
    // 把一条本该成立的断言按匹配度判掉（A3 现场就是 3% 匹配度 → FAIL）。
    assert.notEqual(literalAssertion(PAGE, "完全不相干的措辞", true), null);
  });
});

describe("literalAssertion：页面还没打开", () => {
  // 最危险的假通过：空页面上确实「什么都不存在」，但那是「还没导航」，
  // 不是「页面确认没有这段文字」。用例写错 URL 也不能因此判成立。
  test("快照过短时，反向断言也不能算成立", () => {
    for (const snap of ["", "   ", "about:blank"]) {
      const r = literalAssertion(snap, "任何文本", true);
      assert.equal(r.pass, false, `快照 ${JSON.stringify(snap)} 不该判成立`);
      assert.match(r.evidence, /页面快照为空或过短/);
    }
  });

  test("快照过短时，正向断言同样不成立（原行为不变）", () => {
    const r = literalAssertion("", "Example");
    assert.equal(r.pass, false);
    assert.match(r.evidence, /页面快照为空或过短（0 字符）/);
  });
});

describe("assert_no_console_error：哪些条目算「报错」", () => {
  test("未捕获异常一律算，与 level 无关", () => {
    assert.equal(isConsoleOffender({ kind: "exception", level: "error" }, false), true);
    assert.equal(isConsoleOffender({ kind: "exception", level: "log" }, false), true);
  });

  test("console.error 与浏览器错误日志都算（后者 kind 是 log）", () => {
    assert.equal(isConsoleOffender({ kind: "console", level: "error" }, false), true);
    // 资源加载失败（如 404）在 bsk 里是 kind=log、level=error 的条目
    assert.equal(isConsoleOffender({ kind: "log", level: "error" }, false), true);
  });

  test("warning 默认放行，显式要求时才算", () => {
    // 第三方库的 deprecation 警告太常见，默认算失败会让这个工具在真实页面上天天假失败。
    assert.equal(isConsoleOffender({ kind: "console", level: "warning" }, false), false);
    assert.equal(isConsoleOffender({ kind: "console", level: "warning" }, true), true);
    // CDP 两处来源写法不一：Runtime 侧给 warning，部分版本给 warn，两边都要认。
    assert.equal(isConsoleOffender({ kind: "console", level: "warn" }, true), true);
  });

  test("普通 log / info / debug 任何情况下都不算错误", () => {
    for (const level of ["log", "info", "debug", "verbose"]) {
      assert.equal(isConsoleOffender({ kind: "console", level }, false), false);
      assert.equal(isConsoleOffender({ kind: "console", level }, true), false);
    }
  });

  test("level 大小写不敏感（它来自页面/CDP，写法不受我们控制）", () => {
    assert.equal(isConsoleOffender({ kind: "console", level: "ERROR" }, false), true);
  });
});

describe("过滤浏览器 / 扩展自己的条目", () => {
  // 2026-09-29 真机跑：一条 chrome-extension://invalid/ 的 ERR_FAILED 就让
  // 「断言页面没有报错」失败，而那条报错与被测页面毫无关系——不过滤的话，
  // 这个断言在任何装了扩展的机器上都会红。
  test("扩展与浏览器内部的 URL 一律滤掉", () => {
    for (const url of [
      "chrome-extension://invalid/",
      "chrome-extension://opcgpfmipidbgpenhmajoajpbobppdil/dapp-interface.js",
      "chrome://settings/",
      "chrome-untrusted://embed/",
      "devtools://devtools/bundled/inspector.js",
      "moz-extension://abc/x.js",
    ]) {
      assert.equal(isBrowserInternalUrl(url), true, url);
    }
  });

  test("页面自己的 URL 一律保留（宁可漏过，不可错杀）", () => {
    for (const url of [
      "http://localhost:18888/smoke-test-page.html",
      "https://example.com/api/user/save",
      "data:image/png;base64,AAAA",
      "blob:http://localhost:18888/abc",
      "file:///D:/page/index.html",
      "",
      undefined,
    ]) {
      assert.equal(isBrowserInternalUrl(url), false, String(url));
    }
  });

  test("大小写不敏感", () => {
    assert.equal(isBrowserInternalUrl("CHROME-EXTENSION://x/y.js"), true);
  });
});

describe("assert_network：状态码期望", () => {
  test("精确与区间两种写法", () => {
    assert.deepEqual(parseStatusSpec("200"), { exact: 200 });
    assert.deepEqual(parseStatusSpec(" 404 "), { exact: 404 });
    assert.deepEqual(parseStatusSpec("2xx"), { from: 200, to: 299 });
    assert.deepEqual(parseStatusSpec("5XX"), { from: 500, to: 599 });
  });

  test("认不出的写法返回 null（调用方据此本地报错，而不是把断言悄悄放宽）", () => {
    for (const spec of ["", "  ", "abc", "20", "600", "2x", "2xxx"]) {
      assert.equal(parseStatusSpec(spec), null, `${JSON.stringify(spec)} 不该被接受`);
    }
  });

  test("缺状态码（请求失败）一律不算命中", () => {
    assert.equal(statusMatches(200, { exact: 200 }), true);
    assert.equal(statusMatches(500, { exact: 200 }), false);
    assert.equal(statusMatches(204, { from: 200, to: 299 }), true);
    assert.equal(statusMatches(302, { from: 200, to: 299 }), false);
    for (const spec of [{ exact: 200 }, { from: 200, to: 299 }]) {
      assert.equal(statusMatches(undefined, spec), false);
    }
  });
});
