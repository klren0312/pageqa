import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLocator,
  describeLocator,
  isRef,
  locatorHint,
  parseSnapshotRefs,
  resolveLocator,
} from "../dist/locator.js";
import { Recorder } from "../dist/record.js";
import {
  buildReplayScript,
  DEFAULT_LOCATE_TIMEOUT_MS,
  executeReplaySteps,
  loadReplayScript,
  replayScenarioStatus,
  REPLAY_FORMAT,
  REPLAY_VERSION,
  scriptHash,
} from "../dist/replay.js";
import { captureRunVars, restorePlaceholders } from "../dist/vars.js";

// 纯单元测试：只依赖 dist/*，不需要 bsk / LLM。

/** 真实的 bsk 快照文本片段（example.com，含缩进与元信息行）。 */
const SNAPSHOT_1 = [
  "@vom 1",
  "@view 1406x834",
  "@layers 1 focus=L1",
  "L1 page",
  '  RootWebArea "Example Domain"',
  '    heading "Example Domain"',
  '      StaticText "Example Domain"',
  "    paragraph",
  '      @e1 link "Learn more" [→ iana.org]',
].join("\n");

describe("locator 快照解析", () => {
  test("解析出 @eN 的角色与可访问名，忽略元信息行", () => {
    const refs = parseSnapshotRefs(SNAPSHOT_1);
    assert.equal(refs.length, 1);
    assert.deepEqual(refs[0], {
      ref: "@e1",
      role: "link",
      name: "Learn more",
      // 祖先里只有有名字的节点进路径；paragraph 无名字被跳过
      path: ['RootWebArea "Example Domain"'],
    });
  });

  test("isRef 区分引用与 CSS 选择器", () => {
    assert.equal(isRef("@e1"), true);
    assert.equal(isRef("e12"), true);
    assert.equal(isRef(".el-button--primary"), false);
    assert.equal(isRef("#submit"), false);
  });
});

describe("locator 构造与重定位", () => {
  test("引用型 target 记下 role/name/同名序号", () => {
    const loc = buildLocator("@e1", SNAPSHOT_1);
    assert.equal(loc.role, "link");
    assert.equal(loc.name, "Learn more");
    assert.equal(loc.nth, 0);
    assert.deepEqual(loc.path, ['RootWebArea "Example Domain"']);
    assert.equal(
      describeLocator(loc),
      'role=link name="Learn more" 位于 RootWebArea "Example Domain" 之下',
    );
  });

  test("CSS target 不做语义解析，直接留作兜底", () => {
    const loc = buildLocator("#submit", SNAPSHOT_1);
    assert.equal(loc.role, "");
    assert.equal(loc.name, "");
    assert.equal(loc.nth, -1);
    assert.equal(loc.target, "#submit");
  });

  test("快照里查不到的引用退化为只有 target 兜底", () => {
    const loc = buildLocator("@e9", SNAPSHOT_1);
    assert.equal(loc.name, "");
    assert.equal(loc.target, "@e9");
  });

  test("回放时用新快照解析回当次的 @eN（编号已重排）", () => {
    const loc = buildLocator("@e1", SNAPSHOT_1);
    // 第二次快照里同名链接变成了 @e7
    const snapshot2 = ['  @e3 heading "Example Domain"', '  @e7 link "Learn more" [→ iana.org]'].join("\n");
    assert.equal(resolveLocator(loc, snapshot2), "@e7");
  });

  test("同名元素按录制时的序号取，避免点错行", () => {
    const snapshot = [
      '  @e1 button "操作"',
      '  @e2 button "操作"',
      '  @e3 button "操作"',
    ].join("\n");
    const third = buildLocator("@e3", snapshot);
    assert.equal(third.nth, 2);
    // 回放时行顺序不变、但引用编号整体换了一批
    // （编号与文档序一致是 bsk 的约定，parseSnapshotRefs 正是靠它归序）
    const snapshot2 = [
      '  @e7 button "操作"',
      '  @e8 button "操作"',
      '  @e9 button "操作"',
    ].join("\n");
    assert.equal(resolveLocator(third, snapshot2), "@e9");
  });

  test("文案加后缀时按包含匹配，仍能命中", () => {
    const loc = buildLocator("@e1", SNAPSHOT_1);
    const snapshot2 = ['  @e4 link "Learn more about IANA"'].join("\n");
    assert.equal(resolveLocator(loc, snapshot2), "@e4");
  });

  test("页面完全对不上时返回 null（由调用方决定兜底或报错）", () => {
    const loc = buildLocator("@e1", SNAPSHOT_1);
    assert.equal(resolveLocator(loc, '  @e1 button "登录"'), null);
  });

  test("同名元素用祖先路径消歧，而不是只看「第几个」", () => {
    const recorded = [
      '  tabpanel "结构"',
      '    @e5 button "操作"',
      '  tabpanel "使用"',
      '    @e9 button "操作"',
    ].join("\n");
    const loc = buildLocator("@e9", recorded);
    assert.deepEqual(loc.path, ['tabpanel "使用"']);
    assert.equal(loc.nth, 1); // 同名候选里排第 2

    // 回放时 DOM 顺序变了：只按 nth 会点成「结构」区那个（@e7），路径能纠正
    const replay = [
      '  tabpanel "使用"',
      '    @e2 button "操作"',
      '  tabpanel "结构"',
      '    @e7 button "操作"',
    ].join("\n");
    assert.equal(resolveLocator(loc, replay), "@e2");

    // 完全拿不到路径信息时，才退回「同名序号」
    const noPath = '  @e1 button "操作"\n  @e2 button "操作"';
    assert.equal(resolveLocator(loc, noPath), "@e2");
  });

  test("路径同分多个候选时，同名序号要按「全同名池」取", () => {
    // 录制：@e3 是「B 区第 2 个」，但它的同名序号是整页文档序里的第 3 个
    const recorded = [
      '  tabpanel "A"',
      '    @e1 button "操作"',
      '  tabpanel "B"',
      '    @e2 button "操作"',
      '    @e3 button "操作"',
    ].join("\n");
    const loc = buildLocator("@e3", recorded);
    assert.equal(loc.nth, 2);
    assert.deepEqual(loc.path, ['tabpanel "B"']);

    // 回放：页面没变、引用号换了一批；B 区两个「操作」路径同分，都算匹配
    const replay = [
      '  tabpanel "A"',
      '    @e5 button "操作"',
      '  tabpanel "B"',
      '    @e6 button "操作"',
      '    @e7 button "操作"',
    ].join("\n");
    // 把「全同名池的第 3 个」直接拿去索引「路径同分这个子集」（只有 2 个）会越界，
    // 退回子集第 1 个就静默点成 @e6 —— 两个序号空间不是一回事。
    assert.equal(resolveLocator(loc, replay), "@e7");
  });

  test("折叠标记 [xN: @eA @eB …] 里的成员照样可寻址，且不打乱同名序号", () => {
    const slimmed = [
      "  tabpanel \"A\"",
      '    @e1 button "操作" [x4: @e2 @e3 @e9]',
      "  tabpanel \"B\"",
      '    @e7 button "操作"',
    ].join("\n");
    const refs = parseSnapshotRefs(slimmed);
    // 按引用号归序 = bsk 的文档序，折叠只是把成员挪到行尾，序号空间不能跟着挪
    assert.deepEqual(refs.map((r) => r.ref), ["@e1", "@e2", "@e3", "@e7", "@e9"]);
    assert.deepEqual(
      refs.map((r) => r.name),
      ["操作", "操作", "操作", "操作", "操作"],
    );
    // 成员继承 host 行的路径（折叠的全部意义就是省掉重复的整行）
    assert.deepEqual(refs[2].path, ['tabpanel "A"']);
    assert.deepEqual(refs[3].path, ['tabpanel "B"']);
    // 元素名里恰好写着 `[x1: @e9]` 也不算折叠标记：标记只认行尾
    assert.equal(parseSnapshotRefs('  @e1 button "[x2: @e9]"').length, 1);
    for (const ref of refs) {
      assert.equal(resolveLocator(buildLocator(ref.ref, slimmed), slimmed), ref.ref);
    }
  });

  test("祖先路径做过截断与层数限制（整页文本的祖先不该进脚本）", () => {
    const longName = "整页正文 ".repeat(40);
    const snapshot = [
      `  main "${longName}"`,
      '    menu "Dropdown List"',
      '      @e1 menuitem "Action 1"',
    ].join("\n");
    const ref = parseSnapshotRefs(snapshot)[0];
    assert.equal(ref.path.length, 2);
    // main 的名字被截断到 60 字符以内（标签还含 `role "` 与外层引号，故留出余量）
    assert.ok(ref.path[0].length <= 70, `路径条目过长: ${ref.path[0].length}`);
    assert.ok(longName.length > 150);
    assert.ok(ref.path[0].endsWith('..."'));
    assert.equal(ref.path[1], 'menu "Dropdown List"');
  });

  test("定位失败时区分「菜单点错」与「弹窗没打开」", () => {
    const loc = buildLocator("@e45", '  @e45 menuitem "上传文档"');
    // 同角色元素存在、但名字都不一样 → 多半是点了另一个同名菜单
    const other = [
      '  @e1 menuitem "待办事项"',
      '  @e2 menuitem "产品管理"',
    ].join("\n");
    const roleOnly = locatorHint(loc, other);
    assert.equal(roleOnly.kind, "role-only");
    assert.equal(roleOnly.roleCount, 2);
    assert.deepEqual(roleOnly.items, [
      'menuitem "待办事项"',
      'menuitem "产品管理"',
    ]);
    // 该角色一个都没有 → 菜单/弹窗此刻确实没打开
    assert.equal(locatorHint(loc, '  @e1 button "登录"').kind, "no-role");
    // 名字相近 → 元素改名了
    const renamed = locatorHint(loc, '  @e1 menuitem "上传文档 (新)"');
    assert.equal(renamed.kind, "similar-name");
    assert.deepEqual(renamed.items, ['menuitem "上传文档 (新)"']);
  });
});

describe("Recorder 录制", () => {
  const now = new Date(2026, 8, 21, 9, 5, 30); // 2026-09-21 09:05:30 本地时间
  const vars = captureRunVars(now);

  test("记录成功操作，并把动作映射到用例步骤号", () => {
    const r = new Recorder(vars);
    r.noteText("第 1 步完成：已打开页面");
    r.noteTool({
      name: "click",
      params: { target: "@e1" },
      ok: true,
      lastSnapshot: SNAPSHOT_1,
    });
    const steps = r.recorded;
    assert.equal(steps.length, 1);
    assert.equal(steps[0].kind, "click");
    assert.equal(steps[0].step, 2); // 上一条自述是第 1 步完成 → 本次属于第 2 步
    assert.equal(steps[0].locator.role, "link");
    assert.equal(steps[0].locator.name, "Learn more");
  });

  test("失败的操作与 snapshot 不进入脚本", () => {
    const r = new Recorder(vars);
    r.noteTool({
      name: "click",
      params: { target: "@e1" },
      ok: false,
      lastSnapshot: SNAPSHOT_1,
    });
    r.noteTool({ name: "snapshot", params: {}, ok: true, lastSnapshot: "" });
    assert.equal(r.recorded.length, 0);
  });

  test("运行变量被还原成占位符，并保留录制当次的具体值", () => {
    const r = new Recorder(vars);
    r.noteTool({
      name: "fill",
      params: { target: "#name", value: "自动化测试产品202609210905" },
      ok: true,
      lastSnapshot: "",
    });
    r.noteTool({
      name: "assert_text",
      params: { expectation: "自动化测试产品202609210905" },
      ok: true,
      lastSnapshot: "",
    });
    const [fill, assertion] = r.recorded;
    assert.equal(fill.value, "自动化测试产品${timestamp}");
    assert.equal(fill.recordedValue, "自动化测试产品202609210905");
    assert.equal(assertion.expectation, "自动化测试产品${timestamp}");
  });

  test("restorePlaceholders 不碰过短取值（避免误伤无关数字）", () => {
    // ${time} = 090530，6 位纯数字太容易撞上页面里的编号，故意不还原
    assert.equal(restorePlaceholders("编号 090530", vars), "编号 090530");
  });

  test("定位符里的动态名称也还原成占位符（否则回放必然定位不到）", () => {
    const r = new Recorder(vars);
    const snapshot = ['  @e14 link "自动化测试产品202609210905"'].join("\n");
    r.noteTool({
      name: "click",
      params: { target: "@e14" },
      ok: true,
      lastSnapshot: snapshot,
    });
    const loc = r.recorded[0].locator;
    assert.equal(loc.role, "link");
    assert.equal(loc.name, "自动化测试产品${timestamp}");
  });

  test("识别多种步骤自述写法（第 k 步完成 / 步骤 k 完成 / 已完成）", () => {
    const cases = [
      ["第 2 步完成：已提交表单", 3],
      ["第2步已完成：已提交表单", 3],
      ["步骤 4 完成：已提交表单", 5],
      ["步骤5已完成：已提交表单", 6],
    ];
    for (const [text, expected] of cases) {
      const r = new Recorder(vars);
      r.noteText(text);
      r.noteTool({ name: "wait", params: { ms: 10 }, ok: true, lastSnapshot: "" });
      assert.equal(r.recorded[0].step, expected, text);
    }
  });

  test("自述被流式输出切开在「完/成」之间也能识别", () => {
    const r = new Recorder(vars);
    r.noteText("第 12 步完");
    r.noteText("成：已提交表单");
    r.noteTool({ name: "wait", params: { ms: 10 }, ok: true, lastSnapshot: "" });
    assert.equal(r.recorded[0].step, 13);
  });

  test("整场没有步骤自述时步骤号留空，而不是全指向第 1 步", () => {
    const r = new Recorder(vars);
    for (const target of ["@e1", "@e2"]) {
      r.noteTool({
        name: "click",
        params: { target },
        ok: true,
        lastSnapshot: "",
      });
    }
    assert.deepEqual(
      r.recorded.map((s) => s.step),
      [null, null],
    );
  });

  test("wait_for 录的是条件本身，而不是这次等到的时长", () => {
    const r = new Recorder(vars);
    r.noteText("第 1 步完成：已点击导出");
    r.noteTool({
      name: "wait_for",
      params: { text: "导出成功", timeoutMs: 5000 },
      ok: true,
      lastSnapshot: "",
    });
    r.noteText("第 2 步完成：已等到导出成功");
    r.noteTool({ name: "wait_for", params: { gone: ".el-loading-mask" }, ok: true, lastSnapshot: "" });
    const [byText, byGone] = r.recorded;
    assert.deepEqual(byText, { kind: "wait_for", step: 2, text: "导出成功", timeoutMs: 5000 });
    // 没给上限就不写进脚本（与 download 同一条规则：写死默认值会让将来改默认值失效）
    assert.deepEqual(byGone, { kind: "wait_for", step: 3, gone: ".el-loading-mask" });
  });

  test("wait_for 的条件文本里的动态取值也还原成占位符", () => {
    const r = new Recorder(vars);
    r.noteTool({
      name: "wait_for",
      params: { text: "自动化测试产品202609210905 已创建" },
      ok: true,
      lastSnapshot: "",
    });
    assert.equal(r.recorded[0].text, "自动化测试产品${timestamp} 已创建");
  });

  test("wait_for 没有条件（不该发生）不进脚本", () => {
    const r = new Recorder(vars);
    r.noteTool({ name: "wait_for", params: {}, ok: true, lastSnapshot: "" });
    assert.equal(r.recorded.length, 0);
  });

  test("靠 Jev 语义复核才成立的断言带 semantic 标记", () => {
    const r = new Recorder(vars);
    r.noteTool({
      name: "assert_text",
      params: { expectation: "标题包含 Example" },
      ok: true,
      lastSnapshot: "",
      semantic: true,
    });
    assert.equal(r.recorded[0].semantic, true);
  });

  test("字面匹配命中的断言不带 semantic 标记（回放同样能通过）", () => {
    const r = new Recorder(vars);
    r.noteTool({
      name: "assert_text",
      params: { expectation: "Example Domain" },
      ok: true,
      lastSnapshot: "",
      semantic: false,
    });
    assert.equal(r.recorded[0].semantic, undefined);
  });
});

describe("回放失败语义（executeReplaySteps）", () => {
  /** 构造一个假的操作层：记录调用、可注入失败，避免测试依赖真实浏览器。 */
  function makeOps(handlers = {}) {
    const calls = [];
    let assertOutcome = null;
    const ops = {
      calls,
      session: "fake",
      lastSnapshot: () => "",
      snapshot: () => {
        calls.push(["snapshot"]);
        return handlers.snapshot ?? "";
      },
      navigate: (url) => {
        calls.push(["navigate", url]);
        if (handlers.navigate) return handlers.navigate(url);
        return "已导航";
      },
      click: (target) => {
        calls.push(["click", target]);
        if (handlers.click) return handlers.click(target);
        return "已点击";
      },
      fill: (target, value) => {
        calls.push(["fill", target, value]);
        return "已填入";
      },
      upload: (target, file) => {
        calls.push(["upload", target, file]);
        return "已上传";
      },
      hover: (target) => {
        calls.push(["hover", target]);
        return "已悬停";
      },
      scroll: (target) => {
        calls.push(["scroll", target]);
        return "已滚动";
      },
      wait: (ms) => {
        calls.push(["wait", ms]);
        return `已等待 ${ms}ms`;
      },
      settle: (maxMs) => {
        calls.push(["settle", maxMs ?? 0]);
        return "页面已稳定";
      },
      waitFor: (cond, timeoutMs) => {
        calls.push(["wait_for", cond, timeoutMs]);
        return "等待：已达成";
      },
      assertText: async (expectation) => {
        calls.push(["assert_text", expectation]);
        assertOutcome = {
          expectation,
          pass: true,
          evidence: `页面中包含「${expectation}」`,
        };
        return `断言「${expectation}」：成立。页面中包含「${expectation}」`;
      },
      lastAssert: () => assertOutcome,
      lastAssertSemantic: () => false,
    };
    return ops;
  }

  const run = (ops, steps, options = {}) =>
    executeReplaySteps(
      ops,
      { name: "S", caseSteps: ["用例第一步"], steps },
      { expand: (t) => t, jevActive: false, ...options },
    );

  const missClick = {
    kind: "click",
    step: 1,
    target: "@e6",
    locator: { role: "button", name: "取 消", nth: 0, target: "@e6" },
  };
  const nav = { kind: "navigate", step: 1, url: "http://localhost/" };
  const assertOk = { kind: "assert_text", step: 1, expectation: "OK" };

  test("元素未找到记为跳过并继续执行剩余步骤，不算失败", async () => {
    const ops = makeOps({ snapshot: '  @e1 button "确 定"' });
    const out = await run(ops, [nav, missClick, assertOk]);
    assert.equal(out.skipped.length, 1);
    assert.match(out.skipped[0], /回放第 2 步（click）/);
    assert.match(out.skipped[0], /对应用例第 1 步/);
    assert.equal(out.failed, 0);
    assert.equal(out.aborted, null);
    assert.equal(out.executed, 3); // 跳过后仍然跑到第 3 步
    assert.equal(ops.calls.filter((c) => c[0] === "click").length, 0);
    assert.equal(ops.calls.filter((c) => c[0] === "assert_text").length, 1);
    // 3 次尝试之间是「等页面稳定」，不再是固定 500ms 盲等：
    // 元素真的不存在时，盲等那 1 秒换不来任何东西。
    assert.equal(ops.calls.filter((c) => c[0] === "settle").length, 2);
    assert.equal(ops.calls.filter((c) => c[0] === "wait").length, 0);
  });

  test("元素找到了但操作失败 → 记为失败并继续", async () => {
    const ops = makeOps();
    ops.click = () => {
      throw new Error("target element has no visible geometry");
    };
    const out = await run(ops, [nav, { ...missClick, target: ".btn" }, assertOk]);
    assert.equal(out.failed, 1);
    assert.equal(out.skipped.length, 0);
    assert.equal(out.aborted, null);
    // 第 2 步的失败断言 + 第 3 步照常执行产生的通过断言
    assert.equal(out.assertions.length, 2);
    assert.equal(out.assertions[0].verdict, "fail");
    assert.match(out.assertions[0].evidence, /已跳过该步并继续执行剩余步骤/);
    assert.equal(out.assertions[1].verdict, "pass");
    assert.equal(out.executed, 3);
  });

  test("navigate 失败直接中止（后续步骤没有意义）", async () => {
    const ops = makeOps({
      navigate: () => {
        throw new Error("net::ERR_CONNECTION_REFUSED");
      },
    });
    const out = await run(ops, [nav, assertOk]);
    assert.equal(out.aborted, "#1 navigate");
    assert.equal(out.failed, 1);
    assert.match(out.assertions[0].evidence, /回放在此停止/);
    assert.equal(ops.calls.filter((c) => c[0] === "assert_text").length, 0);
  });

  test("--fail-fast 下元素未找到也中止，且算失败", async () => {
    const ops = makeOps({ snapshot: "" });
    const out = await run(ops, [nav, missClick, assertOk], { failFast: true });
    assert.equal(out.skipped.length, 0);
    assert.equal(out.failed, 1);
    assert.equal(out.aborted, "#2 click");
    assert.equal(ops.calls.filter((c) => c[0] === "assert_text").length, 0);
  });

  test("结论判定：断言不成立必须 FAIL（不得假通过）", () => {
    const ok = { failed: 0, aborted: null, assertions: [] };
    assert.equal(replayScenarioStatus(ok), "pass");
    assert.equal(
      replayScenarioStatus({
        ...ok,
        assertions: [{ expectation: "x", verdict: "fail" }],
      }),
      "fail",
    );
    assert.equal(replayScenarioStatus({ ...ok, failed: 1 }), "fail");
    assert.equal(replayScenarioStatus({ ...ok, aborted: "#1 navigate" }), "fail");
    // 只有跳过、没有失败 → 仍然 PASS
    assert.equal(
      replayScenarioStatus({
        failed: 0,
        aborted: null,
        assertions: [{ expectation: "x", verdict: "pass" }],
      }),
      "pass",
    );
  });

  test("前两次失败、第三次成功时不记失败（重试有效）", async () => {    const ops = makeOps();
    let attempts = 0;
    ops.click = () => {
      attempts += 1;
      if (attempts < 3) throw new Error("the upload trigger did not activate");
      return "已点击";
    };
    const out = await run(ops, [{ ...missClick, target: ".btn" }]);
    assert.equal(out.failed, 0);
    assert.equal(out.executed, 1);
    assert.equal(out.trace.filter((t) => t.startsWith("[replay-retry]")).length, 2);
    // 时序抖动型失败的重试靠「重试本身」修好，不靠等：两次重试之间各等一次稳定。
    assert.equal(ops.calls.filter((c) => c[0] === "settle").length, 2);
  });

  test("wait 步骤默认等满记下的毫秒数（不擅自改语义）", async () => {
    const ops = makeOps();
    const waitStep = { kind: "wait", step: 1, ms: 2_000 };
    const out = await run(ops, [waitStep]);
    assert.deepEqual(ops.calls, [["wait", 2_000]]);
    assert.equal(out.timing.summary(1_000).commands.byName[0].name, "wait");
  });

  test("--settle-waits：wait 步骤按「等页面稳定、上限为记下的毫秒数」执行", async () => {
    const ops = makeOps();
    const waitStep = { kind: "wait", step: 1, ms: 2_000 };
    await run(ops, [waitStep], { settleWaits: true });
    // 上限就是脚本记下的那 2000ms：页面 120ms 就稳定时它才真的省下时间。
    assert.deepEqual(ops.calls, [["settle", 2_000]]);
    assert.equal(ops.calls.filter((c) => c[0] === "wait").length, 0);
  });

  test("wait_for 步骤：等的是条件本身（不是秒数），上限透传", async () => {
    const ops = makeOps();
    const step = { kind: "wait_for", step: 1, text: "导出成功", timeoutMs: 5_000 };
    await run(ops, [step]);
    assert.deepEqual(ops.calls, [["wait_for", { text: "导出成功" }, 5_000]]);
  });

  test("wait_for 的条件文本也走占位符展开（回放时才拿到新时间戳）", async () => {
    const ops = makeOps();
    await run(
      ops,
      [{ kind: "wait_for", step: 1, text: "产品${timestamp} 已创建" }],
      { expand: (s) => s.replace("${timestamp}", "20260928") },
    );
    assert.deepEqual(ops.calls, [["wait_for", { text: "产品20260928 已创建" }, undefined]]);
  });

  test("未给上限时不传（用当前默认值，而不是把默认值写死进脚本）", async () => {
    const ops = makeOps();
    await run(ops, [{ kind: "wait_for", step: 1, selector: ".row" }]);
    assert.deepEqual(ops.calls, [["wait_for", { selector: ".row" }, undefined]]);
  });

  test("--settle-waits 只改 wait 步骤，其它步骤的执行路径不变", async () => {
    const ops = makeOps();
    await run(ops, [nav, { kind: "wait", step: 2, ms: 500 }, assertOk], {
      settleWaits: true,
    });
    assert.deepEqual(
      ops.calls.map((c) => c[0]),
      ["navigate", "settle", "assert_text"],
    );
  });
});

describe("回放：所在区域缺失时等页面就绪（--locate-timeout）", () => {
  // 这一组守的是真实事故（2026-09-28 钉钉日志用例）：回放刚 navigate 完就去点筛选表单里的
  // 「创建时间」，而 SPA 在 load 之后还要 1~2 秒才渲染出那个表单——旧逻辑 1 秒内三次尝试
  // 全部落空，把「页面还没就绪」报成了「元素未找到 / 多半是点到了另一个同名菜单」。
  const TITLE = 'RootWebArea "经路云-LTC管理平台 - 钉钉日志"';
  const FORM =
    'form "创建时间 - 发送渠道 请选择发送渠道 消息类型 请选择消息类型 接收人 用户编号 发送状态 请选择发送状态 发送时间 -"';
  /** 只有外壳（navigate 刚返回时的形态）。 */
  const SHELL = [`  ${TITLE}`, '  @e2 button "经路云-LTC管理平台"'].join("\n");
  /** 表单渲染出来了，但没有那个 combobox（元素确实变了）。 */
  const FORM_ONLY = [`  ${TITLE}`, `  ${FORM}`].join("\n");
  /** 完整页面：录制的定位符可以解析（回放时编号与录制时相同）。 */
  const READY = [
    `  ${TITLE}`,
    `  ${FORM}`,
    '    @e29 combobox "创建时间 [has-submenu]"',
  ].join("\n");

  const clickCreateTime = {
    kind: "click",
    step: 1,
    target: "@e29",
    locator: {
      role: "combobox",
      name: "创建时间 [has-submenu]",
      nth: 0,
      target: "@e29",
      path: [TITLE, FORM],
    },
  };

  /** 假操作层：snapshot 按调用顺序依次返回给定快照（用完后一直用最后一份）。 */
  function makeOps(snapshots) {
    const calls = [];
    let i = 0;
    return {
      calls,
      session: "fake",
      lastSnapshot: () => "",
      snapshot: (_signal, options) => {
        calls.push(["snapshot", options?.fresh === true]);
        return snapshots[Math.min(i++, snapshots.length - 1)];
      },
      click: (target) => {
        calls.push(["click", target]);
        return "已点击";
      },
      settle: () => {
        calls.push(["settle"]);
        return "页面已稳定";
      },
    };
  }

  const run = (ops, steps, options = {}) =>
    executeReplaySteps(
      ops,
      { name: "S", caseSteps: ["用例第一步"], steps },
      { expand: (t) => t, jevActive: false, ...options },
    );
  /** 单测不真的等：5ms 一次轮询 + 几百毫秒上限。 */
  const fast = { locatePollMs: 5 };

  test("区域缺失 → 等到页面就绪再解析，成功执行（不记跳过）", async () => {
    const ops = makeOps([SHELL, SHELL, READY]);
    const out = await run(ops, [clickCreateTime], { ...fast, locateTimeoutMs: 1000 });
    assert.equal(out.skipped.length, 0);
    assert.equal(out.failed, 0);
    assert.equal(out.executed, 1);
    assert.deepEqual(
      ops.calls.filter((c) => c[0] === "click"),
      [["click", "@e29"]],
    );
    // 轨迹里留下「等了多久、期间页面长什么样」
    assert.match(
      out.trace.join("\n"),
      /\[replay-wait\] #1 click 等页面就绪 \d+ms（\d+ 次快照，行数 2 → 2 → 3）后解析到 @e29/,
    );
    // 首次解析用普通快照（可以复用），轮询必须每次都强制取新（否则连拿同一份旧快照）
    assert.equal(ops.calls.filter((c) => c[0] === "snapshot" && c[1] === false).length, 1);
    assert.equal(ops.calls.filter((c) => c[0] === "snapshot" && c[1] === true).length, 2);
    assert.equal(ops.calls.filter((c) => c[0] === "settle").length, 0);
  });

  test("一直没就绪 → 等满上限后按「元素未找到」跳过，且不再叠加重试", async () => {
    const ops = makeOps([SHELL]);
    const out = await run(ops, [clickCreateTime], { ...fast, locateTimeoutMs: 120 });
    assert.equal(out.skipped.length, 1);
    assert.equal(out.failed, 0);
    assert.equal(ops.calls.filter((c) => c[0] === "click").length, 0);
    // 等待已经发生在定位里，不该再有「重试之间等页面稳定」那一轮
    assert.equal(ops.calls.filter((c) => c[0] === "settle").length, 0);
    // 证据要带上轮询次数、实际等待与快照行数轨迹
    assert.match(out.skipped[0], /已等页面就绪 \d+ms（\d+ 次快照，行数 2 → 2/);
    assert.match(out.skipped[0], /--locate-timeout/);
  });

  test("区域在页面上 → 不等（沿用三次尝试 + 两次等页面稳定）", async () => {
    const ops = makeOps([FORM_ONLY]);
    const out = await run(ops, [clickCreateTime], { ...fast, locateTimeoutMs: 5000 });
    assert.equal(out.skipped.length, 1);
    assert.equal(ops.calls.filter((c) => c[0] === "snapshot" && c[1] === true).length, 0);
    assert.equal(ops.calls.filter((c) => c[0] === "settle").length, 2);
    // 先说区域在不在，而不是猜「点到了另一个菜单」
    assert.match(out.skipped[0], /录制时它所在区域 form "创建时间/);
    assert.match(out.skipped[0], /在页面上存在/);
  });

  test("浮层缺失 → 不等（面板没打开，等也等不来），并如实说明", async () => {
    const dialog = 'dialog "日 一 二 三 四 五 六 30 31 1 2 3 4 5 6 7"';
    const ops = makeOps([FORM_ONLY]);
    const out = await run(
      ops,
      [
        {
          kind: "click",
          step: 1,
          target: "@e149",
          locator: {
            role: "button",
            name: "确定",
            nth: 0,
            target: "@e149",
            path: [TITLE, dialog],
          },
        },
      ],
      { ...fast, locateTimeoutMs: 5000 },
    );
    assert.equal(out.skipped.length, 1);
    assert.equal(ops.calls.filter((c) => c[0] === "snapshot" && c[1] === true).length, 0);
    assert.equal(ops.calls.filter((c) => c[0] === "settle").length, 2);
    assert.match(out.skipped[0], /位于浮层 dialog "日 一 二/);
    assert.match(out.skipped[0], /面板\/弹窗没有打开/);
  });

  test("--locate-timeout 0 = 不等，退回旧行为（立刻判定 + 三次尝试）", async () => {
    const ops = makeOps([SHELL]);
    const out = await run(ops, [clickCreateTime], { ...fast, locateTimeoutMs: 0 });
    assert.equal(out.skipped.length, 1);
    assert.equal(ops.calls.filter((c) => c[0] === "snapshot").length, 3);
    assert.equal(ops.calls.filter((c) => c[0] === "snapshot" && c[1] === true).length, 0);
    assert.equal(ops.calls.filter((c) => c[0] === "settle").length, 2);
  });

  test("默认上限是常数（CLI 帮助与这里的口径同一个数）", () => {
    assert.equal(DEFAULT_LOCATE_TIMEOUT_MS, 8000);
  });
});

describe("回放脚本文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "pageqa-replay-"));

  test("组装的文件头带格式、版本与源用例哈希", () => {
    const script = buildReplayScript(
      [{ name: "A1", caseSteps: ["打开 example.com"], steps: [] }],
      { sourcePath: "examples/smoke.md", sourceText: "## A1\n打开 example.com" },
    );
    assert.equal(script.format, REPLAY_FORMAT);
    assert.equal(script.version, REPLAY_VERSION);
    assert.equal(script.source.path, "examples/smoke.md");
    assert.equal(script.source.hash, scriptHash("## A1\n打开 example.com"));
  });

  test("非 pageqa 脚本被拒绝", () => {
    const p = join(dir, "other.json");
    writeFileSync(p, JSON.stringify({ hello: "world" }));
    assert.throws(() => loadReplayScript(p), /不是 pageqa 回放脚本/);
  });

  test("空步骤脚本被拒绝（否则回放会「0 步全通过」）", () => {
    const p = join(dir, "empty.json");
    writeFileSync(
      p,
      JSON.stringify({
        format: REPLAY_FORMAT,
        version: REPLAY_VERSION,
        scenarios: [{ name: "A1", caseSteps: [], steps: [] }],
      }),
    );
    assert.throws(() => loadReplayScript(p), /不含任何可执行步骤/);
  });

  test("版本高于当前支持时被拒绝", () => {
    const p = join(dir, "future.json");
    writeFileSync(
      p,
      JSON.stringify({
        format: REPLAY_FORMAT,
        version: REPLAY_VERSION + 1,
        scenarios: [
          { name: "A1", caseSteps: [], steps: [{ kind: "wait", ms: 1 }] },
        ],
      }),
    );
    assert.throws(() => loadReplayScript(p), /版本不支持/);
  });

  test("旧脚本里写死的动态取值在加载时被还原为占位符", () => {
    const p = join(dir, "legacy.json");
    writeFileSync(
      p,
      JSON.stringify({
        format: REPLAY_FORMAT,
        version: REPLAY_VERSION,
        scenarios: [
          {
            name: "P1",
            caseSteps: ["在产品名称输入框填写 `自动化测试产品202609211103`"],
            steps: [
              {
                kind: "fill",
                step: null,
                target: "@e1",
                value: "自动化测试产品${timestamp}",
                recordedValue: "自动化测试产品202609211103",
                locator: {
                  role: "textbox",
                  name: "* 产品库名称：",
                  nth: 0,
                  target: "@e1",
                },
              },
              {
                kind: "click",
                step: null,
                target: "@e14",
                locator: {
                  role: "link",
                  name: "自动化测试产品202609211103",
                  nth: 0,
                  target: "@e14",
                },
              },
              {
                kind: "upload",
                step: null,
                file: "D:\\Downloads\\a-202609211103.png",
                locator: null,
              },
            ],
          },
        ],
      }),
    );
    const script = loadReplayScript(p);
    const [fill, click, upload] = script.scenarios[0].steps;
    assert.equal(
      script.scenarios[0].caseSteps[0],
      "在产品名称输入框填写 `自动化测试产品${timestamp}`",
    );
    assert.equal(click.locator.name, "自动化测试产品${timestamp}");
    assert.equal(fill.value, "自动化测试产品${timestamp}");
    // 录制当次的值作为证据保留；本地文件路径属于真实存在的路径，不动
    assert.equal(fill.recordedValue, "自动化测试产品202609211103");
    assert.equal(upload.file, "D:\\Downloads\\a-202609211103.png");
  });

  test("含不认识步骤类型的脚本被拒绝（加载时崩，而不是回放中途静默落空）", () => {
    const p = join(dir, "badkind.json");
    writeFileSync(
      p,
      JSON.stringify({
        format: REPLAY_FORMAT,
        version: REPLAY_VERSION,
        scenarios: [
          { name: "A1", caseSteps: [], steps: [{ kind: "teleport", step: null }] },
        ],
      }),
    );
    assert.throws(() => loadReplayScript(p), /不支持的步骤类型/);
  });

  test("wait_for 步骤缺条件或条件多于一个都当场拒绝", () => {
    const base = {
      format: REPLAY_FORMAT,
      version: REPLAY_VERSION,
      scenarios: [{ name: "A1", caseSteps: [], steps: [] }],
    };
    const cases = [
      { kind: "wait_for", step: null },
      { kind: "wait_for", step: null, text: "x", selector: ".y" },
      { kind: "wait_for", step: null, text: "", selector: ".y", gone: ".z" },
    ];
    for (const [i, step] of cases.entries()) {
      const p = join(dir, `bad-waitfor-${i}.json`);
      writeFileSync(p, JSON.stringify({ ...base, scenarios: [{ name: "A1", caseSteps: [], steps: [step] }] }));
      assert.throws(() => loadReplayScript(p), /必须\*\*恰好\*\*带一个条件/);
    }
    // 恰好一个条件则正常加载（并且不会因为新增类型而需要升版本号）
    const ok = join(dir, "ok-waitfor.json");
    writeFileSync(
      ok,
      JSON.stringify({
        ...base,
        scenarios: [
          {
            name: "A1",
            caseSteps: [],
            steps: [{ kind: "wait_for", step: 1, gone: ".el-loading-mask", timeoutMs: 5000 }],
          },
        ],
      }),
    );
    const loaded = loadReplayScript(ok);
    assert.equal(loaded.scenarios[0].steps[0].gone, ".el-loading-mask");
    assert.equal(loaded.scenarios[0].steps[0].timeoutMs, 5000);
  });

  test("一处写法里的多个占位符取值都能还原（不止第一个）", () => {
    const p = join(dir, "multi-placeholder.json");
    writeFileSync(
      p,
      JSON.stringify({
        format: REPLAY_FORMAT,
        version: REPLAY_VERSION,
        scenarios: [
          {
            name: "M1",
            caseSteps: ["创建 `产品20260921-110300`"],
            steps: [
              {
                kind: "fill",
                step: null,
                target: "@e1",
                value: "产品${date}-${time}",
                recordedValue: "产品20260921-110300",
                locator: null,
              },
              {
                kind: "click",
                step: null,
                target: "@e9",
                locator: {
                  role: "link",
                  name: "产品20260921-110300",
                  nth: 0,
                  target: "@e9",
                },
              },
            ],
          },
        ],
      }),
    );
    const script = loadReplayScript(p);
    const [fill, click] = script.scenarios[0].steps;
    assert.equal(fill.value, "产品${date}-${time}");
    assert.equal(click.locator.name, "产品${date}-${time}");
    assert.equal(
      script.scenarios[0].caseSteps[0],
      "创建 `产品${date}-${time}`",
    );
  });

  test("正常脚本可加载", () => {
    const p = join(dir, "ok.json");
    writeFileSync(
      p,
      JSON.stringify({
        format: REPLAY_FORMAT,
        version: REPLAY_VERSION,
        scenarios: [
          { name: "A1", caseSteps: [], steps: [{ kind: "wait", ms: 1 }] },
        ],
      }),
    );
    assert.equal(loadReplayScript(p).scenarios.length, 1);
  });

  /**
   * 全部步骤类型都要能被加载。
   *
   * `REPLAY_STEP_KINDS` 是个手写的 Set：加新类型时很容易忘了往里补一笔，
   * 而漏掉的后果是「录得出来、回放直接拒绝」——那正是这个测试要拦住的东西。
   */
  test("所有步骤类型都在加载白名单里（含选择类控件的新类型）", () => {
    const kinds = [
      "navigate",
      "click",
      "fill",
      "select_option",
      "pick_date",
      "upload",
      "download",
      "hover",
      "scroll",
      "wait",
      "wait_for",
      "assert_text",
    ];
    const steps = kinds.map((kind) => {
      switch (kind) {
        case "navigate":
          return { kind, step: null, url: "https://example.com" };
        case "click":
        case "hover":
        case "scroll":
          return { kind, step: null, target: "@e1", locator: null };
        case "fill":
          return { kind, step: null, target: "@e1", locator: null, value: "x" };
        case "select_option":
          return { kind, step: null, target: "@e1", locator: null, option: "已完成" };
        case "pick_date":
          return { kind, step: null, target: "@e2", locator: null, date: "+3" };
        case "upload":
          return { kind, step: null, file: "a.txt", locator: null };
        case "download":
          return { kind, step: null, target: "@e1", locator: null };
        case "wait":
          return { kind, step: null, ms: 10 };
        case "wait_for":
          return { kind, step: null, text: "完成" };
        default:
          return { kind, step: null, expectation: "标题" };
      }
    });
    const p = join(dir, "all-kinds.json");
    writeFileSync(
      p,
      JSON.stringify({
        format: REPLAY_FORMAT,
        version: REPLAY_VERSION,
        scenarios: [{ name: "A1", caseSteps: [], steps }],
      }),
    );
    const loaded = loadReplayScript(p);
    assert.deepEqual(
      loaded.scenarios[0].steps.map((s) => s.kind),
      kinds,
    );
    // 新类型仍按占位符写法保存（回放时重新展开），不需要升脚本版本号。
    assert.equal(loaded.version, REPLAY_VERSION);
  });
});
