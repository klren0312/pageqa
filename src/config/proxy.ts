/**
 * 模型请求的代理路由：按域名规则决定每个请求直连、走代理，还是「先直连、失败再走代理」。
 *
 * 解决的问题：模型端点（以及 Jev 这类外部 API）在某些网络下直连不通，而本机的
 * bsk daemon、localhost 上的模型端点又必须直连——一刀切地设 `HTTP_PROXY` 会把
 * 本地端点也塞进代理，症状是「连上了但不回话」。因此这里按域名逐条决定。
 *
 * 三种动作（`mode` / 每条规则的 `action`）：
 *   - direct:   永远直连
 *   - proxy:    永远走代理
 *   - fallback: 先直连，遇到网络层错误再走代理重试一次（默认）
 *
 * 装配点只有一个：`installProxyRouting()` 替换 `globalThis.fetch`。内置 provider
 * （anthropic / openai / deepseek …）与自定义端点的 SDK 客户端都由 pi-ai 在**每次请求
 * 时**构造，构造时取的正是当时的 `globalThis.fetch`，因此一次替换就同时覆盖两边。
 *
 * 配置文件：`~/.pageqa/proxy.json`（与 config.json 同目录，**不写进 config.json**——
 * 代理是网络环境问题，与「跑哪些用例」那类持久化偏好无关，混在一起会让 `--init-config`
 * 打印的模型配置里混进一条 proxy）。
 *
 * 优先级（高 -> 低）：`PAGEQA_PROXY_*` 环境变量 > proxy.json > 内置默认值。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { CONFIG_DIR, ensureConfigDir } from "./config.js";

/** 一个请求该走哪条路。 */
export type ProxyAction = "direct" | "proxy" | "fallback";

/** 一条域名规则：`match` 命中即生效（自上而下，第一条命中者胜）。 */
export interface ProxyRule {
  /** 域名模式，逗号分隔可写多个（`a.com,*.b.com`）。 */
  match: string;
  action: ProxyAction;
  /** 只给人看的备注，会原样出现在 `/proxy` 面板里。 */
  comment?: string;
}

export interface ProxyConfig {
  /** 代理地址，如 `http://127.0.0.1:7890`。 */
  proxy: string;
  /** 总开关：关掉后所有请求一律直连（规则不再参与判断）。 */
  enabled: boolean;
  /** 没有任何规则命中时的全局默认动作。 */
  mode: ProxyAction;
  rules: ProxyRule[];
}

/** 代理配置文件路径（`~/.pageqa/proxy.json`）。 */
export const PROXY_CONFIG_PATH = join(CONFIG_DIR, "proxy.json");

/**
 * 内置默认配置。
 *
 * 默认就装了两条规则，且默认 `enabled`：
 *   - 本机与内网直连：localhost 上的模型端点、bsk daemon 都靠它——把它们塞进代理是最常见的
 *     「配了代理反而跑不起来」。
 *   - 其余域名 fallback：直连能通就零开销（不碰代理），不通才走代理。墙内的模型端点
 *     因此「配好地址即生效」，而本机端点完全不受影响。
 *
 * 也就是说：没配 `proxy.json` 时，唯一的行为变化是「直连失败后会多试一次代理」。
 * 想彻底关掉有两条路：`enabled: false`，或进程环境 `PAGEQA_PROXY_ENABLED=false`。
 */
export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  proxy: "http://127.0.0.1:7890",
  enabled: true,
  mode: "fallback",
  rules: [
    {
      match:
        "localhost,127.0.0.1,::1,*.local,10.*,172.16.*,172.17.*,172.18.*,172.19.*,172.2*,172.30.*,172.31.*,192.168.*",
      action: "direct",
      comment: "本机与内网直连",
    },
    { match: "*", action: "fallback", comment: "默认先直连，网络不通时改走代理" },
  ],
};

// ─── 配置读取 ─────────────────────────────────────────────

/** 读配置文件原文并剥掉 BOM（与 config.ts 同一套理由：BOM 会让整份 JSON 解析失败）。 */
function readProxyConfigText(): string {
  return readFileSync(PROXY_CONFIG_PATH, "utf8").replace(/^\uFEFF/, "");
}

function isAction(value: unknown): value is ProxyAction {
  return value === "direct" || value === "proxy" || value === "fallback";
}

/**
 * 解析 proxy.json 的内容。
 *
 * 逐字段校验而不是整体 `?? 默认`：手写配置里 `"action": "PROXY"`（大小写错）或
 * `rules` 写成对象这类错误，静默沿用默认值会让人以为「配了没生效」。这里宁可整份退回
 * 默认配置，也不把半份配置用出难以排查的中间状态。
 */
function parseProxyConfig(raw: unknown): ProxyConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_PROXY_CONFIG };
  }
  const obj = raw as Record<string, unknown>;
  const rules: ProxyRule[] = [];
  if (Array.isArray(obj.rules)) {
    for (const item of obj.rules) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const rule = item as Record<string, unknown>;
      if (typeof rule.match !== "string" || !isAction(rule.action)) continue;
      rules.push({
        match: rule.match,
        action: rule.action,
        ...(typeof rule.comment === "string" ? { comment: rule.comment } : {}),
      });
    }
  }
  return {
    proxy:
      typeof obj.proxy === "string" && obj.proxy.trim()
        ? obj.proxy.trim()
        : DEFAULT_PROXY_CONFIG.proxy,
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : DEFAULT_PROXY_CONFIG.enabled,
    mode: isAction(obj.mode) ? obj.mode : DEFAULT_PROXY_CONFIG.mode,
    // 三种情形要分清，不能一律「没有规则就用默认」：
    //   - 没写 `rules`（或不是数组）→ 用默认规则；
    //   - 显式写 `"rules": []` → 就是「不设任何规则，全部按 mode」，尊重它
    //     （「所有请求都走代理」这种意图只能这样表达）；
    //   - 写了非空数组但一条都不合法 → 退回默认规则。静默当成「无规则」会让一次
    //     拼写错误（`"action": "PROXY"`）把所有请求悄悄改道。
    rules:
      rules.length > 0 || (Array.isArray(obj.rules) && obj.rules.length === 0)
        ? rules
        : [...DEFAULT_PROXY_CONFIG.rules],
  };
}

/**
 * 读取代理配置：`PAGEQA_PROXY_*` 环境变量 > `~/.pageqa/proxy.json` > 内置默认值。
 *
 * **不创建文件**：读配置不该有磁盘副作用（与 config.ts 的 `readRawConfig` 同一口径）。
 * 想要一份可改的模板用 `pageqa --init-config`。
 */
export function loadProxyConfig(): ProxyConfig {
  let cfg: ProxyConfig = { ...DEFAULT_PROXY_CONFIG };
  if (existsSync(PROXY_CONFIG_PATH)) {
    try {
      cfg = parseProxyConfig(JSON.parse(readProxyConfigText()));
    } catch {
      // 坏文件等同于没配：不让一个语法错误把整个 pageqa 拖到起不来。
      cfg = { ...DEFAULT_PROXY_CONFIG };
    }
  }
  const envProxy = process.env.PAGEQA_PROXY_URL?.trim();
  if (envProxy) cfg.proxy = envProxy;
  const envEnabled = process.env.PAGEQA_PROXY_ENABLED?.trim().toLowerCase();
  if (envEnabled === "true" || envEnabled === "1") cfg.enabled = true;
  else if (envEnabled === "false" || envEnabled === "0") cfg.enabled = false;
  const envMode = process.env.PAGEQA_PROXY_MODE?.trim().toLowerCase();
  if (isAction(envMode)) cfg.mode = envMode;
  return cfg;
}

/** 把配置片段合并写回 proxy.json（保留其它字段），返回写盘后的完整配置。 */
export function saveProxyConfig(patch: Partial<ProxyConfig>): ProxyConfig {
  ensureConfigDir();
  let current: Record<string, unknown> = {};
  if (existsSync(PROXY_CONFIG_PATH)) {
    try {
      const parsed: unknown = JSON.parse(readProxyConfigText());
      current =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
    } catch {
      current = {};
    }
  }
  const merged = { ...current, ...patch };
  writeFileSync(PROXY_CONFIG_PATH, JSON.stringify(merged, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  return parseProxyConfig(merged);
}

/**
 * 确保 `proxy.json` 存在（`--init-config` 用）：不存在就写一份带默认值的模板。
 *
 * 刻意**不**在首次运行时自动创建：代理配置不是每次跑用例都需要的东西，凭空在用户目录里
 * 多一个文件只会让人猜它是什么。想改代理的人会主动 `--init-config` 或手写这个文件。
 */
export function ensureProxyConfigFile(): { path: string; created: boolean } {
  if (existsSync(PROXY_CONFIG_PATH)) {
    return { path: PROXY_CONFIG_PATH, created: false };
  }
  ensureConfigDir();
  writeFileSync(PROXY_CONFIG_PATH, JSON.stringify(DEFAULT_PROXY_CONFIG, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  return { path: PROXY_CONFIG_PATH, created: true };
}

// ─── 规则匹配 ─────────────────────────────────────────────

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 域名模式匹配。
 *
 * `*` 是**任意位置**的通配（不只是 pi-proxy 那种「`*.` 前缀 / `.*` 后缀」两种写法）——
 * 内网网段写成 `172.2*` 才说得通，若只认后缀它会永远不匹配，而且不报错。
 * 通配之外一律按字面量转义，不引入正则元字符的意外。
 */
function matchPattern(hostname: string, pattern: string): boolean {
  if (pattern === "*") return true;
  // `*.example.com` 同时匹配裸域本身（`api.example.com` 与 `example.com` 都算）。
  const source = pattern.startsWith("*.")
    ? `^(?:.*\\.)?${escapeRegExp(pattern.slice(2))}$`
    : `^${escapeRegExp(pattern).replace(/\\\*/g, ".*")}$`;
  return new RegExp(source).test(hostname);
}

/** 这个 URL 该走哪条路：规则自上而下，第一条命中者胜；都没命中用全局 `mode`。 */
export function resolveProxyAction(url: string, config: ProxyConfig): ProxyAction {
  let hostname: string;
  try {
    // IPv6 的 `URL.hostname` 是带方括号的（`[::1]`），规则里写 `::1` 才符合直觉。
    hostname = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    // 解析不了的 URL（相对路径、畸形字符串）没有「目的地」可言，直连。
    return "direct";
  }
  for (const rule of config.rules) {
    const patterns = rule.match
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (patterns.some((p) => matchPattern(hostname, p))) return rule.action;
  }
  return config.mode;
}

// ─── 代理 Agent ───────────────────────────────────────────

/**
 * **走代理**时用的 fetch：undici 自己的实现，与下面的 `ProxyAgent` 出自同一份 undici。
 *
 * 刻意不把外部 undici 的 `ProxyAgent` 塞给 Node 内置的 fetch：内置 fetch 用的是 Node 自带
 * 的那份 undici，两份的请求处理接口跨大版本并不兼容（实测报
 * `InvalidArgumentError: invalid onRequestStart method`，且不会退化成「连不上」而是直接抛）。
 * 同一份 undici 内部的 fetch + dispatcher 则必然配套。
 *
 * 直连仍然走 Node 原生 fetch（`nativeFetch`）：那条路径没有任何理由换实现。
 */
const proxiedFetch = undiciFetch as unknown as typeof globalThis.fetch;

let proxyAgent: ProxyAgent | null = null;
let proxyAgentUrl = "";

/** 按代理地址取 agent；地址变了就换一个（换代理 = 换连接池）。 */
function getProxyAgent(proxyUrl: string): ProxyAgent {
  if (!proxyAgent || proxyAgentUrl !== proxyUrl) {
    proxyAgent = new ProxyAgent(proxyUrl);
    proxyAgentUrl = proxyUrl;
  }
  return proxyAgent;
}

/**
 * 判定一个错误是不是「网络层不通」——只有这类错误才值得换代理重试。
 *
 * 判据同时看 `message` 与整条 `cause` 链：Node 的 fetch 抛的是 `TypeError: fetch failed`，
 * 真正的原因（`ECONNREFUSED` / `ENOTFOUND` / 超时…）挂在 `cause` 上，甚至再嵌一层
 * `AggregateError`。只看 message 会把所有网络错误都当成「不是网络错误」，fallback 永不触发。
 */
const NETWORK_ERROR_CODES = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
];

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return `${err.name} ${err.message} ${cause === undefined ? "" : errorText(cause)}`;
  }
  return String(err);
}

export function isNetworkError(err: unknown): boolean {
  const text = errorText(err);
  return (
    text.includes("fetch failed") ||
    text.includes("other side closed") ||
    NETWORK_ERROR_CODES.some((code) => text.includes(code))
  );
}

/**
 * 请求体还能不能再发一次。
 *
 * fetch 的 body 是流时一旦发起就已消费，重试只会得到一个更难懂的报错
 * （`Response body object should not be disturbed or locked`）。这种情况直接放弃 fallback。
 */
function bodyReplayable(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (init?.body && typeof init.body === "object" && "getReader" in init.body) {
    return false;
  }
  return !(typeof Request !== "undefined" && input instanceof Request && input.bodyUsed);
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

// ─── 运行期状态 ───────────────────────────────────────────

/** 当前生效的配置（`loadProxyConfig` 的结果 + 面板改过的开关）。 */
let config: ProxyConfig = loadProxyConfig();
/** 会话级「先别管代理」开关：不写盘，只让本次会话所有请求直连。 */
let bypassed = false;

const stats: ProxyStats = { direct: 0, proxy: 0, fallback: 0, fallbackHit: 0 };

/** 请求计数：按实际发生的路由结果分类（fallback 里含改走代理的那部分）。 */
export interface ProxyStats {
  direct: number;
  proxy: number;
  fallback: number;
  /** fallback 中因为直连失败而真的改走代理的次数。 */
  fallbackHit: number;
}

/** 本次会话的代理状态概览（供 `/proxy` 面板与 `--init-config` 展示）。 */
export interface ProxyStatus {
  config: ProxyConfig;
  /** 面板临时关掉了（不落盘）。 */
  bypassed: boolean;
  /** 实际是否会对请求动手。 */
  active: boolean;
  stats: ProxyStats;
}

export function proxyStatus(): ProxyStatus {
  return {
    config,
    bypassed,
    active: config.enabled && !bypassed,
    stats: { ...stats },
  };
}

/** 重新读 `proxy.json` 并覆盖运行期配置（面板的「重新加载」用；返回生效后的配置）。 */
export function reloadProxyConfig(): ProxyConfig {
  config = loadProxyConfig();
  return config;
}

/** 改总开关并写回 proxy.json（面板的「开启/关闭」用）。 */
export function setProxyEnabled(enabled: boolean): ProxyConfig {
  config = { ...saveProxyConfig({ enabled }), enabled };
  return config;
}

/** 会话级「本次先直连」/恢复（不落盘）。 */
export function setProxyBypassed(next: boolean): void {
  bypassed = next;
}

/** 规则的可读列表（`/proxy` 面板与文档里的表格同一种格式）。 */
export function describeProxyRules(cfg: ProxyConfig = config): string[] {
  return cfg.rules.map(
    (r) => `${r.action.padEnd(8)} ${r.match}${r.comment ? "  # " + r.comment : ""}`,
  );
}

// ─── fetch 包装 ───────────────────────────────────────────

/**
 * 套上代理路由的 fetch。
 *
 * `base` 是**未被包装过**的那个 fetch（通常是 Node 原生实现）：一旦包错对象，
 * fallback 的第二次请求会再进一次规则判断，代理套代理。
 */
export function createProxyFetch(
  base: typeof fetch,
  read: () => ProxyConfig = () => config,
  isOff: () => boolean = () => bypassed,
): typeof fetch {
  return async function proxyFetch(input, init) {
    const cfg = read();
    if (!cfg.enabled || isOff()) {
      stats.direct++;
      return base(input, init);
    }
    const action = resolveProxyAction(urlOf(input), cfg);
    if (action === "direct") {
      stats.direct++;
      return base(input, init);
    }
    if (action === "proxy") {
      stats.proxy++;
      return proxiedFetch(input, withProxyDispatcher(init, cfg.proxy));
    }
    // fallback：先直连，网络层不通再走代理重试一次。
    stats.fallback++;
    try {
      return await base(input, init);
    } catch (err) {
      if (!isNetworkError(err) || !bodyReplayable(input, init)) throw err;
      stats.fallbackHit++;
      return proxiedFetch(input, withProxyDispatcher(init, cfg.proxy));
    }
  } as typeof fetch;
}

/**
 * 带上代理 dispatcher 的请求参数。
 *
 * `dispatcher` 是 undici 的扩展字段，既不在 `@types/node` 的 `RequestInit` 里，
 * 也不在 DOM 的那份里，但 Node 内置的 fetch 实实在在认它——类型只能从这儿绕过去。
 */
function withProxyDispatcher(
  init: RequestInit | undefined,
  proxyUrl: string,
): RequestInit {
  return { ...init, dispatcher: getProxyAgent(proxyUrl) } as RequestInit;
}

let installed = false;

/**
 * 模块加载时的 `globalThis.fetch`（即 Node 原生实现），所有包装都以它为底。
 *
 * 必须在任何替换发生**之前**捕获：包装的底座若换成「已被包装的 fetch」，
 * 一次请求就会被判两次路由、fallback 也会套一层代理，统计与行为一起失真。
 */
const nativeFetch: typeof fetch = globalThis.fetch;

/**
 * 装配全局代理路由：把 `globalThis.fetch` 换成带规则判断的那个。
 *
 * 这是**唯一**的装配点：自定义端点与内置 provider（anthropic / openai / …）都由
 * pi-ai 在每次请求时构造 SDK 客户端，客户端默认取当时的 `globalThis.fetch`，
 * 因此一次替换就够；也刻意不留第二个注入入口（见 llm.ts 的说明）。
 *
 * 幂等：重复调用只装一次（CLI 入口与库用法都可能调它）。返回一个还原函数——
 * 测试与「临时直连」用得到，正常流程不需要调用。
 */
export function installProxyRouting(): () => void {
  if (installed) return () => {};
  globalThis.fetch = createProxyFetch(nativeFetch);
  installed = true;
  return () => {
    globalThis.fetch = nativeFetch;
    installed = false;
  };
}

/** 是否已经装配过（测试用）。 */
export function isProxyRoutingInstalled(): boolean {
  return installed;
}

/** 只重置统计计数（测试用）。 */
export function resetProxyStats(): void {
  stats.direct = 0;
  stats.proxy = 0;
  stats.fallback = 0;
  stats.fallbackHit = 0;
}
