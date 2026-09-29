import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { literalAssertion } from "../dist/bsk/tools.js";

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
