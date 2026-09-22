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

/** 一类失败的解释与下一步。 */
interface Diagnosis {
  /** 发生了什么。 */
  what: string;
  /** 下一步做什么（非本机地址时用）。 */
  next: string;
  /** 本机地址有更确定的下一步时用它。 */
  localNext?: string;
}

/** 能给出确切解释的浏览器错误码。未列出的绝不硬套。 */
const EXACT: Record<string, Diagnosis> = {
  ERR_CONNECTION_REFUSED: {
    what: "连接被拒绝——目标端口没有服务在监听",
    next: "确认目标服务已启动、地址与端口写对了；服务未运行前重复 navigate 不会成功",
    localNext:
      "这是本机地址：请先启动该端口的服务再重试；服务没起来之前重复 navigate 不会成功",
  },
  ERR_UNSAFE_PORT: {
    what: "浏览器把该端口列为不安全端口，直接拒绝了访问",
    next: "换一个端口：Chrome/Edge 会拦掉一批低位端口（如 1、21、25、110），换个高位端口即可",
  },
  ERR_NAME_NOT_RESOLVED: {
    what: "域名解析不了",
    next: "检查域名拼写、DNS 是否可达；内网域名通常需要先连上 VPN",
  },
  ERR_NAME_RESOLUTION_FAILED: {
    what: "域名解析失败",
    next: "检查域名拼写、DNS 是否可达；内网域名通常需要先连上 VPN",
  },
  ERR_CONNECTION_TIMED_OUT: {
    what: "连接超时——主机不可达",
    next: "确认网络能到目标；也可能是被防火墙拦掉，或目标地址本身不通",
  },
  ERR_TIMED_OUT: {
    what: "连接超时——主机不可达",
    next: "确认网络能到目标；也可能是被防火墙拦掉，或目标地址本身不通",
  },
  ERR_CONNECTION_RESET: {
    what: "连接被对端重置",
    next: "目标服务可能正在重启或崩溃；确认它能正常响应后再试",
  },
  ERR_HTTP_RESPONSE_CODE_FAILURE: {
    what: "服务器返回了错误状态码，页面没能加载",
    next: "确认该 URL 在浏览器里直接打开是正常的；也可能是所在网络有代理/网关拦截",
  },
  ERR_ABORTED: {
    what: "导航被中止",
    next: "多见于页面自身触发了新的跳转或关闭；确认目标 URL 是否稳定",
  },
  ERR_EMPTY_RESPONSE: {
    what: "服务器没有返回任何内容",
    next: "确认目标服务在正常响应（可用浏览器直接打开该地址核对）",
  },
  ERR_ADDRESS_UNREACHABLE: {
    what: "目标地址不可达",
    next: "确认主机在线、地址与端口写对了",
  },
};

/** 按前缀归类的家族（证书/TLS 的码很多，逐个列举既啰嗦又容易漏）。 */
const BY_PREFIX: { prefix: string; diagnosis: Diagnosis }[] = [
  {
    prefix: "ERR_CERT_",
    diagnosis: {
      what: "TLS 证书校验不通过",
      next: "自签或内网证书需要先在浏览器里信任；也可确认是否该改用 http",
    },
  },
  {
    prefix: "ERR_SSL_",
    diagnosis: {
      what: "TLS 握手失败",
      next: "确认目标是否支持 https、证书是否已信任",
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
      `无法打开 ${url}：浏览器报 ${code}（此错误码尚未收录，未做解释）。` +
      (detail ? `原始信息：${detail}` : "") +
      (local
        ? "\n这是本机地址：请确认该端口的服务已启动。"
        : "")
    );
  }

  const steer = (local && found.localNext) || found.next;
  return `无法打开 ${url}：${found.what}（net::${code}）。\n${steer}`;
}
