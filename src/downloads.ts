/**
 * 下载产物（Downloaded Artifact）：落盘路径策略 + 本次运行的捕获清单。
 *
 * 为什么单独一层：`download` 动作的产物不只是「一个文件」，还牵扯三件互相独立的事——
 * 路径（用户配的目录 / 用例显式给的路径）、命名（服务器建议名 bsk 要到落盘之后才告诉我们）、
 * 以及「本次运行到底收了哪些文件」（退出摘要在 stderr 里要交代，见 side-outputs.ts）。
 * 把它们和 bsk 命令的调用细节混在一个文件里，会让路径策略无法单测。
 *
 * 判定口径（见 docs/adr/0012）：**捕获到一次下载 + 文件真的落盘非空**才算成立；
 * 不校验文件内容——那是导出方自己的事，pageqa 越界去解析 xlsx 只会引入格式耦合。
 */
import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { readDownloadDir } from "./config.js";
import { t } from "./i18n.js";
import { formatLocalTime } from "./vars.js";

/**
 * 捕获一次下载的默认等待上限。
 *
 * 不沿用 bsk 自己的 2 分钟：导出接口常常是**服务端现生成**文件，几十秒很正常，但 2 分钟
 * 对「点了没反应」的排查太长了——用例里可以显式写更大的 timeout 放大它。
 */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;

/** 文件名里不允许出现的字符：路径分隔符（防目录穿越）+ Windows 保留字符 + 控制字符。 */
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 文件名长度上限（不含目录）：够放下正常导出名，又不会撞系统路径长度限制。 */
const MAX_NAME_LENGTH = 120;

/** 落盘文件名的保留兜底：服务器没给建议名（或建议名被清洗成空）时用它。 */
const FALLBACK_NAME = "download";

/** 落盘时间戳前缀的格式（与回放脚本、HTML 报告「文件名带时间戳」的既有做法一致）。 */
const STAMP_FORMAT = "yyyyMMdd-HHmmss";

/** 同一秒内多次捕获时的去重序号（bsk 默认拒绝覆盖已存在文件，撞名会直接失败）。 */
let stagingSeq = 0;

/**
 * 把服务器建议的文件名清洗成一个可落盘的文件名。
 *
 * 服务器给的 `Content-Disposition` 文件名是**外部输入**：可能带路径分隔符（`../x`）、
 * 可能是一长串非法字符、也可能是空串。直接当文件名用，轻则落盘失败，重则写到别的目录。
 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(ILLEGAL_NAME_CHARS, "_")
    // 去掉首尾的点与空格：Windows 上 `x.` 与 ` x` 都不是合法文件名
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, MAX_NAME_LENGTH);
  return cleaned || FALLBACK_NAME;
}

/**
 * 本次捕获的最终落盘路径。
 *
 * - 用例显式给了 `out` → 原样用它（相对路径按当前工作目录解析），**不加时间戳前缀**：
 *   显式路径就是要「就在那儿、就叫这个名」，加前缀等于不认用户的指定。
 * - 没给 → `<下载目录>/<时间戳>-<服务器建议名>`。与 HTML 报告「文件名带时间戳、多次运行
 *   互不覆盖」是同一套做法：一次运行一次证据，回放反复跑也不会把上一次的文件吃掉。
 */
export function downloadDestination(opts: {
  explicit?: string;
  suggestedName?: string;
  now: Date;
}): string {
  if (opts.explicit) {
    const out = opts.explicit.trim();
    return isAbsolute(out) ? out : resolve(out);
  }
  const stamp = formatLocalTime(opts.now, STAMP_FORMAT);
  const name = sanitizeFileName(opts.suggestedName ?? FALLBACK_NAME);
  return join(downloadDir(), `${stamp}-${name}`);
}

/** 解析最终生效的下载目录（配置值优先，相对路径按当前工作目录解析）。 */
export function downloadDir(): string {
  const configured = readDownloadDir();
  return isAbsolute(configured) ? configured : resolve(configured);
}

/**
 * 捕获用的临时落盘路径。
 *
 * 必须先落到临时名再改名：bsk 要求**先给 `--out`** 才能开始捕获，而「服务器建议的文件名」
 * 只有捕获完成后才知道——想用建议名命名，就绕不开这一跳。临时文件与最终文件同目录，
 * 改名是同卷操作，不会退化成复制。
 */
export function downloadStagingPath(now: Date): string {
  stagingSeq += 1;
  const stamp = formatLocalTime(now, STAMP_FORMAT);
  return join(downloadDir(), `.pageqa-staging-${stamp}-${stagingSeq}.part`);
}

/** 按需创建目录（显式路径的父目录也一并创建：写不进去比晚创建更糟）。 */
export function ensureDownloadDirFor(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * 同名文件已被占用时，取一个不冲突的路径（`x.xlsx` → `x-2.xlsx` → …）。
 *
 * bsk 默认拒绝覆盖，同秒同名的两次捕获会让第二次直接失败；这里退让一步总比报错好。
 */
export function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  const dir = dirname(path);
  const ext = extname(path);
  const stem = basename(path, ext);
  for (let i = 2; i < 100; i++) {
    const candidate = join(dir, `${stem}-${i}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return path;
}

/** 文件字节数；读不到（不存在/被占用）返回 null，由调用方决定怎么说。 */
export function fileSizeOrNull(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/**
 * 文件名通配匹配：支持 `*`（任意多字符）与 `?`（单字符），大小写不敏感。
 *
 * 为什么是通配而不是正则：写用例的人脑子里只有「后缀对不对」（`*.xlsx`），
 * 正则的转义对他纯粹是负担，而回放要的确定性通配已经足够表达。
 * 不带通配符的模式即「全等」（同样大小写不敏感）。
 */
export function matchFileName(pattern: string, fileName: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  const body = p
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "i").test(fileName);
}

/**
 * 下载断言在报告里的期望文案。
 *
 * 工具层与回放层共用：两边必须写出**同一句期望**，否则同一条用例在「带模型跑」与
 * 「零模型回放」下会呈现两种措辞，报告对比起来像两次不同的事。
 */
export function downloadExpectation(expectName?: string): string {
  return expectName
    ? t("bsk.download.expectationNamed", { pattern: expectName })
    : t("bsk.download.expectation");
}

/**
 * 一条下载产物的去处：`keep` = 保留（路径仍可查），`clean` = 断言成立后清理掉。
 *
 * 规则三条，都对着「什么情况下人还需要这个文件」：
 * - 用例**显式给了 `out`** → 保留：那是用户点名要的文件，工具没资格替他删。
 * - 配置把 `downloadCleanup` 关掉 → 保留：他要留档。
 * - 其余（默认路径 + 断言成立）→ 清理：回归跑一百次就堆一百个文件，通过的用例没人会去看它们。
 *
 * 断言**不成立**时不走这里：失败时的文件正是排查对象，一律保留（见 bsk/tools.ts）。
 */
export function downloadRetention(opts: {
  explicit?: boolean;
  cleanupEnabled: boolean;
}): "keep" | "clean" {
  if (opts.explicit) return "keep";
  return opts.cleanupEnabled ? "clean" : "keep";
}

/** 一条已落盘的下载产物。 */
export interface DownloadArtifact {
  /** 捕获时的绝对落盘路径。 */
  path: string;
  /**
   * 是否已把它清理掉（由场景收尾的 flushDownloadCleanup 置位）。
   *
   * 必须如实记录：报告证据与收尾清单里都还写着这个路径，不标明「已清理」的话，
   * 人去那个路径找不到文件，只会以为工具坏了（或以为下载其实没成功）。
   */
  cleaned: boolean;
}

/**
 * 本次运行捕获到的下载产物（按捕获顺序，断言失败但已落盘的也算）。
 *
 * 放在模块级而不是层层回传：退出摘要在 index.ts 收尾时才打，而捕获发生在工具层深处，
 * 中间隔着 agent / 场景 / 套件好几层；与 log.ts 的 sink 是同一个取舍。
 */
const captured: DownloadArtifact[] = [];

/** 判定「通过即清理」、等**场景收尾**再删的文件（见 flushDownloadCleanup）。 */
const pendingCleanup = new Set<string>();

/**
 * 记一次已落盘的下载产物。
 *
 * `cleanupPending` = 按保留规则该清理（默认路径 + 断言成立）：**只登记，不现在删**，
 * 真正的删除由场景收尾时的 flushDownloadCleanup 统一做。
 */
export function recordDownloaded(
  path: string,
  opts: { cleaned?: boolean; cleanupPending?: boolean } = {},
): void {
  captured.push({ path, cleaned: opts.cleaned ?? false });
  if (opts.cleanupPending) pendingCleanup.add(path);
}

/**
 * 删掉一个已捕获的文件，返回是否删掉了。
 *
 * 失败（被杀软扫描占用、权限不足、文件已被移走）只如实返回 false：断言已经成立，
 * 清理是收尾动作，它失败不该改结论，但也不能假装删掉了。
 */
export function cleanupDownloadedFile(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 场景收尾时统一清理登记过的文件。
 *
 * 为什么不在捕获成功后立刻删：**同一个场景里，这个文件还可能被后面的步骤/断言用到**
 * （人也会想在场景跑完前看一眼）。曾经是「捕获 → 立即删 → 再写结论」，结果只要后面还有
 * 任何一步要碰这个文件，就会看到「明明下载成功了，文件却已经没了」。
 * 移到收尾删，文件在整个场景期间都在，而运行结束时目录依然是干净的。
 *
 * 不抛错：清理失败只让那条产物**不带**「已清理」标记（说明它还在原处），不影响结论。
 */
export function flushDownloadCleanup(): void {
  for (const path of [...pendingCleanup]) {
    pendingCleanup.delete(path);
    if (!cleanupDownloadedFile(path)) continue;
    const artifact = captured.find((a) => a.path === path && !a.cleaned);
    if (artifact) artifact.cleaned = true;
  }
}

/** 本次运行捕获到的下载产物（只读快照，避免调用方改到内部状态）。 */
export function downloadedFiles(): readonly DownloadArtifact[] {
  return captured.map((a) => ({ ...a }));
}

/** 清空捕获清单与待清理登记（供单测与同一进程内的多次运行复用）。 */
export function resetDownloadedFiles(): void {
  captured.length = 0;
  pendingCleanup.clear();
}
