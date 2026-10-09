import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildClearMarksExpression,
  buildDateDayMarkExpression,
  buildDatePanelProbeExpression,
  buildOptionMarkExpression,
  buildOverlayProbeExpression,
  buildOwnOverlayExpression,
  monthDelta,
  navDirection,
  parseDatePanelProbe,
  parseDateSpec,
  parseDayMark,
  parseOptionMark,
  parseOverlayProbe,
  pickTableIndex,
  PICK_ATTR,
  PICK_SELECTOR,
  ROOT_ATTR,
  ROOT_SELECTOR,
  scopedToRoot,
} from "../dist/bsk/picker.js";
import { Recorder } from "../dist/agent/record.js";

// 探针表达式是**同步**的，这里用最小的 DOM 替身在进程内真的跑一遍——
// 光断言「字符串里含某个片段」证明不了「禁用项被跳过」「相邻月份不算命中」这类逻辑。

/**
 * 造一个能过可见性判断的元素。
 *
 * `sels` 声明「这个元素匹配哪些选择器」、`children` 声明子元素，两者合起来让替身能应付
 * `querySelectorAll`。多个同类控件（几个下拉、几个日期面板）的错乱恰恰发生在「查询拿到
 * 的是哪一个」上，替身必须能表达「DOM 里同时有好几个」，否则那类问题测不出来。
 */
function el({ cls = "", text = "", visible = true, attrs = {}, sels = [], children = [] } = {}) {
  return {
    className: cls,
    textContent: text,
    _attrs: { ...attrs },
    _sels: sels,
    _children: children,
    getAttribute(name) {
      return name in this._attrs ? this._attrs[name] : null;
    },
    setAttribute(name, value) {
      this._attrs[name] = String(value);
    },
    removeAttribute(name) {
      delete this._attrs[name];
    },
    scrollIntoView() {},
    getBoundingClientRect: () =>
      visible ? { width: 200, height: 30 } : { width: 0, height: 0 },
    querySelectorAll(sel) {
      return this._children.filter((c) => c._sels.includes(sel));
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] ?? null;
    },
  };
}

/** 在替身 document 上求值。 */
function run(expr, { all = () => [], one = () => null, style = {}, dom } = {}) {
  const doc = dom ?? { querySelector: one, querySelectorAll: all };
  const win = {
    getComputedStyle: () => ({ visibility: "visible", display: "block", ...style }),
  };
  return new Function("document", "window", `return ${expr};`)(doc, win);
}

/**
 * 一个「会随属性标记动态变化」的 document 替身。
 *
 * 动态是关键：表达式靠**打属性**来传递「是哪一个」，静态返回固定列表就验证不了
 * 「标记前 / 标记后查询结果不同」这件事。
 */
function domOf(nodes) {
  const match = (sel) => {
    // 属性选择器（含逗号分隔的多个）：按属性是否存在过滤
    if (sel.trimStart().startsWith("[")) {
      const attrs = [...sel.matchAll(/\[([\w-]+)/g)].map((m) => m[1]);
      return nodes.filter((n) => attrs.some((a) => n.getAttribute(a) !== null));
    }
    return nodes.filter((n) => n._sels.includes(sel));
  };
  return {
    querySelectorAll: match,
    querySelector: (sel) => match(sel)[0] ?? null,
  };
}

describe("浮层探针：只认「可见」的那一个", () => {
  test("命中第一个可见的候选容器，并回报是哪个选择器命中的", () => {
    const box = el({ cls: "el-select-dropdown" });
    const out = run(buildOverlayProbeExpression(), {
      all: (sel) => (sel === ".el-select-dropdown" ? [box] : []),
    });
    assert.equal(out.hit, true);
    assert.equal(out.selector, ".el-select-dropdown");
  });

  test("尺寸为 0（display:none 的残留浮层）不算命中，继续找下一个候选", () => {
    const hidden = el({ cls: "el-select-dropdown", visible: false });
    const aria = el({ cls: "" });
    const out = run(buildOverlayProbeExpression(), {
      all: (sel) => {
        if (sel === ".el-select-dropdown") return [hidden];
        if (sel === "[role=listbox]") return [aria];
        return [];
      },
    });
    assert.equal(out.hit, true);
    assert.equal(out.selector, "[role=listbox]");
  });

  test("一个都没有时如实返回未命中", () => {
    const out = run(buildOverlayProbeExpression(), { all: () => [] });
    assert.deepEqual(out, { hit: false, selector: null, count: 0 });
  });

  test("选择器非法（组件库版本差异导致类名写坏）不抛出，只跳过该候选", () => {
    const out = run(buildOverlayProbeExpression(["!!!bad", ".ok"]), {
      all: (sel) => {
        if (sel === "!!!bad") throw new Error("bad selector");
        return [el()];
      },
    });
    assert.equal(out.hit, true);
    assert.equal(out.selector, ".ok");
  });

  test("parseOverlayProbe：认不出的输出返回 null", () => {
    assert.deepEqual(parseOverlayProbe('{"hit":true,"selector":".x","count":2}'), {
      hit: true,
      selector: ".x",
      count: 2,
    });
    assert.equal(parseOverlayProbe("boom"), null);
    assert.equal(parseOverlayProbe("[]"), null);
  });
});

describe("选项标记：全等优先、跳过禁用、找不到就如实列候选", () => {
  const items = (...list) => (sel) =>
    sel.includes("el-select-dropdown__item") ? list : [];

  test("全等的选项优先于包含匹配到的", () => {
    const partial = el({ text: "北京市" });
    const exact = el({ text: "北京" });
    const out = run(buildOptionMarkExpression(".dd", "北京"), {
      one: () => ({ querySelectorAll: items(partial, exact) }),
    });
    assert.equal(out.found, true);
    assert.equal(out.text, "北京");
    assert.equal(exact._attrs[PICK_ATTR], "1");
    assert.equal(partial._attrs[PICK_ATTR], undefined);
  });

  test("没有全等时退回包含匹配", () => {
    const out = run(buildOptionMarkExpression(".dd", "北京"), {
      one: () => ({ querySelectorAll: items(el({ text: "北京市朝阳区" })) }),
    });
    assert.equal(out.found, true);
    assert.equal(out.text, "北京市朝阳区");
  });

  test("禁用项不会被选中（点了也不会有任何变化）", () => {
    const out = run(buildOptionMarkExpression(".dd", "已完成"), {
      one: () => ({
        querySelectorAll: items(
          el({ cls: "el-select-dropdown__item is-disabled", text: "已完成" }),
        ),
      }),
    });
    assert.equal(out.found, false);
  });

  test("找不到时返回候选清单，让上层如实回报「现在能选什么」", () => {
    const out = run(buildOptionMarkExpression(".dd", "不存在"), {
      one: () => ({
        querySelectorAll: items(el({ text: "待处理" }), el({ text: "已完成" })),
      }),
    });
    assert.equal(out.found, false);
    assert.deepEqual(out.candidates, ["待处理", "已完成"]);
  });

  test("浮层不见了（面板已被关掉）时不抛错", () => {
    const out = run(buildOptionMarkExpression(".dd", "x"), { one: () => null });
    assert.deepEqual(out, { found: false, text: "", candidates: [] });
  });

  test("parseOptionMark：候选缺失时给空数组而不是 undefined", () => {
    assert.deepEqual(parseOptionMark('{"found":false,"candidates":["a"]}'), {
      found: false,
      text: "",
      candidates: ["a"],
    });
    assert.equal(parseOptionMark("nope"), null);
  });
});

describe("日期面板探针：年月从头部文本里抽，范围面板逐表读", () => {
  const panel = (labels) =>
    ({
      querySelectorAll: (sel) =>
        sel.includes("header-label") ? labels.map((t) => el({ text: t })) : [],
      querySelector: () => null,
      textContent: labels.map((l) => l.textContent).join(" "),
      getBoundingClientRect: () => ({ width: 300, height: 300 }),
      className: "el-picker-panel",
    });

  /** 造一个范围面板：左右各一个 `.el-date-range-picker__content` + 一张表。 */
  function rangePanel(leftLabels, rightLabels) {
    const side = (cls, labels) => {
      const box = el({ cls });
      box.querySelectorAll = (sel) =>
        sel.includes("header-label") ? labels.map((t) => el({ text: t })) : [];
      box.querySelector = () => null;
      box.textContent = labels.join(" ");
      return box;
    };
    const left = side("el-date-range-picker__content is-left", leftLabels);
    const right = side("el-date-range-picker__content is-right", rightLabels);
    const table = (owner) => {
      const t = el({ cls: "el-date-table" });
      t.closest = (sel) =>
        sel.includes("range-picker__content") ? owner : null;
      return t;
    };
    return {
      className: "el-picker-panel el-date-range-picker",
      querySelectorAll: (sel) =>
        sel === ".el-date-table" ? [table(left), table(right)] : [],
      querySelector: () => null,
      getBoundingClientRect: () => ({ width: 600, height: 300 }),
    };
  }

  test("两个标签（年、月）分别抽取", () => {
    const out = run(buildDatePanelProbeExpression(), {
      all: (sel) =>
        sel === ".el-picker-panel" ? [panel(["2026 年", "9 月"])] : [],
    });
    assert.equal(out.hit, true);
    assert.equal(out.year, 2026);
    assert.equal(out.month, 9);
    assert.equal(out.isRange, false);
    assert.equal(out.tables.length, 1);
  });

  test("范围面板：两张表各自读出年月，并标出 isRange", () => {
    const out = run(buildDatePanelProbeExpression(), {
      all: (sel) =>
        sel === ".el-picker-panel"
          ? [rangePanel(["2026 年", "9 月"], ["2026 年", "10 月"])]
          : [],
    });
    assert.equal(out.hit, true);
    assert.equal(out.isRange, true);
    assert.deepEqual(out.tables, [
      { year: 2026, month: 9 },
      { year: 2026, month: 10 },
    ]);
    // 旧字段仍取第一张表，方便单日期分支复用同一份探针
    assert.equal(out.year, 2026);
    assert.equal(out.month, 9);
  });

  test("抽不到年月时给 null（上层据此放弃「翻月份」，而不是瞎点箭头）", () => {
    const bare = {
      querySelectorAll: () => [],
      querySelector: () => null,
      textContent: "无关文本",
      getBoundingClientRect: () => ({ width: 300, height: 300 }),
    };
    const out = run(buildDatePanelProbeExpression(), {
      all: (sel) => (sel === ".el-picker-panel" ? [bare] : []),
    });
    assert.equal(out.hit, true);
    assert.equal(out.year, null);
    assert.equal(out.month, null);
  });

  test("没有面板时如实返回未命中", () => {
    const out = run(buildDatePanelProbeExpression(), { all: () => [] });
    assert.equal(out.hit, false);
    assert.equal(out.selector, null);
    assert.equal(out.isRange, false);
    assert.deepEqual(out.tables, []);
  });

  test("parseDatePanelProbe：非数字的 year 不当成 0，缺 tables 时给空数组", () => {
    const parsed = parseDatePanelProbe('{"hit":true,"selector":".x","year":"2026","month":9,"hasFooter":true}');
    assert.equal(parsed.year, null);
    assert.equal(parsed.month, 9);
    assert.equal(parsed.hasFooter, true);
    assert.deepEqual(parsed.tables, []);
    assert.equal(parsed.isRange, false);
  });

  test("parseDatePanelProbe：tables 里读不出的年份给 null，不整条丢掉", () => {
    const parsed = parseDatePanelProbe(
      '{"hit":true,"isRange":true,"tables":[{"year":2026,"month":9},{"year":null,"month":10}]}',
    );
    assert.deepEqual(parsed.tables, [
      { year: 2026, month: 9 },
      { year: null, month: 10 },
    ]);
  });
});

describe("日期日标记：三重过滤缺一不可", () => {
  const table = (cells) => ({
    querySelectorAll: (sel) => (sel === "td" ? cells : []),
  });

  test("点中目标日", () => {
    const target = el({ cls: "available", text: "29" });
    const out = run(buildDateDayMarkExpression(".p", 29), {
      one: () => table([el({ cls: "available", text: "28" }), target]),
    });
    assert.equal(out.found, true);
    assert.equal(target._attrs[PICK_ATTR], "1");
  });

  test("相邻月份的同名日子（prev-month / next-month）不算命中", () => {
    const out = run(buildDateDayMarkExpression(".p", 1), {
      one: () =>
        table([
          el({ cls: "prev-month", text: "1" }),
          el({ cls: "next-month", text: "1" }),
        ]),
    });
    assert.equal(out.found, false);
  });

  test("禁用的日子不算命中", () => {
    const out = run(buildDateDayMarkExpression(".p", 29), {
      one: () => table([el({ cls: "disabled", text: "29" })]),
    });
    assert.equal(out.found, false);
  });

  test("文本必须全等：找「1」不能命中「11」「21」", () => {
    const out = run(buildDateDayMarkExpression(".p", 1), {
      one: () => table([el({ cls: "available", text: "11" }), el({ cls: "available", text: "21" })]),
    });
    assert.equal(out.found, false);
  });

  test("parseDayMark：未命中时带上内部原因（只进 debug）", () => {
    assert.deepEqual(parseDayMark('{"found":false,"reason":"day-not-found"}'), {
      found: false,
      reason: "day-not-found",
    });
    assert.equal(parseDayMark("x"), null);
  });

  test("tableIndex 指定在哪张表里找（范围面板左右同一天号不会点错月）", () => {
    const leftDay = el({ cls: "available", text: "5" });
    const rightDay = el({ cls: "available", text: "5" });
    const root = {
      querySelectorAll: (sel) =>
        sel === ".el-date-table"
          ? [
              { querySelectorAll: (s) => (s === "td" ? [leftDay] : []) },
              { querySelectorAll: (s) => (s === "td" ? [rightDay] : []) },
            ]
          : [],
    };
    const out = run(buildDateDayMarkExpression(".p", 5, 1), { one: () => root });
    assert.equal(out.found, true);
    assert.equal(rightDay._attrs[PICK_ATTR], "1");
    assert.equal(leftDay._attrs[PICK_ATTR], undefined);
  });

  test("没有 .el-date-table 时退回整个面板（结构变化仍能用）", () => {
    const day = el({ cls: "available", text: "7" });
    const root = { querySelectorAll: (sel) => (sel === "td" ? [day] : []) };
    const out = run(buildDateDayMarkExpression(".p", 7, 0), { one: () => root });
    assert.equal(out.found, true);
    assert.equal(day._attrs[PICK_ATTR], "1");
  });
});

describe("窗口定位：目标月在哪张表、该往哪边翻", () => {
  const tables = (...list) => list.map(([y, m]) => ({ year: y, month: m }));

  test("pickTableIndex：命中返回下标，不在窗口返回 -1", () => {
    const t = tables([2026, 9], [2026, 10]);
    assert.equal(pickTableIndex(t, { y: 2026, m: 9, d: 1 }), 0);
    assert.equal(pickTableIndex(t, { y: 2026, m: 10, d: 1 }), 1);
    assert.equal(pickTableIndex(t, { y: 2026, m: 11, d: 1 }), -1);
  });

  test("navDirection：早于窗口往前、晚于窗口往后、在窗口内不动", () => {
    const t = tables([2026, 9], [2026, 10]);
    assert.equal(navDirection(t, { y: 2026, m: 8, d: 1 }), -1);
    assert.equal(navDirection(t, { y: 2026, m: 10, d: 1 }), 0);
    assert.equal(navDirection(t, { y: 2027, m: 1, d: 1 }), 1);
  });

  test("跨年也算得对（12 月 ↔ 次年 1 月）", () => {
    const t = tables([2026, 12], [2027, 1]);
    assert.equal(navDirection(t, { y: 2026, m: 11, d: 1 }), -1);
    assert.equal(navDirection(t, { y: 2027, m: 2, d: 1 }), 1);
    assert.equal(pickTableIndex(t, { y: 2027, m: 1, d: 1 }), 1);
  });

  test("读不出年月时不导航（宁可按当前显示点，也别瞎翻）", () => {
    assert.equal(navDirection([{ year: null, month: null }], { y: 2026, m: 9, d: 1 }), 0);
    assert.equal(navDirection([], { y: 2026, m: 9, d: 1 }), 0);
  });
});

describe("清理标记", () => {
  test("把上一轮留下的标记全部摘掉（残留会把这次点击引到别的元素）", () => {
    const a = el({ text: "a", attrs: { [PICK_ATTR]: "1" } });
    const b = el({ text: "b", attrs: { [PICK_ATTR]: "1" } });
    const out = run(buildClearMarksExpression(), {
      all: () => [a, b],
    });
    assert.equal(out.cleared, 2);
    assert.equal(a.getAttribute(PICK_ATTR), null);
    assert.equal(b.getAttribute(PICK_ATTR), null);
  });

  test("PICK_SELECTOR 与标记属性保持一致", () => {
    assert.equal(PICK_SELECTOR, `[${PICK_ATTR}="1"]`);
  });
});

describe("parseDateSpec：用例真会写的那些写法", () => {
  const now = new Date(2026, 8, 29); // 2026-09-29

  test("绝对日期：多种分隔符都认", () => {
    for (const text of [
      "2026-09-29",
      "2026/9/29",
      "2026.9.29",
      "2026年9月29日",
      " 2026-09-29 ",
    ]) {
      assert.deepEqual(parseDateSpec(text, now), { y: 2026, m: 9, d: 29 }, text);
    }
  });

  test("相对今天的写法", () => {
    assert.deepEqual(parseDateSpec("today", now), { y: 2026, m: 9, d: 29 });
    assert.deepEqual(parseDateSpec("今天", now), { y: 2026, m: 9, d: 29 });
    assert.deepEqual(parseDateSpec("+3", now), { y: 2026, m: 10, d: 2 });
    assert.deepEqual(parseDateSpec("-7", now), { y: 2026, m: 9, d: 22 });
  });

  test("相对写法要能跨月跨年（写死日期会让用例过几天就失败）", () => {
    const dec31 = new Date(2026, 11, 31);
    assert.deepEqual(parseDateSpec("+1", dec31), { y: 2027, m: 1, d: 1 });
  });

  test("不存在的日期与认不出的写法一律返回 null（绝不退回「今天」猜一个）", () => {
    assert.equal(parseDateSpec("2026-02-30", now), null);
    assert.equal(parseDateSpec("2026-13-01", now), null);
    assert.equal(parseDateSpec("下周三", now), null);
    assert.equal(parseDateSpec("", now), null);
    assert.equal(parseDateSpec("+", now), null);
  });
});

describe("monthDelta：决定往哪个方向翻、翻几个月", () => {
  test("同年、跨年、往回都算得对", () => {
    assert.equal(monthDelta({ y: 2026, m: 9 }, { y: 2026, m: 9, d: 1 }), 0);
    assert.equal(monthDelta({ y: 2026, m: 9 }, { y: 2026, m: 12, d: 1 }), 3);
    assert.equal(monthDelta({ y: 2026, m: 9 }, { y: 2027, m: 1, d: 1 }), 4);
    assert.equal(monthDelta({ y: 2026, m: 9 }, { y: 2026, m: 7, d: 1 }), -2);
  });
});

/**
 * 按触发元素自己声明的关联定位「它自己的」浮层。
 *
 * 这层存在的理由：光看「页面上有没有可见浮层」分不清「我刚点开的」和「上一个还在关闭
 * 动画里的」，而后者正盖在新控件上面。Element Plus 的 el-select 输入框带
 * `aria-controls`，顺它能精确拿到该控件的浮层（真机验证过）。
 */
describe("按关联定位 target 自己的浮层（aria-controls）", () => {
  function linked({ expanded }) {
    const target = "#msg .el-select__wrapper";
    const listbox = el({ cls: "el-select-dropdown__list", visible: expanded });
    const popper = el({
      cls: "el-popper el-select__popper",
      sels: [".el-popper"],
      visible: expanded,
    });
    listbox.closest = (sel) => (sel.includes("el-popper") ? popper : null);
    const input = el({
      cls: "el-select__input",
      attrs: { "aria-controls": "lb-1" },
      sels: ["[aria-controls]"],
    });
    const trigger = el({
      cls: "el-select__wrapper",
      sels: [target],
      children: [input],
    });
    return {
      popper,
      input,
      doc: {
        querySelector: (sel) => (sel === target ? trigger : null),
        querySelectorAll: () => [],
        getElementById: (id) => (id === "lb-1" ? listbox : null),
        activeElement: null,
      },
    };
  }

  test("target 打开着：命中并标记它自己的浮层", () => {
    const { doc, popper } = linked({ expanded: true });
    const out = run(buildOwnOverlayExpression("#msg .el-select__wrapper"), { dom: doc });
    assert.equal(out.hit, true);
    assert.equal(popper.getAttribute(ROOT_ATTR), "1");
  });

  test("target 关着：浮层节点还在 DOM 里但尺寸为 0，必须判成「没打开」", () => {
    const { doc, popper } = linked({ expanded: false });
    const out = run(buildOwnOverlayExpression("#msg .el-select__wrapper"), { dom: doc });
    assert.equal(out.hit, false, "关着却判成打开，就会「跳过点击」跳错");
    assert.equal(popper.getAttribute(ROOT_ATTR), null);
  });

  test("target 是 @eN（页面侧解析不了）时退回 activeElement", () => {
    const { doc, popper, input } = linked({ expanded: true });
    doc.querySelector = () => null;
    doc.activeElement = input;
    const out = run(buildOwnOverlayExpression("@e34"), { dom: doc });
    assert.equal(out.hit, true);
    assert.equal(popper.getAttribute(ROOT_ATTR), "1");
  });

  test("没有 aria-controls 时如实未命中（交给「任意可见浮层」的回退路径）", () => {
    const plain = el({ cls: "el-select__wrapper", sels: ["#plain"] });
    const doc = {
      querySelector: (sel) => (sel === "#plain" ? plain : null),
      querySelectorAll: () => [],
      getElementById: () => null,
      activeElement: null,
    };
    const out = run(buildOwnOverlayExpression("#plain"), { dom: doc });
    assert.equal(out.hit, false);
  });
});

/**
 * 多个同类控件（几个下拉、几个日期面板）。
 *
 * 这是报告 `report-20260929-102410.html` 里的真实现场：点开「消息类型」下拉之后，
 * `select_option` 报「浮层里没有可见文本为 Markdown 的选项，当前可选项：机器人、WEBHOOK」
 * —— 那是隔壁「发送渠道」下拉的选项。根因是探针用 `querySelectorAll` 挑出「第 N 个可见的」，
 * 后续却用 `querySelector` 拿 DOM 里的**第一个**。这一组用例把那条路径钉住。
 */
describe("多个同类控件：标记的那个才是操作的那个", () => {
  /** 造一个「发送渠道」在下、「消息类型」在上 的页面：两个下拉各有自己的 popper。 */
  function twoDropdowns() {
    const item = (text) =>
      el({
        cls: "el-select-dropdown__item",
        text,
        sels: [".el-select-dropdown__item"],
      });
    // DOM 里的第一个，但已收起（尺寸为 0）
    const channel = el({
      cls: "el-select-dropdown",
      visible: false,
      sels: [".el-select-dropdown"],
      children: [item("机器人"), item("WEBHOOK")],
    });
    const message = el({
      cls: "el-select-dropdown",
      sels: [".el-select-dropdown"],
      children: [item("文本"), item("Markdown")],
    });
    const nodes = [channel, message, ...channel._children, ...message._children];
    return { channel, message, nodes };
  }

  test("探针标记的是可见的那个，而不是 DOM 里第一个", () => {
    const { channel, message, nodes } = twoDropdowns();
    const out = run(buildOverlayProbeExpression(), { dom: domOf(nodes) });
    assert.equal(out.hit, true);
    assert.equal(message.getAttribute(ROOT_ATTR), "1");
    assert.equal(channel.getAttribute(ROOT_ATTR), null);
  });

  test("用普通选择器会读到隔壁下拉的选项（即报告里那个现场）", () => {
    const { nodes } = twoDropdowns();
    const dom = domOf(nodes);
    run(buildOverlayProbeExpression(), { dom });
    const bad = run(buildOptionMarkExpression(".el-select-dropdown", "Markdown"), { dom });
    assert.equal(bad.found, false);
    assert.deepEqual(bad.candidates, ["机器人", "WEBHOOK"]);
  });

  test("以根标记为范围：读到的就是自己那个浮层的选项", () => {
    const { nodes } = twoDropdowns();
    const dom = domOf(nodes);
    run(buildOverlayProbeExpression(), { dom });
    const good = run(buildOptionMarkExpression(ROOT_SELECTOR, "Markdown"), { dom });
    assert.equal(good.found, true);
    assert.equal(good.text, "Markdown");
  });

  test("隐藏浮层里的同名选项不会被选中（点不到，只会变成假成功）", () => {
    const { nodes } = twoDropdowns();
    const hidden = el({
      cls: "el-select-dropdown__item",
      text: "Markdown",
      visible: false,
      sels: [".el-select-dropdown__item"],
    });
    const hiddenBox = el({
      cls: "el-select-dropdown",
      attrs: { [ROOT_ATTR]: "1" },
      sels: [".el-select-dropdown"],
      children: [hidden],
    });
    const out = run(buildOptionMarkExpression(ROOT_SELECTOR, "Markdown"), {
      dom: domOf([...nodes, hiddenBox, hidden]),
    });
    assert.equal(out.found, false);
  });

  test("清标记时两个属性一起清（残留的根标记会让读选项读错浮层）", () => {
    const { message, nodes } = twoDropdowns();
    const dom = domOf(nodes);
    run(buildOverlayProbeExpression(), { dom });
    const item = message._children[1];
    item.setAttribute(PICK_ATTR, "1");
    assert.equal(message.getAttribute(ROOT_ATTR), "1");

    const out = run(buildClearMarksExpression(), { dom });
    assert.ok(out.cleared >= 2, `至少清掉两个标记，实际 ${out.cleared}`);
    assert.equal(message.getAttribute(ROOT_ATTR), null);
    assert.equal(item.getAttribute(PICK_ATTR), null);
  });

  test("多个日期面板：只读标记的那个（普通选择器会落在别人面板上）", () => {
    const otherDay = el({ cls: "available", text: "27", sels: ["td"] });
    const realDay = el({ cls: "available", text: "27", sels: ["td"] });
    const other = el({
      cls: "el-picker-panel",
      visible: false,
      sels: [".el-picker-panel"],
      children: [otherDay],
    });
    const real = el({
      cls: "el-picker-panel",
      sels: [".el-picker-panel"],
      children: [realDay],
    });
    const dom = domOf([other, real, otherDay, realDay]);
    run(buildDatePanelProbeExpression(), { dom });
    assert.equal(real.getAttribute(ROOT_ATTR), "1");

    // 普通选择器：标记打在了别的面板的日子上——点下去就改了别的控件
    run(buildDateDayMarkExpression(".el-picker-panel", 27, 0), { dom });
    assert.equal(otherDay.getAttribute(PICK_ATTR), "1");

    otherDay.removeAttribute(PICK_ATTR);
    run(buildDateDayMarkExpression(ROOT_SELECTOR, 27, 0), { dom });
    assert.equal(realDay.getAttribute(PICK_ATTR), "1");
    assert.equal(otherDay.getAttribute(PICK_ATTR), null);
  });

  test("scopedToRoot：面板里的箭头/确定被收在标记的那个面板内", () => {
    assert.deepEqual(scopedToRoot([".el-picker-panel__icon-btn"]), [
      `${ROOT_SELECTOR} .el-picker-panel__icon-btn`,
    ]);
  });
});

describe("录制：选择类控件记成**一个**步骤，不展开成 click", () => {
  const snapshot = [
    "@vom 1",
    "L1 page",
    '  RootWebArea "x"',
    '    @e1 combobox "状态"',
    '    @e2 textbox "日期"',
  ].join("\n");

  function recordOne(name, params, vars = []) {
    const r = new Recorder(vars);
    r.noteTool({ name, params, ok: true, lastSnapshot: snapshot });
    return r.recorded;
  }

  test("select_option：带控件定位符与选项文本", () => {
    const steps = recordOne("select_option", { target: "@e1", option: "已完成" });
    assert.equal(steps.length, 1);
    assert.equal(steps[0].kind, "select_option");
    assert.equal(steps[0].target, "@e1");
    assert.equal(steps[0].option, "已完成");
    assert.equal(steps[0].locator?.name, "状态");
  });

  test("pick_date：相对日期原样保留（回放时按当天重新算）", () => {
    const steps = recordOne("pick_date", { target: "@e2", date: "+3" });
    assert.equal(steps[0].kind, "pick_date");
    assert.equal(steps[0].date, "+3");
    assert.equal(steps[0].locator?.name, "日期");
  });

  test("pick_date：范围结束日期一起录进脚本", () => {
    const steps = recordOne("pick_date", {
      target: "@e2",
      date: "+3",
      endDate: "+5",
    });
    assert.equal(steps[0].date, "+3");
    assert.equal(steps[0].endDate, "+5");
  });

  test("单日期不写 endDate（回放时才不会被误判成范围）", () => {
    const steps = recordOne("pick_date", { target: "@e2", date: "+3" });
    assert.equal("endDate" in steps[0], false);
  });

  test("选项文本里的动态取值还原成占位符（否则下次回放没有这一项）", () => {
    const vars = [
      { name: "timestamp", placeholder: "${timestamp}", value: "202609291200" },
    ];
    const steps = recordOne(
      "select_option",
      { target: "@e1", option: "产品202609291200" },
      vars,
    );
    assert.equal(steps[0].option, "产品${timestamp}");
  });

  test("缺 target、选项文本为空、日期为空时什么都不记", () => {
    assert.deepEqual(recordOne("select_option", { option: "x" }), []);
    assert.deepEqual(recordOne("select_option", { target: "@e1" }), []);
    assert.deepEqual(recordOne("pick_date", { target: "@e2", date: "" }), []);
  });

  test("失败的尝试不进脚本（那是模型的探索过程）", () => {
    const r = new Recorder([]);
    r.noteTool({
      name: "select_option",
      params: { target: "@e1", option: "x" },
      ok: false,
      lastSnapshot: snapshot,
    });
    assert.deepEqual(r.recorded, []);
  });
});
