import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  inspectRefTarget,
  inspectRegion,
  parseSnapshotRefs,
  snapshotNodeLabels,
} from "../dist/locator.js";

// 纯单元测试：只依赖 dist/locator.js，不需要 bsk / LLM。
//
// 这里守的是一条曾经真实造成「菜单点错」的规则：`@eN` 只对产生它的那次快照成立，
// 页面一变（展开侧边栏、悬停展开菜单、切换路由）编号就整体位移，而 bsk 拿旧编号
// 只会照着新编号点下去——不报错、也不说点到了谁。工具层因此必须在动作前判定。

const SNAPSHOT = [
  "L1 page",
  '  RootWebArea "物流自动化系统"',
  '    navigation "侧边栏"',
  '      @e1 link "供应商管理"',
  '      @e2 link "供应商对接设置"',
  '      @e3 link "发货渠道管理"',
  '      @e4 link "渠道发货地址配置"',
  '    main "供应商管理"',
  '      @e5 button "新建"',
  '      @e6 textbox "供应商"',
  '      @e7 button',
].join("\n");

const refs = parseSnapshotRefs(SNAPSHOT);

describe("定位符所在区域是否还在（inspectRegion）", () => {
  // 这一组守的是真实事故（2026-09-28 钉钉日志用例）：回放刚 navigate 完就去点筛选表单里的
  // 「创建时间」，而 SPA 在 load 之后还要 1~2 秒才渲染出那个表单。判定「它在不在」是
  // 「该等一等」与「该报元素变了」的分岔口，判错就会把页面没就绪报成菜单点错。
  const TITLE = 'RootWebArea "经路云-LTC管理平台 - 钉钉日志"';
  const FORM =
    'form "创建时间 - 发送渠道 请选择发送渠道 消息类型 请选择消息类型 接收人 用户编号 发送状态 请选择发送状态 发送时间 -"';
  /** 只有外壳时（navigate 刚返回、实测 5 行的形态）。 */
  const SHELL = ["L1 page", `  ${TITLE}`].join("\n");
  const READY = [`  ${TITLE}`, `  ${FORM}`, '    @e29 combobox "创建时间 [has-submenu]"'].join(
    "\n",
  );

  const locator = (path) => ({
    role: "combobox",
    name: "创建时间 [has-submenu]",
    nth: 0,
    target: "@e29",
    path,
  });

  test("表单已渲染 → present（页面结构没问题，缺的是元素本身）", () => {
    assert.deepEqual(inspectRegion(locator([TITLE, FORM]), READY), {
      kind: "present",
      label: FORM,
    });
  });

  test("只有外壳 → missing-structure（页面还没就绪，值得等）", () => {
    assert.deepEqual(inspectRegion(locator([TITLE, FORM]), SHELL), {
      kind: "missing-structure",
      label: FORM,
    });
  });

  test("浮层（对话框/菜单）缺失 → missing-overlay（面板没打开，等也等不来）", () => {
    const dialog = 'dialog "日 一 二 三 四 五 六 30 31 1 2 3 4 5 6 7"';
    assert.equal(
      inspectRegion(locator([TITLE, dialog]), READY).kind,
      "missing-overlay",
    );
    assert.equal(
      inspectRegion(locator([TITLE, 'menu "更多"']), READY).kind,
      "missing-overlay",
    );
  });

  test("区域名随填写内容变化（表单文本拼接）时仍算「在」：只比前 12 个字符", () => {
    const afterFill = [
      `  ${TITLE}`,
      '  form "创建时间 - 发送渠道 机器人 消息类型 Markdown 接收人 用户编号 发送状态 跳过 发送时间 -"',
    ].join("\n");
    assert.equal(inspectRegion(locator([TITLE, FORM]), afterFill).kind, "present");
  });

  test("没记祖先 / 只记到页面本身 → unknown（没有判据就不猜）", () => {
    assert.deepEqual(inspectRegion(null, READY), { kind: "unknown" });
    assert.deepEqual(inspectRegion(locator([]), READY), { kind: "unknown" });
    assert.deepEqual(inspectRegion(locator(undefined), READY), {
      kind: "unknown",
    });
    assert.deepEqual(inspectRegion(locator([TITLE]), READY), {
      kind: "unknown",
    });
  });

  test("snapshotNodeLabels 收进没有 @eN 的容器行（form / RootWebArea），跳过元信息行", () => {
    const labels = snapshotNodeLabels(READY);
    assert.ok(labels.some((l) => l.role === "form"));
    assert.ok(labels.some((l) => l.role === "RootWebArea"));
    assert.ok(
      labels.some(
        (l) => l.role === "combobox" && l.name === "创建时间 [has-submenu]",
      ),
    );
    // `L1 page` / `@vom` 这类元信息行不参与
    assert.ok(!labels.some((l) => /^L\d+$/.test(l.role)));
    assert.ok(!labels.some((l) => l.role === "vom" || l.role === "view"));
  });
});

describe("引用闸门（inspectRefTarget）", () => {
  test("CSS 选择器与快照编号无关：任何情况下都放行", () => {
    assert.deepEqual(inspectRefTarget("aside a[href$='/supplier']", false, []), {
      kind: "css",
    });
    assert.deepEqual(inspectRefTarget(".el-button--primary", true, refs), {
      kind: "css",
    });
  });

  test("页面在快照之后被改动过 → 拒绝（编号可能已指向别的元素）", () => {
    assert.deepEqual(inspectRefTarget("@e1", false, refs), { kind: "stale" });
  });

  test("编号不在最近一次快照里 → 拒绝（沿用更早快照或凭记忆写编号）", () => {
    assert.deepEqual(inspectRefTarget("@e99", true, refs), {
      kind: "unknown",
    });
  });

  test("对得上 → 放行并带回 role/name（供回显落点）", () => {
    assert.deepEqual(inspectRefTarget("@e1", true, refs), {
      kind: "ok",
      ref: "@e1",
      role: "link",
      name: "供应商管理",
    });
  });

  test("`e1` 这种省略 @ 的写法同样按引用处理", () => {
    assert.deepEqual(inspectRefTarget("e4", true, refs), {
      kind: "ok",
      ref: "@e4",
      role: "link",
      name: "渠道发货地址配置",
    });
  });

  test("引用行没有可访问名时也放行（回显为空，不编名字）", () => {
    assert.deepEqual(inspectRefTarget("@e7", true, refs), {
      kind: "ok",
      ref: "@e7",
      role: "button",
      name: "",
    });
  });
});

describe("折叠快照里的成员引用仍可寻址", () => {
  // 超预算时同名叶子会折进 host 行尾的 `[xN: @eA @eB …]`：成员不再独占一行，
  // 但编号必须仍然认得出（否则闸门会把合法的引用判成 unknown，把动作全部挡死）。
  const slim = [
    "L1 page",
    '  RootWebArea "点餐系统"',
    '    navigation "分类"',
    '      @e1 link "午餐"',
    '      @e2 link "晚餐"',
    '    main "菜单"',
    '      @e3 checkbox "Select this row" [x3: @e4 @e5]',
  ].join("\n");

  test("折进去的 @e4 / @e5 仍能通过闸门", () => {
    const folded = parseSnapshotRefs(slim);
    for (const ref of ["@e3", "@e4", "@e5"]) {
      const info = inspectRefTarget(ref, true, folded);
      assert.equal(info.kind, "ok", `${ref} 应可通过闸门`);
      assert.equal(info.role, "checkbox");
      assert.equal(info.name, "Select this row");
    }
  });
});

describe("回归：侧边栏展开导致编号整体位移（这次菜单点错的原型）", () => {
  // 展开前：子项不在树里，@e2 是「供应商对接设置」那一档的位置。
  const collapsed = parseSnapshotRefs(
    [
      "L1 page",
      '  RootWebArea "物流自动化系统"',
      '    navigation "侧边栏"',
      '      @e1 link "物流供应商管理"',
      '      @e2 link "运单管理"',
    ].join("\n"),
  );
  // 展开后：组内插入了 4 个菜单项，其后所有元素整体后移。
  const expanded = parseSnapshotRefs(
    [
      "L1 page",
      '  RootWebArea "物流自动化系统"',
      '    navigation "侧边栏"',
      '      @e1 link "物流供应商管理"',
      '      @e2 link "供应商管理"',
      '      @e3 link "供应商对接设置"',
      '      @e4 link "发货渠道管理"',
      '      @e5 link "渠道发货地址配置"',
      '      @e6 link "运单管理"',
    ].join("\n"),
  );

  test("展开后再用展开前的编号：闸门必须拒绝（否则会静默点到别的菜单项）", () => {
    // 展开前的编号属于「另一份页面状态」：把它拿到展开后的页面上用，bsk 会照新编号点下去。
    // 判定依据只有一条——快照之后页面被改过，引用就已无法确定指谁。
    assert.deepEqual(inspectRefTarget("@e1", false, expanded), {
      kind: "stale",
    });
  });

  test("编号在同一份快照里依旧自洽：只有「新鲜度」能拦，落点回显负责让模型自查", () => {
    // 这是这条规则的能力边界，写进测试免得以后误以为闸门能读懂模型意图：
    // 拿最新快照里的合法编号，工具只能放行并如实回报它落到了谁身上。
    const info = inspectRefTarget("@e5", true, expanded);
    assert.deepEqual(info, {
      kind: "ok",
      ref: "@e5",
      role: "link",
      name: "渠道发货地址配置",
    });
    // 展开前的 @e2 与展开后的 @e2 是同号不同元素 —— 正是需要闸门的原因。
    assert.equal(collapsed.find((r) => r.ref === "@e2").name, "运单管理");
    assert.equal(expanded.find((r) => r.ref === "@e2").name, "供应商管理");
  });
});
