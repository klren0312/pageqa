/**
 * 选择器里超长条目的横向滚动（跑马灯）。
 *
 * 模型 id 动辄三四十列（`anthropic/claude-3-5-sonnet-20241022` 之类），而弹窗给名字留的那一列
 * 只有 30 列宽：**偏偏用户停在某一条上时，最需要看清的就是「这条到底是不是我要的那个模型」**。
 * 因此选中的那一条超长时让它自己向左滚出头来——未选中项仍按宽度静静截断（列表要的是整齐），
 * 只有光标停住的那条会动。
 *
 * 滚动是**循环**的：把名字后面接一段空隙、再接一遍名字，窗口在这条长串上滑动。这样就不存在
 * 「滚到名字末尾再跳回开头」那一下——那一下在屏幕上就是一次闪动（整行文字瞬间平移几十列），
 * 而循环滚动每一帧只错开一列，看不出接缝在哪。
 *
 * 实现挂在 pi-tui `SelectList` 暴露的 `truncatePrimary` 钩子上（`render()` 会逐项调用它），
 * 所以滚动是**渲染期**算出来的：这里不拥有任何渲染时机，只提供「给定偏移量该显示哪一段」，
 * 由外部（`app.ts`）按帧推进 `offset` 并请求重绘。窗口计算刻意做成纯函数，`slice` / `measure`
 * 由调用方注入 pi-tui 的 `sliceByColumn` / `visibleWidth`——与 `./overlay-frame.ts` 同一套路，
 * 好让「宽度必须等于列宽」这类不变量可以直接单测，也让本模块不依赖 pi-tui 的运行时。
 */

/** 与 pi-tui `visibleWidth` 同形：字符串占多少终端列。 */
export type WidthMeasure = (text: string) => number;

/** 与 pi-tui `sliceByColumn` 同形：按可见列切片（`strict` 时不含跨界越界的宽字符）。 */
export type ColumnSlice = (
  line: string,
  startColumn: number,
  length: number,
  strict?: boolean,
) => string;

/** 每帧移动几列。1 列/帧最耐看：快了像闪，慢了像卡。 */
export const MARQUEE_STEP_COLUMNS = 1;

/** 帧间隔（约 10 列/秒）。 */
export const MARQUEE_FRAME_MS = 100;

/**
 * 滚起来之前先在起点停几帧。
 *
 * 否则光标一落到某条上名字就立刻滚走，用户看到的第一眼反而是名字中段——而不是「这条叫什么」。
 * 只在换选中项时停，循环过程中不再停：中途一停一顿反而更像卡顿。
 */
export const MARQUEE_HOLD_FRAMES = 10;

/** 一遍名字与下一遍之间的空隙（列）：太挤会看不出「这里是一遍的结尾」。 */
export const MARQUEE_GAP_COLUMNS = 3;

/**
 * 滚一轮要走过多少列：`名字宽度 + 空隙`。名字放得下就是 0——0 同时是「不需要滚」的信号，
 * 调用方据此停表（见 `MarqueeScroller.setSelection`）。
 */
export function marqueePeriod(fullWidth: number, width: number): number {
  if (fullWidth <= width) return 0;
  return fullWidth + MARQUEE_GAP_COLUMNS;
}

/**
 * 取名字在 `offset` 列处、宽 `width` 列的那一段。
 *
 * 滚的是「名字 + 空隙 + 名字 + …」这条无限长串上的一个滑窗，偏移量按一轮的列数取模：因此
 * `offset = 0` 与 `offset = marqueePeriod(...)` 逐字相同，滚过一轮的边界与滚到中间没有任何
 * 区别——这正是「循环滚动不闪」的来源。名字放得下时原样返回（未选中项、短名字都不动）。
 */
export function marqueeWindow(
  text: string,
  width: number,
  offset: number,
  measure: WidthMeasure,
  slice: ColumnSlice,
): string {
  const full = measure(text);
  const period = marqueePeriod(full, width);
  if (period === 0) return text;
  // 负数偏移也归一到一轮之内（调用方不该给，但取模的代价比一个负下标异常小得多）。
  const start = ((offset % period) + period) % period;
  const cycle = text + " ".repeat(MARQUEE_GAP_COLUMNS);
  // 铺两遍就够：窗口最右也就到 `period - 1 + width`，而 `width < full < period`。
  // strict 切片：宁可右边空一列，也不让宽字符（中文、模型 id 里的罕见字符）只露出半格——
  // 那会顶破列宽、把右边的描述挤歪。
  return slice(cycle + cycle, start, width, true);
}

/**
 * 跑马灯的推进器：谁在滚、滚到哪、什么时候停。
 *
 * 表只在**选中项超长**时开着：`setSelection` 每次渲染都被调用一次，短名字、没有选中项、
 * 浮层关掉之后都不该有定时器在后台空转着请求重绘。定时器必须能被 `dispose` 掉——
 * 它是 `setInterval`，会一直吊住事件循环，收尾时不主动停会让进程退不出去。
 */
export class MarqueeScroller {
  /** 当前选中项的身份（`SelectItem.value`）：换一条就从头再滚。 */
  private key: string | undefined;
  private period = 0;
  private current = 0;
  private hold = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly onFrame: () => void) {}

  /** 当前偏移列数（总在一轮之内：取模发生在 `advance` 里）。 */
  get offset(): number {
    return this.current;
  }

  /** 渲染期登记「当前选中项 + 它滚一轮的列数」；选中项一变就回到起点重新滚。 */
  setSelection(key: string, period: number): void {
    if (key !== this.key) {
      this.key = key;
      this.current = 0;
      this.hold = MARQUEE_HOLD_FRAMES;
    }
    this.period = period;
    if (period > 0) this.start();
    else this.stop();
  }

  /** 推进一帧（定时器与单测共用，不含任何渲染副作用）。 */
  advance(): void {
    if (this.period <= 0) return;
    if (this.hold > 0) {
      this.hold -= 1;
      return;
    }
    // 取模而不是「到顶归零」：滚过一轮的边界时，画面上只是又挪了一列。
    this.current = (this.current + MARQUEE_STEP_COLUMNS) % this.period;
  }

  /** 停表并忘掉当前选中项（浮层关闭、收尾时调用）。 */
  dispose(): void {
    this.stop();
    this.key = undefined;
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.frame(), MARQUEE_FRAME_MS);
    // 定时器不该把进程拴住：即使某一刻没停干净，也不该妨碍退出。
    this.timer.unref?.();
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.current = 0;
  }

  /** 只在画面上真的会变时请求重绘：起点的停顿帧不必浪费一轮渲染。 */
  private frame(): void {
    const before = this.offset;
    this.advance();
    if (this.offset !== before) this.onFrame();
  }
}
