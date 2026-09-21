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
    // 回放时行顺序不变、但引用编号变了
    const snapshot2 = [
      '  @e9 button "操作"',
      '  @e8 button "操作"',
      '  @e5 button "操作"',
    ].join("\n");
    assert.equal(resolveLocator(third, snapshot2), "@e5");
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
      assertText: async (expectation) => {
        calls.push(["assert_text", expectation]);
        return `断言「${expectation}」：成立。页面中包含「${expectation}」`;
      },
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

  test("前两次失败、第三次成功时不记失败（重试有效）", async () => {
    const ops = makeOps();
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
});
