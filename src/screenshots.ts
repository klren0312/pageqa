/**
 * 截图产物：落盘路径 + 本次运行的截图清单。
 *
 * 与下载产物同构（都是一次运行留下的证据文件），但**去处相反**：下载产物断言成立后默认
 * 清理（回归跑一百次不该堆一百个文件）；截图是**给人看的证据**——报告里要嵌出来，
 * 删了就没得看，所以只登记、从不清理。
 *
 * 路径口径与下载产物完全一致（`<根目录>/screenshots/run-<启动时间戳>-<pid>-<随机串>/`），
 * 理由也相同：套件模式下每个场景一个子进程，进程之间不能共享路径（见 ADR-0013）。
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.js";
import { uniquePath } from "./downloads.js";
import { formatLocalTime } from "./vars.js";

/** 截图根目录：`~/.pageqa/screenshots`（与 `~/.pageqa/downloads` 同层）。 */
export function screenshotDir(): string {
  return join(CONFIG_DIR, "screenshots");
}

/** 落盘时间戳格式：与下载产物、HTML 报告同一套（文件名里一眼看出是哪一次）。 */
const STAMP_FORMAT = "yyyyMMdd-HHmmss";

/** 本次运行的身份：进程一开始就定下来，进程内不再变。 */
const runStartedAt = new Date();
const runToken = randomBytes(3).toString("hex");
let scopedDir: string | undefined;

/** 本次运行专属的截图目录（并发场景之间不共享路径，理由见文件头）。 */
export function runScreenshotDir(): string {
  scopedDir ??= join(
    screenshotDir(),
    `run-${formatLocalTime(runStartedAt, STAMP_FORMAT)}-${process.pid}-${runToken}`,
  );
  return scopedDir;
}

/**
 * 这次截图该落到哪。
 *
 * - 用例显式给了 `out` → 原样用它（与 `download` 的 `out` 同一条规则：点名了就是点名了）。
 * - 没给 → `<本次运行目录>/<时间戳>-<label>.png`，`label` 由调用方给（`viewport` /
 *   `full-page` / `element`），让人肉翻目录时也认得出这张图是什么。
 */
export function screenshotPath(now: Date, label: string, explicit?: string): string {
  const given = explicit?.trim();
  if (given) return given;
  const stamp = formatLocalTime(now, STAMP_FORMAT);
  // 同一秒内多次截图时退让为 `-2` / `-3`：bsk 默认拒绝覆盖已存在文件，撞名会让这次截图直接失败。
  return uniquePath(join(runScreenshotDir(), `${stamp}-${label}.png`));
}

/** 按需创建截图所在目录（显式路径的父目录也一并创建）。 */
export function ensureScreenshotDirFor(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * 本次运行截下的图（按截图顺序）。
 *
 * 放模块级而不是层层回传，理由与 downloads 的捕获清单相同：截图发生在工具层深处，
 * 而报告在最外层组装，中间隔着 agent / 场景 / 套件好几层。
 */
const taken: string[] = [];

/** 记一次已落盘的截图（报告据此嵌图）。 */
export function recordScreenshot(path: string): void {
  taken.push(path);
}

/** 本次运行截下的图（只读快照，避免调用方改到内部状态）。 */
export function screenshotsTaken(): readonly string[] {
  return [...taken];
}

/** 清空清单（供单测与同一进程内的多次运行复用）。 */
export function resetScreenshots(): void {
  taken.length = 0;
}
