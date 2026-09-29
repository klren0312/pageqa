/**
 * 选择类控件（下拉框、日期/时间选择器）的页面侧探针。
 *
 * 为什么需要单独一层：这两类控件的「展开 → 找到目标 → 选中」在通用路径上要花掉
 * 4–6 次工具调用（每次都是一轮 LLM 往返，几秒），而其中真正必要的浏览器交互只有
 * 「点开、点选项」两次。把中间的观察与决策挪进工具内部，模型只发一次调用，
 * 这就是这一层存在的原因。
 *
 * 与 condition.ts / settle.ts 同一条实现路线：**同步表达式 + 外层轮询**，不依赖页面内
 * 的任何定时器（后台标签页的定时器会被节流到 1s 以上）。
 *
 * ## 混合策略（刻意的）
 *
 * 探针按「组件库专用选择器 → 通用 ARIA 选择器」的顺序找目标：
 * - 专用：Element Plus 的 `.el-select-dropdown` / `.el-picker-panel` 等。它们比 aria 树
 *   更稳（组件库不会随手改自己的类名），但**只对 Element Plus 成立**；
 * - 通用：`[role=listbox]` / `[role=option]` 等。任何遵循 ARIA 的组件库都能走通，
 *   命中不了时退回到「让模型自己看快照点」的通用路径。
 *
 * 因此这里的每个选择器都是**候选列表**而不是单值：多一条候选只是多一次
 * `querySelectorAll`，而写死一个类名会让版本升级直接失效。找不到时探针如实返回
 * `hit: false`，由调用方决定是回退还是报错——**绝不猜元素**（与 locator.ts 同一条底线）。
 *
 * ## 标记而不返回元素
 *
 * 表达式不能把 DOM 元素交回 Node 侧，所以「找到目标」与「点击目标」拆成两步：
 * 先给命中的元素打上 `data-pageqa-pick` 属性，再用一条 `bsk click '[data-pageqa-pick="1"]'`
 * 走**真实的点击路径**（与录制/回放里其它动作完全同一条命令），而不是在 evaluate 里
 * 调 `element.click()`——后者派发的是非受信事件，且绕过了 bsk 的可见性/可点性检查。
 *
 * 标记是临时的：每次操作前先清一遍，避免上次的残留把这次点击引到别的元素上。
 */

/** 唯一标记属性：命中后打上它，供后续 `bsk click` 精确定位。 */
export const PICK_ATTR = "data-pageqa-pick";

/**
 * 探针命中的**容器**标记（浮层或日期面板）。
 *
 * 为什么非要有它：探针回答的是「页面上**哪个**浮层可见」，后续表达式要「在**那个**浮层里
 * 找选项」。只把一个 CSS 选择器字符串传下去是不够的——`document.querySelector(".el-select-dropdown")`
 * 拿到的是 DOM 里的**第一个**，而页面上有几个下拉就有几个 `.el-select-dropdown`（各自的 popper
 * 常驻 DOM，隐藏时元素依然在），第一个往往属于别的下拉。于是出现「明明点开了 A 的下拉，
 * 却读到 B 的选项」这种错乱：`select_option` 报「浮层里没有可见文本为 Markdown 的选项，
 * 当前可选项：机器人、WEBHOOK」——那是隔壁下拉的选项。
 *
 * 让探针直接把命中的元素标出来，两边就**一定**是同一个，而不是「大概率」。
 */
export const ROOT_ATTR = "data-pageqa-root";

/** 探针命中容器的选择器：需要「以它内部为范围」的表达式都用它作根。 */
export const ROOT_SELECTOR = `[${ROOT_ATTR}="1"]`;

/**
 * 把候选选择器**限定在探针标记的容器内**。
 *
 * 面板里的箭头与「确定」按钮不能用全局选择器：页面上有几个日期选择器就有几个面板，
 * 全局选择器命中的是 DOM 里的第一个，点下去可能点在别人的面板上（要么点不到，要么把
 * 别的控件改掉）。加上根前缀之后，作用范围收在刚探测到的那一个面板里。
 */
export function scopedToRoot(selectors: readonly string[]): string[] {
  return selectors.map((sel) => `${ROOT_SELECTOR} ${sel}`);
}

/** 下拉浮层候选容器（按优先级：组件库专用在前，通用 ARIA 在后）。 */
export const OVERLAY_SELECTORS: readonly string[] = [
  ".el-select-dropdown",
  ".el-cascader__dropdown",
  ".el-dropdown-menu",
  "[role=listbox]",
  "[role=menu]",
];

/** 日期/时间面板候选容器。 */
export const DATE_PANEL_SELECTORS: readonly string[] = [
  ".el-picker-panel",
  ".el-date-picker",
  "[role=dialog] .el-picker-panel",
];

/**
 * 「还有没有浮层没收起」时扫的范围：比选择类控件自己的候选更宽。
 *
 * 判断「收干净了没有」必须覆盖**所有会盖在下面控件上**的东西——下拉、菜单、日期面板，
 * 以及各组件库自己的 popper 容器。少一类就会出现「以为收干净了，其实还压着一个，
 * 下一次点击落在了它身上」。
 */
export const WIDE_OVERLAY_SELECTORS: readonly string[] = [
  ...OVERLAY_SELECTORS,
  ...DATE_PANEL_SELECTORS,
  ".el-popper",
];

/** 面板「上一月」按钮候选。 */
export const DATE_PREV_SELECTORS: readonly string[] = [
  ".el-date-picker__prev-btn",
  ".el-picker-panel__icon-btn.el-date-picker__prev-btn",
  "button[aria-label*=Previous]",
  "button[aria-label*=previous]",
  "button[aria-label*=\"上个月\"]",
  "button[aria-label*=\"上一月\"]",
];

/** 面板「下一月」按钮候选。 */
export const DATE_NEXT_SELECTORS: readonly string[] = [
  ".el-date-picker__next-btn",
  ".el-picker-panel__icon-btn.el-date-picker__next-btn",
  "button[aria-label*=Next]",
  "button[aria-label*=next]",
  "button[aria-label*=\"下个月\"]",
  "button[aria-label*=\"下一月\"]",
];

/** 面板底部的「确定」按钮候选（部分类型/配置下才会出现；范围选择器通常都有）。 */
export const DATE_CONFIRM_SELECTORS: readonly string[] = [
  ".el-picker-panel__footer .el-button--primary",
  ".el-date-picker__footer .el-button--primary",
];

/**
 * 范围面板的「整体前移一个月 / 后移一个月」按钮候选。
 *
 * 与单日期面板的上下月按钮**不是同一批**：范围类型的两个箭头在左右两个 header 里
 * （`.arrow-left` / `.arrow-right`），点左侧的会把整个窗口一起前移，所以这里
 * 与 `DATE_PREV_SELECTORS` 分开维护。
 */
export const DATE_RANGE_PREV_SELECTORS: readonly string[] = [
  ".el-date-range-picker__header .arrow-left",
  ".el-date-range-picker .arrow-left",
  ".el-picker-panel__icon-btn.arrow-left",
];

export const DATE_RANGE_NEXT_SELECTORS: readonly string[] = [
  ".el-date-range-picker__header .arrow-right",
  ".el-date-range-picker .arrow-right",
  ".el-picker-panel__icon-btn.arrow-right",
];

/** 选项行候选选择器（容器内查找）。 */
export const OPTION_SELECTORS: readonly string[] = [
  ".el-select-dropdown__item",
  ".el-cascader-node",
  "[role=option]",
  "li",
];

/**
 * 页面侧「可见」判定（内联进表达式）。
 *
 * 只判尺寸与 `visibility`，**不判 opacity**：Element Plus 的 popper 用 opacity 做淡入，
 * 在动画中途读到的 `opacity` 可能是 0，据此判「不可见」会把刚展开的浮层判成没出现，
 * 于是白白等到超时。
 */
const VISIBLE_HELPER = [
  "  var isVisible = function (el) {",
  "    if (!el) return false;",
  "    try {",
  "      var r = el.getBoundingClientRect();",
  "      if (r.width <= 0 || r.height <= 0) return false;",
  "      var s = window.getComputedStyle(el);",
  "      return s.visibility !== 'hidden' && s.display !== 'none';",
  "    } catch (e) { return false; }",
  "  };",
].join("\n");

/** 安全的 JSON 字面量（防止引号/换行把脚本拼坏）。 */
function literal(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/**
 * 页面侧「标记命中容器」判定（内联进表达式）。
 *
 * 标记前先清掉旧的：探针可能被轮询调用多次，若先后命中过不同元素（前一个浮层关掉、
 * 后一个打开），留着两个标记会让后续 `querySelector(ROOT_SELECTOR)` 拿到先出现的那个
 * —— 正是这一层要根除的那类错乱。
 */
const ROOT_HELPER = [
  `  var ROOT_ATTR = ${literal(ROOT_ATTR)};`,
  "  var markRoot = function (node) {",
  "    try {",
  "      var old = document.querySelectorAll('[' + ROOT_ATTR + ']');",
  "      for (var k = 0; k < old.length; k++) old[k].removeAttribute(ROOT_ATTR);",
  "      node.setAttribute(ROOT_ATTR, '1');",
  "      return true;",
  "    } catch (e) { return false; }",
  "  };",
].join("\n");

/**
 * 探针：当前页面上有没有**可见的浮层**（下拉/菜单）、是哪条候选命中的，
 * 并**把命中的那个元素标出来**（`ROOT_ATTR`）供后续表达式以它为根。
 *
 * 返回的选择器文本只用于诊断（回答「靠哪条候选命中的」）；真正决定后续范围的是那个标记，
 * 因为页面上同时存在好几个同类浮层是常态，选择器字符串本身无法区分是哪一个。
 */
export function buildOverlayProbeExpression(
  candidates: readonly string[] = OVERLAY_SELECTORS,
): string {
  return [
    "(() => {",
    `  var CAND = ${literal(candidates)};`,
    VISIBLE_HELPER,
    ROOT_HELPER,
    "  for (var i = 0; i < CAND.length; i++) {",
    "    var nodes;",
    "    try { nodes = document.querySelectorAll(CAND[i]); } catch (e) { continue; }",
    "    for (var j = 0; j < nodes.length; j++) {",
    "      if (isVisible(nodes[j])) {",
    "        markRoot(nodes[j]);",
    "        return { hit: true, selector: CAND[i], count: nodes.length };",
    "      }",
    "    }",
    "  }",
    "  return { hit: false, selector: null, count: 0 };",
    "})()",
  ].join("\n");
}

/**
 * 按「触发元素自己声明的关联」找**它的**浮层。
 *
 * Element Plus 的 el-select 输入框带 `aria-controls="<浮层内部 listbox 的 id>"`，顺着它往上
 * 就能拿到这个控件自己的浮层。这比「页面上哪个浮层可见」可靠得多——后者分不清「我刚点开的」
 * 与「上一个还在关闭动画里的」。
 *
 * 真实页面上就是这一点串的：点开 A 选完，紧接着去点 B，浮层 A 还没收起来、正盖在 B 上面，
 * 点 B 的那一下**落在了 A 上**——A 的下拉没关、B 的下拉没开，于是后续读到的是 A 的选项。
 * 用关联定位还能顺带回答「target 到底打开了没有」：浮层节点在 DOM 里一直都在，
 * 关着的时候尺寸为 0，`isVisible` 直接把它排除。
 *
 * `target` 是 CSS 选择器时直接定位触发元素；`@eN` 引用在页面侧无法解析，退而用
 * `document.activeElement`（点击展开后焦点会落到这个控件的输入框上）。
 */
export function buildOwnOverlayExpression(target: string): string {
  return [
    "(() => {",
    `  var TARGET_SEL = ${literal(target)};`,
    VISIBLE_HELPER,
    ROOT_HELPER,
    "  var trigger = null;",
    "  try { trigger = document.querySelector(TARGET_SEL); } catch (e) { trigger = null; }",
    "  if (!trigger) {",
    "    try { trigger = document.activeElement; } catch (e) { trigger = null; }",
    "  }",
    "  if (!trigger) return { hit: false, selector: null, count: 0 };",
    "  var scopes = [trigger];",
    "  try {",
    "    var inner = trigger.querySelectorAll('[aria-controls]');",
    "    for (var i = 0; i < inner.length; i++) scopes.push(inner[i]);",
    "  } catch (e) {}",
    "  try { var up = trigger.closest('[aria-controls]'); if (up) scopes.push(up); } catch (e) {}",
    "  var owned = null;",
    "  for (var s = 0; s < scopes.length && !owned; s++) {",
    "    var id = null;",
    "    try { id = scopes[s].getAttribute('aria-controls'); } catch (e) {}",
    "    if (!id) continue;",
    "    var box = null;",
    "    try { box = document.getElementById(id); } catch (e) {}",
    "    if (!box) continue;",
    "    var host = null;",
    "    try { host = box.closest('.el-popper') || box.closest('.el-select-dropdown'); } catch (e) {}",
    "    owned = host || box;",
    "  }",
    "  if (!owned || !isVisible(owned)) return { hit: false, selector: null, count: 0 };",
    "  markRoot(owned);",
    "  return { hit: true, selector: null, count: 1 };",
    "})()",
  ].join("\n");
}

export interface OverlayProbe {
  hit: boolean;
  /** 命中的候选选择器（未命中为 null）。 */
  selector: string | null;
  /** 该选择器在页面上命中的节点数（诊断用：说明「只差可见性」还是「根本没有」）。 */
  count: number;
}

export function parseOverlayProbe(out: string): OverlayProbe | null {
  const raw = asRecord(out);
  if (!raw) return null;
  return {
    hit: raw.hit === true,
    selector: typeof raw.selector === "string" ? raw.selector : null,
    count: typeof raw.count === "number" ? raw.count : 0,
  };
}

/**
 * 在浮层内按**可见文本**找选项并打标记。
 *
 * `container` 应当传 `ROOT_SELECTOR`（探针刚标记的那个浮层），而不是一条普通的选择器：
 * 页面上有几个下拉就有几个 `.el-select-dropdown`，普通选择器只能定位到 DOM 里的第一个，
 * 而它往往是**别的**下拉的浮层——读到的选项自然也是隔壁的（「明明点开了消息类型，却看到
 * 机器人、WEBHOOK」）。只有根标记才能保证「打开的那个」与「读选项的那个」是同一个。
 *
 * 匹配分两轮：先全等（`textContent` 去空白后完全相同），再包含。全等优先是必要的——
 * 「北京」与「北京市」同时存在时，包含匹配会命中先出现的那个，而模型说的多半是全等的那条。
 * 都找不到时返回**候选列表**，让上层把「当前能选什么」如实交回给模型，而不是一句
 * 「没找到」让它重新猜。
 */
export function buildOptionMarkExpression(
  container: string,
  option: string,
  candidates: readonly string[] = OPTION_SELECTORS,
): string {
  return [
    "(() => {",
    `  var ROOT_SEL = ${literal(container)};`,
    `  var ITEM_SELS = ${literal(candidates)};`,
    `  var WANT = ${literal(option)};`,
    VISIBLE_HELPER,
    "  var norm = function (el) { return (el.textContent || '').replace(/\\s+/g, ' ').trim(); };",
    "  var root = document.querySelector(ROOT_SEL);",
    "  if (!root) return { found: false, text: '', candidates: [] };",
    "  var items = [];",
    "  for (var i = 0; i < ITEM_SELS.length; i++) {",
    "    var found;",
    "    try { found = root.querySelectorAll(ITEM_SELS[i]); } catch (e) { continue; }",
    "    if (found && found.length) { items = Array.prototype.slice.call(found); break; }",
    "  }",
    "  var texts = items.map(norm);",
    "  var hitIdx = -1;",
    "  for (var k = 0; k < texts.length; k++) {",
    "    if (texts[k] === WANT && isPickable(items[k])) { hitIdx = k; break; }",
    "  }",
    "  if (hitIdx === -1) {",
    "    for (var m = 0; m < texts.length; m++) {",
    "      if (texts[m].indexOf(WANT) !== -1 && isPickable(items[m])) { hitIdx = m; break; }",
    "    }",
    "  }",
    "  if (hitIdx === -1) {",
    "    return { found: false, text: '', candidates: texts.filter(function (t) { return t; }).slice(0, 30) };",
    "  }",
    "  var el = items[hitIdx];",
    "  // 虚拟列表里目标可能在视口外：先滚进视口，否则真实点击会落在屏外。",
    "  try { el.scrollIntoView({ block: 'nearest' }); } catch (e) {}",
    `  el.setAttribute(${literal(PICK_ATTR)}, '1');`,
    "  return { found: true, text: texts[hitIdx], candidates: [] };",
    "  function isPickable(node) {",
    "    if (!node) return false;",
    "    var cls = String(node.className || '');",
    "    // 组件库里「禁用」「已选」的项常常仍在 DOM 里：点它们不产生任何变化，",
    "    // 会被上层误判成「选了但没生效」，因此直接跳过。",
    "    if (cls.indexOf('is-disabled') !== -1 || cls.indexOf('disabled') !== -1) return false;",
    "    if (node.getAttribute && node.getAttribute('aria-disabled') === 'true') return false;",
    "    // 不可见的项同样跳过：别的下拉留下的隐藏节点、虚拟列表里已撤下的节点，",
    "    // 文本能匹配上却点不到（bsk 会判它不可点），匹配到只会把「找到」变成假成功。",
    "    if (!isVisible(node)) return false;",
    "    return true;",
    "  }",
    "})()",
  ].join("\n");
}

export interface OptionMark {
  found: boolean;
  /** 选中项的可见文本（全等或包含命中的那一条）。 */
  text: string;
  /** 未命中时的候选列表（供上层如实回报「当前能选什么」）。 */
  candidates: string[];
}

export function parseOptionMark(out: string): OptionMark | null {
  const raw = asRecord(out);
  if (!raw || typeof raw.found !== "boolean") return null;
  return {
    found: raw.found,
    text: typeof raw.text === "string" ? raw.text : "",
    candidates: Array.isArray(raw.candidates)
      ? raw.candidates.filter((c): c is string => typeof c === "string")
      : [],
  };
}

/**
 * 探针：日期面板是否已出现、它是**单日期**还是**范围**，以及面板里每张日历表显示的年月。
 *
 * 年月是从头部标签的**文本**里正则抽取的（`2026 年` / `9 月`），不依赖标签的具体顺序：
 * Element Plus 把年、月拆成两个 `.el-date-picker__header-label`，抽到哪个算哪个。
 * 抽不到就退回「从整块头部文本里抠 `YYYY 年 M 月`」，仍抽不到则给 `null`——
 * 上层据此放弃「翻月份」这一步，而不是照着猜出来的月份瞎点箭头。
 *
 * 返回**每张表**的年月（而不只是一份）是为范围选择器准备的：它左右各一个月，
 * 「目标日该点在哪张表里」必须按表分别判断，否则会点到相邻月的同一天。
 */
export function buildDatePanelProbeExpression(
  candidates: readonly string[] = DATE_PANEL_SELECTORS,
): string {
  return [
    "(() => {",
    `  var CAND = ${literal(candidates)};`,
    VISIBLE_HELPER,
    ROOT_HELPER,
    "  var readYearMonth = function (scope) {",
    "    var y = null, m = null;",
    "    var labels;",
    "    try { labels = scope.querySelectorAll('.el-date-picker__header-label'); } catch (e) { labels = []; }",
    "    for (var k = 0; k < labels.length; k++) {",
    "      var t = (labels[k].textContent || '').trim();",
    "      var ym = t.match(/(\\d{4})/);",
    "      var mm = t.match(/(\\d{1,2})\\s*月/);",
    "      if (ym && y === null) y = Number(ym[1]);",
    "      if (mm && m === null) m = Number(mm[1]);",
    "    }",
    "    if (y === null || m === null) {",
    "      // 头部结构变了（或语言/类型不同）：退回从整块头部文本里抠「YYYY 年 M 月」。",
    "      var head;",
    "      try { head = scope.querySelector('.el-date-picker__header') || scope; } catch (e) { head = scope; }",
    "      var flat = ((head.textContent) || '').replace(/\\s+/g, ' ');",
    "      var both = flat.match(/(\\d{4})\\s*年[\\s\\S]{0,40}?(\\d{1,2})\\s*月/);",
    "      if (both) { if (y === null) y = Number(both[1]); if (m === null) m = Number(both[2]); }",
    "    }",
    "    return { year: y, month: m };",
    "  };",
    "  var panel = null, sel = null;",
    "  for (var i = 0; i < CAND.length && !panel; i++) {",
    "    var nodes;",
    "    try { nodes = document.querySelectorAll(CAND[i]); } catch (e) { continue; }",
    "    for (var j = 0; j < nodes.length; j++) {",
    "      if (isVisible(nodes[j])) { panel = nodes[j]; sel = CAND[i]; break; }",
    "    }",
    "  }",
    "  if (!panel) {",
    "    return { hit: false, selector: null, isRange: false, tables: [], year: null, month: null, hasFooter: false };",
    "  }",
    "  // 页面上有几个日期选择器就有几个面板：标出当前可见的这个，后续「在哪张表里点哪一天」",
    "  // 与「点哪个箭头 / 哪个确定」都以它为范围，不会落到别人的面板上。",
    "  markRoot(panel);",
    "  var tableNodes = [];",
    "  try { tableNodes = panel.querySelectorAll('.el-date-table'); } catch (e) { tableNodes = []; }",
    "  var tables = [];",
    "  for (var ti = 0; ti < tableNodes.length; ti++) {",
    "    var scope = panel;",
    "    // 范围选择器把左右两个表各自包在 .el-date-range-picker__content 里，年月标签挂在",
    "    // 那个容器上而不是面板上——所以要从表往上找最近的它。",
    "    try { scope = tableNodes[ti].closest('.el-date-range-picker__content') || panel; } catch (e) { scope = panel; }",
    "    tables.push(readYearMonth(scope));",
    "  }",
    "  // 一个日历表都没找到（结构变了，或是月份/年份选择面板）：退回按整个面板读一次，",
    "  // 让上层至少还能拿到年月，而不是因为拿不到就完全放弃导航。",
    "  if (tables.length === 0) tables.push(readYearMonth(panel));",
    "  var isRange = tables.length >= 2;",
    "  if (!isRange) {",
    "    try { isRange = String(panel.className || '').indexOf('range') !== -1; } catch (e) {}",
    "  }",
    "  var footer = false;",
    "  try { footer = !!panel.querySelector('.el-picker-panel__footer'); } catch (e) {}",
    "  return {",
    "    hit: true, selector: sel, isRange: isRange,",
    "    tables: tables,",
    "    year: tables[0].year, month: tables[0].month,",
    "    hasFooter: footer,",
    "  };",
    "})()",
  ].join("\n");
}

/** 面板里一张日历表显示的年月。 */
export interface DateTableInfo {
  year: number | null;
  month: number | null;
}

export interface DatePanelProbe {
  hit: boolean;
  selector: string | null;
  /** 是不是范围选择器（左右两张日历表）。 */
  isRange: boolean;
  /** 面板里每张日历表的年月，按文档序（范围选择器即左 → 右）。 */
  tables: DateTableInfo[];
  /** 第一张表的年月（单日期面板就是它；保留这两个字段方便调用方）。 */
  year: number | null;
  month: number | null;
  /** 面板底部有没有「确定」（有就必须点它才算确认）。 */
  hasFooter: boolean;
}

export function parseDatePanelProbe(out: string): DatePanelProbe | null {
  const raw = asRecord(out);
  if (!raw || typeof raw.hit !== "boolean") return null;
  return {
    hit: raw.hit,
    selector: typeof raw.selector === "string" ? raw.selector : null,
    isRange: raw.isRange === true,
    tables: Array.isArray(raw.tables)
      ? raw.tables.map((entry) => {
          const row = (entry ?? {}) as { year?: unknown; month?: unknown };
          return {
            year: typeof row.year === "number" ? row.year : null,
            month: typeof row.month === "number" ? row.month : null,
          };
        })
      : [],
    year: typeof raw.year === "number" ? raw.year : null,
    month: typeof raw.month === "number" ? raw.month : null,
    hasFooter: raw.hasFooter === true,
  };
}

/**
 * 在日期面板里给「目标日」打标记。
 *
 * 三重过滤，缺一不可：
 * - `.disabled`：不可选的日期（超出 min/max、被禁用）；
 * - `.prev-month` / `.next-month`：Element Plus 会把相邻月份的日子填进表格，
 *   「1 号」在每个面板里都出现三次，不过滤就会点到上个月的 1 号；
 * - 文本必须与目标日**完全相等**（去空白后），否则「1」会命中「11」「21」。
 *
 * `tableIndex` 指定在哪张日历表里找：范围选择器左右各一个月，两边都可能出现同一个日号
 * （左边 9 月 5 日、右边 10 月 5 日），不区分表就会点到相邻月的同一天。面板里没有
 * `.el-date-table` 时退回整个面板，对结构变化保持容错。
 */
export function buildDateDayMarkExpression(
  panel: string,
  day: number,
  tableIndex = 0,
): string {
  return [
    "(() => {",
    `  var ROOT_SEL = ${literal(panel)};`,
    `  var DAY = ${literal(String(day))};`,
    `  var IDX = ${literal(tableIndex)};`,
    VISIBLE_HELPER,
    "  var root = document.querySelector(ROOT_SEL);",
    "  if (!root) return { found: false, reason: 'panel-gone' };",
    "  var scope = root;",
    "  var tables;",
    "  try { tables = root.querySelectorAll('.el-date-table'); } catch (e) { tables = []; }",
    "  if (tables.length > 0) scope = tables[IDX < tables.length ? IDX : 0];",
    "  var cells;",
    "  try { cells = scope.querySelectorAll('td'); } catch (e) { cells = []; }",
    "  for (var i = 0; i < cells.length; i++) {",
    "    var td = cells[i];",
    "    var cls = String(td.className || '');",
    "    if (cls.indexOf('disabled') !== -1) continue;",
    "    if (cls.indexOf('prev-month') !== -1 || cls.indexOf('next-month') !== -1) continue;",
    "    // 别的日期面板留下的隐藏表格里也有同名日子：点不到，还会把「命中」变成假成功。",
    "    if (!isVisible(td)) continue;",
    "    var text = (td.textContent || '').replace(/\\s+/g, '');",
    "    if (text !== DAY) continue;",
    `    td.setAttribute(${literal(PICK_ATTR)}, '1');`,
    "    return { found: true, reason: '' };",
    "  }",
    "  return { found: false, reason: 'day-not-found' };",
    "})()",
  ].join("\n");
}

export interface DayMark {
  found: boolean;
  reason: string;
}

export function parseDayMark(out: string): DayMark | null {
  const raw = asRecord(out);
  if (!raw || typeof raw.found !== "boolean") return null;
  return {
    found: raw.found,
    reason: typeof raw.reason === "string" ? raw.reason : "",
  };
}

/**
 * 清掉上一次留下的标记（每次操作前跑一遍）。
 *
 * **两个属性都要清**。只清点击标记是不够的：残留的根标记比它隐蔽得多——点击标记会让
 * `bsk click` 点错元素，通常表现为「点不到」，一眼可见；而残留的根标记会让「读选项」
 * 读错浮层，报出来的却是「没有这个选项，当前可选项：…」，看着像页面问题。
 */
export function buildClearMarksExpression(): string {
  return [
    "(() => {",
    "  var n = 0;",
    `  var nodes = document.querySelectorAll('[${PICK_ATTR}], [${ROOT_ATTR}]');`,
    "  for (var i = 0; i < nodes.length; i++) {",
    `    nodes[i].removeAttribute('${PICK_ATTR}');`,
    `    nodes[i].removeAttribute('${ROOT_ATTR}');`,
    "    n++;",
    "  }",
    "  return { cleared: n };",
    "})()",
  ].join("\n");
}

/** 命中标记的选择器（交给 `bsk click` 用真实点击路径点它）。 */
export const PICK_SELECTOR = `[${PICK_ATTR}="1"]`;

/** 一批候选里第一个**可用**的（在 Node 侧做静态选择，页面侧再逐个试）。 */
export function firstSelector(candidates: readonly string[]): string | null {
  return candidates.length > 0 ? candidates[0] : null;
}

/** 目标日期（面板要导航到的年月日）。 */
export interface DateSpec {
  y: number;
  m: number;
  d: number;
}

/**
 * 解析用例里写的日期。
 *
 * 支持的写法都是**测试用例里真的会写**的那些：
 * - 绝对日期：`2026-09-29`、`2026/9/29`、`2026.9.29`、`2026年9月29日`；
 * - 相对今天：`today` / `今天`、`+3` / `-7`（今天之后/之前的第 N 天）。
 *
 * 相对写法是有意支持的：用例写「选择三天后的日期」时，写死一个绝对日期会让这条用例
 * 在几天后失效——而这正是录制回放最讨厌的那种假失败。
 *
 * 解析不出来返回 null（调用方报错让人写清楚），**绝不退回到「今天」猜一个**。
 */
export function parseDateSpec(input: string, now: Date = new Date()): DateSpec | null {
  const raw = input.trim();
  if (!raw) return null;

  if (/^(today|今天)$/i.test(raw)) return fromDate(now);

  const rel = raw.match(/^([+-])\s*(\d{1,4})$/);
  if (rel) {
    const days = Number(rel[2]) * (rel[1] === "-" ? -1 : 1);
    const shifted = new Date(now.getTime());
    shifted.setDate(shifted.getDate() + days);
    return fromDate(shifted);
  }

  const abs = raw.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/);
  if (abs) {
    const y = Number(abs[1]);
    const m = Number(abs[2]);
    const d = Number(abs[3]);
    return validDate(y, m, d) ? { y, m, d } : null;
  }
  return null;
}

function fromDate(date: Date): DateSpec {
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
}

/** 校验收到的年月日是不是一个真实存在的日期（`2026-02-30` 必须拒绝）。 */
function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(y, m - 1, d);
  return (
    probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d
  );
}

/** 相对月份的差（`to` 比 `from` 晚几个月；用于决定点几次「下一月」）。 */
export function monthDelta(from: { y: number; m: number }, to: DateSpec): number {
  return (to.y - from.y) * 12 + (to.m - from.m);
}

/** 把「年 + 月」折成一个可比大小的整数（只用来比先后，不参与日期运算）。 */
function monthIndex(y: number, m: number): number {
  return y * 12 + (m - 1);
}

/** 目标月落在窗口里的第几张表（范围选择器左右各一张）；不在窗口内返回 -1。 */
export function pickTableIndex(
  tables: readonly DateTableInfo[],
  target: DateSpec,
): number {
  return tables.findIndex((t) => t.year === target.y && t.month === target.m);
}

/**
 * 窗口要往哪个方向移动，才能把目标月纳入视野。
 *
 * - `0`：已经在窗口内，直接点即可
 * - `-1`：目标更早，点「前移一个月」
 * - `1`：目标更晚，点「后移一个月」
 *
 * 窗口里读不出任何年月时返回 `0`（不导航）：宁可按当前显示去点、点不到再如实报错，
 * 也不要照着一个猜出来的方向连点十几次。
 */
export function navDirection(
  tables: readonly DateTableInfo[],
  target: DateSpec,
): -1 | 0 | 1 {
  const known = tables.filter(
    (t): t is { year: number; month: number } =>
      t.year !== null && t.month !== null,
  );
  if (known.length === 0) return 0;
  const want = monthIndex(target.y, target.m);
  const months = known.map((t) => monthIndex(t.year, t.month));
  if (want < Math.min(...months)) return -1;
  if (want > Math.max(...months)) return 1;
  return 0;
}

/** 安全的记录读取（与 condition.ts 同一套：认不出来返回 null）。 */
function asRecord(out: string): Record<string, unknown> | null {
  const text = out.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
