/**
 * 把 bsk 的 navigate 失败翻译成人话。
 *
 * 为什么要专门做这一层——一次真实的失败现场：
 *
 * ```text
 * Command failed: bsk navigate http://127.0.0.1:18888/ --session x --quiet
 * error: browser rejected the underlying CDP call
 * hint: confirm the tab is still in a loaded state and retry; reloading the tab usually resets a stuck DevTools session
 * details: Page.navigate rejected: net::ERR_CONNECTION_REFUSED
 * ```
 *
 * 三个问题：
 * 1. **信号在最后**：真正有用的只有 `details:` 那行的 `net::ERR_*` 码，而它排在噪声后面——
 *    日志与执行轨迹都有长度上限，截断后留下的恰好是噪声。
 * 2. **`hint` 在劝人重试**：`retry; reloading the tab usually resets a stuck DevTools session`
 *    是 bsk 的通用文案，对「本机服务没起」这种失败完全是误导——实测中模型正是据此连跑
 *    了两次 navigate。目标不可达时重试是纯浪费，而且会让报告显得像「试过了但不行」。
 * 3. `Command failed: …` 前缀是子进程包装的产物，不是诊断信息。
 *
 * 设计原则：**只翻译，不猜测**。
 * - 拿到 `net::ERR_*` 且认得这个码 → 给出确切解释与下一步；
 * - 认得前缀（证书/TLS 家族码很多，逐个列举既啰嗦又漏）→ 按家族解释；
 * - 是 `net::ERR_*` 但没收录 → 如实说「未收录、未做解释」并保留原始 details 行；
 * - **完全没有 `net::ERR_*`**（bsk daemon 挂了、session 失效、参数错等）→ 返回 null，
 *   调用方原样抛出，一个字都不加工。
 *
 * 最后那条边界是刻意的：诊断层的价值来自「说得准」，硬套一个分类比不解释更糟
 * ——这与 ADR-0001「不做猜一个最像的元素」是同一条理由。
 */

import { t } from "../i18n.js";

/** 一类失败的解释与下一步；文案存 i18n 键，渲染时按当前语种取。 */
interface Diagnosis {
  /** 发生了什么（i18n 键）。 */
  whatKey: string;
  /** 下一步做什么（非本机地址时用；i18n 键）。 */
  nextKey: string;
  /** 本机地址有更确定的下一步时用它（i18n 键）。 */
  localNextKey?: string;
}

/** 能给出确切解释的浏览器错误码。未列出的绝不硬套。 */
const EXACT: Record<string, Diagnosis> = {
  ERR_CONNECTION_REFUSED: {
    whatKey: "nav.ERR_CONNECTION_REFUSED.what",
    nextKey: "nav.ERR_CONNECTION_REFUSED.next",
    localNextKey: "nav.ERR_CONNECTION_REFUSED.localNext",
  },
  ERR_UNSAFE_PORT: {
    whatKey: "nav.ERR_UNSAFE_PORT.what",
    nextKey: "nav.ERR_UNSAFE_PORT.next",
  },
  ERR_NAME_NOT_RESOLVED: {
    whatKey: "nav.ERR_NAME_NOT_RESOLVED.what",
    nextKey: "nav.ERR_NAME_NOT_RESOLVED.next",
  },
  ERR_NAME_RESOLUTION_FAILED: {
    whatKey: "nav.ERR_NAME_RESOLUTION_FAILED.what",
    nextKey: "nav.ERR_NAME_RESOLUTION_FAILED.next",
  },
  ERR_CONNECTION_TIMED_OUT: {
    whatKey: "nav.ERR_CONNECTION_TIMED_OUT.what",
    nextKey: "nav.ERR_CONNECTION_TIMED_OUT.next",
  },
  ERR_TIMED_OUT: {
    whatKey: "nav.ERR_TIMED_OUT.what",
    nextKey: "nav.ERR_TIMED_OUT.next",
  },
  ERR_CONNECTION_RESET: {
    whatKey: "nav.ERR_CONNECTION_RESET.what",
    nextKey: "nav.ERR_CONNECTION_RESET.next",
  },
  ERR_HTTP_RESPONSE_CODE_FAILURE: {
    whatKey: "nav.ERR_HTTP_RESPONSE_CODE_FAILURE.what",
    nextKey: "nav.ERR_HTTP_RESPONSE_CODE_FAILURE.next",
  },
  ERR_ABORTED: {
    whatKey: "nav.ERR_ABORTED.what",
    nextKey: "nav.ERR_ABORTED.next",
  },
  ERR_EMPTY_RESPONSE: {
    whatKey: "nav.ERR_EMPTY_RESPONSE.what",
    nextKey: "nav.ERR_EMPTY_RESPONSE.next",
  },
  ERR_ADDRESS_UNREACHABLE: {
    whatKey: "nav.ERR_ADDRESS_UNREACHABLE.what",
    nextKey: "nav.ERR_ADDRESS_UNREACHABLE.next",
  },
};

/** 按前缀归类的家族（证书/TLS 的码很多，逐个列举既啰嗦又容易漏）。 */
const BY_PREFIX: { prefix: string; diagnosis: Diagnosis }[] = [
  {
    prefix: "ERR_CERT_",
    diagnosis: {
      whatKey: "nav.ERR_CERT_.what",
      nextKey: "nav.ERR_CERT_.next",
    },
  },
  {
    prefix: "ERR_SSL_",
    diagnosis: {
      whatKey: "nav.ERR_SSL_.what",
      nextKey: "nav.ERR_SSL_.next",
    },
  },
];

/** 取出浏览器错误码（`net::ERR_XXX`）。没有就返回 null——那是别的故障，不该由这里解释。 */
export function extractBrowserErrorCode(rawError: string): string | null {
  const m = rawError.match(/net::(ERR_[A-Z0-9_]+)/);
  return m ? m[1] : null;
}

/**
 * 从子进程错误里取出可读文本。
 *
 * 优先用 `stderr`：子进程非零退出时 `err.message` 只是 `Command failed: <命令>\n<stderr>`
 * 的拼接，真正的原因（以及 `details:` 那行）在 stderr 里；直接读它既准确，也不必依赖
 * Node 那句话的格式。
 */
export function readErrorText(err: unknown): string {
  const e = err as { stderr?: unknown; message?: string } | null | undefined;
  const stderr = typeof e?.stderr === "string" ? e.stderr : "";
  return stderr || e?.message || String(err);
}

/** 取出 `details:` 那一行（bsk 把真实原因放在这里）。 */
function detailsLine(rawError: string): string {
  const m = rawError.match(/^\s*details:\s*(.+)$/m);
  return m ? m[1].trim() : "";
}

/**
 * 目标是否本机地址。
 * 本机地址的失败几乎总是「服务没起」，可以给出比「确认目标服务已启动」更确定的下一步。
 */
export function isLocalTarget(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  );
}

/**
 * 把 navigate 的原始错误翻译成人话。
 *
 * 返回新消息（替代原始文本），或 `null` 表示「这不是浏览器错误码能解释的失败，别动它」。
 */
export function diagnoseNavigateFailure(
  url: string,
  rawError: string,
): string | null {
  const code = extractBrowserErrorCode(rawError);
  if (!code) return null;

  const found =
    EXACT[code] ?? BY_PREFIX.find((p) => code.startsWith(p.prefix))?.diagnosis;
  const local = isLocalTarget(url);

  if (!found) {
    // 没收录的码：只报码，不编解释；把 bsk 的原始 details 留下以便排查。
    const detail = detailsLine(rawError);
    return (
      t("nav.notFound", { url, code }) +
      (detail ? t("nav.notFoundDetail", { detail }) : "") +
      (local ? "\n" + t("nav.local") : "")
    );
  }

  const steer =
    local && found.localNextKey ? t(found.localNextKey) : t(found.nextKey);
  return t("nav.failLine", {
    url,
    what: t(found.whatKey),
    code,
    steer,
  });
}
