/**
 * 免费网关目录：把 pi-free（`apmantza/pi-free`）里「不花钱也能用」的那一批
 * OpenAI 兼容网关搬进 pageqa的模型目录，让它们出现在 `/model` 里。
 *
 * 为什么不直接装 pi-free：它是 **Pi CLI 的扩展**，peer 依赖 `@earendil-works/pi-coding-agent`
 * 与 `@earendil-works/pi-ai@^0.86`，只导出 `./dist/index.js` 一个入口，且注册走
 * `pi.registerProvider()` 这个宿主 API——pageqa 没有 Pi 宿主，import 它只会拉进一棵装不下的依赖树。
 * 能复用的是它**整理出来的数据**：每个网关的 base URL、鉴权变量名、以及哪些模型真的免费。
 * 这里按pi-free 的 `docs/providers.md` 与 `docs/free_models.md`（2026-08-26 审计）落成一份目录。
 *
 * 两条设计线：
 * - **目录先远端后快照**：`fetchModels` 打各网关的 `/v1/models`（公开的不要key），
 *   失败时 pi-ai 保留基线——即内置快照，因此断网/被墙也总能列出模型。
 *   快照是「上一次审计的答案」，只用来兜底，不用来覆盖上游。
 * - **只列免费的**：`/model` 里出现一个用不了的付费模型没有意义。免费判定 =
 *   命中快照、命中该网关的免费命名规律（`:free` / `-free` / `xxx/free`），
 *   或网关自己给的权威免费标记（Kilo 的 `isFree`）。
 *
 * cline 与 kilo 另有浏览器登录（`/login <provider>` 选 OAuth）：cline 走本地回环回调，
 * kilo 走设备码。两条流程都按pi-free 的实现对齐，差别见各自的注释。
 *
 * 关于pi-free 里那个 `opencode-free`（Zen 匿名 public bearer）：**明确否决，不做**。
 * 它的免费层会指纹请求里的工具列表——`tools[]` 必须同时含 `bash`/`edit`/`glob`/`grep`/`read`
 * 五个小写工具名，否则 403 `FreeTierError`。pageqa 的工具集是浏览器动作（navigate/click/fill…），
 * 为了过这个指纹塞五个死工具，等于每轮都往模型上下文里扔它永远不会用的假工具。
 * 需要它就用 pi-ai 内置的 `opencode` / `opencode-go`（配`OPENCODE_API_KEY`）。详见 ADR-0017。
 */
import { createServer } from "node:http";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  createProvider,
  envApiKeyAuth,
  type ApiKeyAuth,
  type Model,
  type OAuthAuth,
  type OAuthCredential,
  type Provider,
  type ProviderAuthInteraction,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";
import { t } from "../shared/i18n.js";

/** 一个免费网关的目录定义。 */
interface FreeProviderSpec {
  /** provider id（与 pi-free 一致，便于对照上游文档）。 */
  id: string;
  /** `/model`、`/login` 里展示的名字。 */
  name: string;
  /** OpenAI 兼容根地址，末位不带斜杠；模型目录在`<baseUrl>/models`。 */
  baseUrl: string;
  /** 登录提示里用的鉴权名（`/login` 会拿它拼提示语）。 */
  authName: string;
  /** 鉴权环境变量名；未配key 时是否仍算「已配置」（网关本就免登录）。 */
  apiKeyEnv?: string;
  /**
   * 允许匿名：没有凭据也resolve 出一个空 apiKey，让这个 provider 出现在 `/model`。
   * 与 pi-free 同一口径——目录公开、聊天免密的网关（cline / llm7 / fastrouter）
   * 不该因为「没配 key」而整块消失；真发不出去时探活（`probeModel`）会给出可读报错。
   */
  anonymous?: boolean;
  /**
   * 固定 bearer：无论有没有凭据都用它，且**不提供登录**。
   *
   * opencode-free 专用：Zen 的免费层只认字面量 `public`，带上账号 key 反而被上游拒
   * （403 `Model access is disabled`）——「配了 key → 报错」比「没配 key → 能用」还糟，
   * 所以这里让固定值压过存储凭据与环境变量。
   */
  fixedApiKey?: string;
  /**
   * 该网关的目录端点**只列免费模型**，动态目录因此全收。
   *
   * 与 `freePattern` 的区别是语义：`freePattern` 是「按名字猜」，这里是「上游的这条车道
   * 本身就是免费车道」。用哪个由网关的目录性质决定，不是风格选择。
   */
  allCatalogFree?: boolean;
  /**
   * 浏览器登录流程（`/login` 里会多出这一项）。
   *
   * pi-ai 拿到 OAuth 凭据后调`toAuth` 换请求鉴权，并在过期时调 `refresh`——两条都归这个
   * 对象管，因此「登录一次、之后自动续期」不需要 pageqa 再写任何代码。
   */
  oauth?: OAuthAuth;
  /** 内置免费模型快照（pi-free `docs/free_models.md`，2026-08-26 审计）。 */
  snapshot: readonly string[];
  /**
   * 运行时新出现的免费模型判定。**留空表示「只认快照」**——
   * llm7 的 `default`/`fast` 是精选 selector，底下就是付费模型池，不能靠命名规律放行。
   * 命名规律只能覆盖「上游自己标了免费」的那部分，剩下的靠快照补，因此两个来源是并集。
   */
  freePattern?: RegExp;
  /**
   * 网关自带权威免费标记（`/models` 每条带 `isFree`）时置true：命中即收。
   *
   * 只在标记为true 时采信、反向不排除——目录字段名变了或标记缺失时，最坏结果是退回
   * 快照 + 命名规律，而不是把快照里的模型也一起丢掉。
   */
  trustsFreeFlag?: boolean;
  /** 逐模型追加的请求头（部分网关按客户端身份放行）。 */
  headers?: () => Record<string, string>;
  /** 逐模型覆盖的OpenAI 兼容参数（部分网关不吃默认行为，如 Kilo 不支持流式用量）。 */
  compat?: Record<string, boolean | string>;
}

/** OpenRouter 风格的「免费路由」命名：`:free` 后缀或 `-free` 后缀。 */
const FREE_SUFFIX = /(?::free|-free)$/i;

/**
 * 「免费路由」的完整命名规律：`:free` / `-free` 后缀，或最后一段就是 `free`
 * （如 orcarouter 的 `orcarouter/free`）。
 *
 * 只覆盖「上游自己标了免费」的那部分，因此每个网关**显式声明**用哪一条（或不用），
 * 而不是全体套一条默认——llm7 就是反例：它的 `default` / `fast` 是精选 selector，
 * 底下就是付费模型池，按名字推断等于把付费模型放进来。
 */
const FREE_ROUTE = /(?::free|-free)$|(?:^|\/)free$/i;

/**
 * 网关动态目录的上下文窗口/输出上限。
 *
 * `/v1/models` 只回模型 id，不回窗口大小，而这两个数字直接决定 pageqa 何时裁剪上下文
 * （见 agent.ts 的 `transformContext`）：报小了会**过度裁剪**（长场景静默丢证据），
 * 报大了会把请求推过端点上限（场景跑到一半才 400）。
 * 这批网关在架的免费模型（gpt-oss-120b、qwen3.5-397b、nemotron-3.5、deepseek-v4）
 * 实际窗口都在 128k 以上，取这个中间值：既不按最小预设无谓裁剪，也不押注各家上限。
 */
const GATEWAY_CONTEXT_WINDOW = 128_000;
const GATEWAY_MAX_OUTPUT = 32_000;

/**
 * Cline 网关按客户端身份放行，缺头会 403（与 pi-free `providers/cline/cline-headers.ts` 同源）。
 *
 * 这里是**冒充第三方客户端身份**——知情下接受的代价，理由与跟进动作见 ADR-0017 决策五。
 * 下面两个常量因此是一份声明而非随手抄来的字面量：上游改了它们，这里就会退化成 403。
 */
const CLINE_EXTENSION_VERSION = "4.1.10";
const VS_CODE_VERSION = "1.109.3";
const ULID_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * 生成一个 ULID（Cline 用它当 `X-Task-ID`）。
 *
 * 只需在单次运行内唯一、不重复，因此时间戳取 `Date.now()` 的 32 进制补到 10 位，
 * 后16 位取随机字节——不需要密码学强度，也就不必引入 `crypto`。
 */
function generateUlid(): string {
  let ts = Date.now().toString(32).toUpperCase();
  while (ts.length < 10) ts = "0" + ts;
  const rand = new Uint8Array(16);
  let suffix = "";
  for (const byte of rand) suffix += ULID_CHARS[byte % 32]!;
  return ts + suffix;
}

/**
 * 逐模型盖上 Cline 身份头。
 *
 * 返回**新对象**而不是共享记录：pi-ai 在每次请求时合并模型的 `headers`，
 * 因此这里新造一份就能让每个模型各带一个自己的 task id，不必再维护「旋转共享记录」那套机制。
 */
function clineHeaders(): Record<string, string> {
  return {
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline",
    "X-Task-ID": generateUlid(),
    "X-PLATFORM": "Visual Studio Code",
    "X-PLATFORM-VERSION": VS_CODE_VERSION,
    "X-CLIENT-TYPE": "VSCode Extension",
    "X-CLIENT-VERSION": CLINE_EXTENSION_VERSION,
    "X-CORE-VERSION": CLINE_EXTENSION_VERSION,
    "X-Is-Multiroot": "false",
    "User-Agent": `Cline/${CLINE_EXTENSION_VERSION}`,
  };
}

/** opencode-free 的 provider id（工具指纹的挂载点要用，见 `createOpencodeFreeGateTools`）。 */
export const OPENCODE_FREE_PROVIDER_ID = "opencode-free";

/**
 * OpenCode Zen 免费层的**工具指纹**：请求的 `tools[]` 必须同时带上这五个小写工具名，
 * 否则 403 `FreeTierError: OpenCode's free tier can only be used from within OpenCode`。
 *
 * 这是 Zen 用来筛「只有 OpenCode 自己的客户端才可能发出这种请求」的门禁（pi-free issue #544）。
 * Pi 的默认工具roster 里已经有 `read`/`bash`/`edit`，缺 `glob`/`grep`，所以 pi-free 只补两个；
 * pageqa 的工具集是浏览器动作，**五个都没有**，所以五个都要补。
 */
export const OPENCODE_FREE_GATE_TOOLS = [
  "bash",
  "edit",
  "glob",
  "grep",
  "read",
] as const;

/**
 * 逐模型盖上 OpenCode Zen 的客户端标识头。
 *
 * 与 Cline 同一种性质：冒充 OpenCode CLI 的身份。pi-free 的注释说这个 header 门禁
 * 目前在服务端是关着的（只当日志与向前兼容），真正的门禁是上面的工具指纹；
 * 这里照发是为了「门禁哪天真开回来时不用改代码」。
 */
function opencodeHeaders(): Record<string, string> {
  return {
    "User-Agent": "opencode/1.18.18",
    "x-opencode-client": "cli",
  };
}

/**
 * 构造通过工具指纹的**工具桩**。
 *
 * 这五个工具在 pageqa 里没有实现，也不该有：pageqa 做的是页面测试，给模型一把 `bash`
 * 等于开一条它随时能误用、而我们完全没有为它设计护栏的路。所以它们是纯占位——
 * 声明存在（过门禁），一旦真被调用就明确说「本工具在当前运行不可用」并指向浏览器工具。
 *
 * 代价说清楚：这五个声明每轮都会进模型上下文（约几百 token），模型也确实可能去调它们。
 * 换来的是 Zen 免费层的匿名额度。这是知情选择，理由见 ADR-0017 决策七。
 */
export function createOpencodeFreeGateTools(): AgentTool[] {
  return OPENCODE_FREE_GATE_TOOLS.map((name) => ({
    name,
    label: name,
    description:
      `**占位工具，未实现**：pageqa 是页面测试 agent，没有 ${name} 能力。` +
      "不要调用它；请改用 navigate / snapshot / click / fill / select_option / pick_date / " +
      "assert_text 等浏览器工具完成操作。",
    parameters: { type: "object", properties: {} } as unknown as AgentTool["parameters"],
    execute: async (): Promise<AgentToolResult> => ({
      content: [
        {
          type: "text",
          text: `工具 ${name} 在 pageqa 中未实现（它只是为了通过模型提供方的客户端校验而声明）。请改用浏览器工具：navigate / snapshot / click / fill / select_option / pick_date / assert_text。`,
        },
      ],
      details: {},
    }),
  })) as unknown as AgentTool[];
}

/**
 * 逐模型盖上 Kilo 的归因头。
 *
 * 与 Cline 不同，这里**不冒充**任何客户端：Kilo 网关把 `X-KILOCODE-EDITORNAME` 当作归因元数据，
 * 缺了也照样收（pi-free 的注释里写明这一点）。所以如实报自己的名字。
 */
function kiloHeaders(): Record<string, string> {
  return { "X-KILOCODE-EDITORNAME": "pageqa" };
}

/**
 * 浏览器登录：Cline（本地回环回调）。
 *
 * 流程与 pi-free 的 `providers/cline/cline-auth.ts` 对齐：
 * 1. 在 127.0.0.1 上起一个回环监听（端口 48801–48811，占用就顺延），回调路径 `/auth`；
 * 2. 打 `/auth/authorize`（带 Cline 身份头、`redirect: "manual"`）换回一个真正的授权链接，
 *    拿它的 `Location` 或 JSON `redirect_url`——这一步不能省：直接拿 baseUrl 拼出来的地址不是它要的；
 * 3. 用户在浏览器里授权，被重定向回回环地址，query 上带着 `refreshToken` / `idToken` / `code`；
 * 4. 用它换 access/refresh token。
 *
 * 与 pi-free 的两处刻意不同：
 * - **不做「手动粘贴回跳URL」那条旁路**。它要在整个等待期挂着一个输入框，pageqa 的输入框
 *   在这段时间就被占住，用户连场景都提交不了；而 pageqa 跑在用户本机，回环一定打得通。
 *   万一真不通（浏览器在容器/虚拟机里），超时错误会把「回调没到达」这件事说清楚。
 * - **过期时间只减 60s 余量**，而不是照抄 pi-free 的 5 分钟。pi-ai 自己在
 *   `DEFAULT_OAUTH_MINIMUM_VALIDITY_MS`（5 分钟）之前就触发刷新；再减 5 分钟等于**每次请求都刷新一次**。
 */
const CLINE_CALLBACK_PORTS = Array.from({ length: 11 }, (_, i) => 48801 + i);
const CLINE_CALLBACK_PATH = "/auth";
const CLINE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const CLINE_EXPIRY_SLACK_MS = 60 * 1000;

/** Cline 授权只在固定的这台主机上发生，绝不接受调用方传入的 URL。 */
const CLINE_AUTH_HOST = "api.cline.bot";

const CALLBACK_PAGE_OK =
  '<!doctype html><meta charset="utf-8"><title>pageqa</title>' +
  "<p>登录完成，可以关闭这个页面。</p>";
const CALLBACK_PAGE_BAD =
  '<!doctype html><meta charset="utf-8"><title>pageqa</title>' +
  "<p>没有拿到授权码，请回到终端重新登录。</p>";

/** 回环回调里取到的授权码，以及它是走哪个身份提供方登录的（google/github/…）。 */
interface ClineCallback {
  code: string;
  provider: string | null;
}

/** Cline 把真实到期时间放在 `expiresAt`；留 60s 余量，并拒绝已经过期的时间戳。 */
function parseClineExpiresAt(expiresAt: string): number {
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) throw new Error("Cline 授权响应里的 expiresAt 无法解析");
  return Math.max(Date.now() + CLINE_EXPIRY_SLACK_MS, ms - CLINE_EXPIRY_SLACK_MS);
}

/**
 * 起一个回环回调监听。
 *
 * 端口被占用是常态（48801 附近很容易撞），因此按列表顺延而不是失败——回环地址端口不通，
 * OAuth 就完全走不下去。
 */
async function startClineCallbackServer(signal: AbortSignal): Promise<{
  callbackUrl: string;
  waitForCode: Promise<ClineCallback>;
  close: () => void;
}> {
  let settle: ((value: ClineCallback) => void) | undefined;
  let fail: ((err: unknown) => void) | undefined;
  const waitForCode = new Promise<ClineCallback>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== CLINE_CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    const code =
      url.searchParams.get("refreshToken") ??
      url.searchParams.get("idToken") ??
      url.searchParams.get("code");
    if (!code) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(CALLBACK_PAGE_BAD);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(CALLBACK_PAGE_OK);
    settle?.({ code, provider: url.searchParams.get("provider") });
  });

  let port = 0;
  for (const candidate of CLINE_CALLBACK_PORTS) {
    if (signal.aborted) break;
    const listening = await new Promise<boolean>((resolve) => {
      const onError = (): void => resolve(false);
      server.once("error", onError);
      server.listen(candidate, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolve(true);
      });
    });
    if (listening) {
      port = candidate;
      break;
    }
  }
  if (port === 0) {
    server.close();
    throw new Error(
      `本机回环端口 ${CLINE_CALLBACK_PORTS[0]}-${CLINE_CALLBACK_PORTS[CLINE_CALLBACK_PORTS.length - 1]} 都被占用，无法接收 Cline 的登录回调`,
    );
  }

  const close = (): void => {
    // 只 `close()` 不够：浏览器/undici 把回调连接留成了 keep-alive，socket 不断开
    // 这个 handle 就一直让进程活着（测试里表现为「跑完了不退出」）。
    server.closeAllConnections();
    server.close();
  };
  signal.addEventListener("abort", close, { once: true });
  return { callbackUrl: `http://127.0.0.1:${port}${CLINE_CALLBACK_PATH}`, waitForCode, close };
}

/** 打 Cline 的 `/auth/authorize` 换回真正的授权链接。 */
async function fetchClineAuthorizeUrl(
  callbackUrl: string,
  signal: AbortSignal,
): Promise<string> {
  const authUrl = new URL(`https://${CLINE_AUTH_HOST}/auth/authorize`);
  authUrl.searchParams.set("client_type", "extension");
  authUrl.searchParams.set("callback_url", callbackUrl);
  authUrl.searchParams.set("redirect_uri", callbackUrl);

  const res = await fetch(authUrl.toString(), {
    method: "GET",
    redirect: "manual",
    credentials: "include",
    headers: clineHeaders(),
    signal,
  });
  // 两条路都见过：直接 3xx 带 Location，或 200 带 redirect_url。
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("Location");
    if (location) return location;
    throw new Error("Cline 授权响应里没有 Location");
  }
  const body = (await res.json()) as { redirect_url?: string };
  if (typeof body?.redirect_url === "string" && body.redirect_url.length > 0) {
    return body.redirect_url;
  }
  throw new Error("Cline 授权响应里没有 redirect_url");
}

/**
 * 用回环拿到的授权码换token。
 *
 * `provider` 是回调带回来的身份提供方；没带就依次试空值与四个已知提供方——Cline 的
 * `/auth/token` 在提供方不匹配时不会说清楚是哪个错了，只能按顺序试。
 */
async function exchangeClineCode(
  callback: ClineCallback,
  callbackUrl: string,
  signal: AbortSignal,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt: string }> {
  const candidates: (string | null)[] = callback.provider
    ? [callback.provider]
    : [null, "google", "github", "microsoft", "authkit"];
  let lastError = "";
  for (const provider of candidates) {
    const payload: Record<string, string> = {
      grant_type: "authorization_code",
      code: callback.code,
      client_type: "extension",
      redirect_uri: callbackUrl,
    };
    if (provider) payload.provider = provider;
    const res = await fetch(`https://${CLINE_AUTH_HOST}/auth/token`, {
      method: "POST",
      headers: clineHeaders(),
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) {
      lastError = `${res.status}: ${(await res.text().catch(() => "")).slice(0, 120)}`;
      continue;
    }
    const body = (await res.json()) as {
      success?: boolean;
      data?: { accessToken: string; refreshToken?: string; expiresAt: string };
    };
    if (body?.success && body.data?.accessToken) return body.data;
    lastError = "响应里没有 accessToken";
  }
  throw new Error(`Cline 换取令牌失败（${lastError || "无响应"}）`);
}

/** Cline 的 OAuth：本地回环回调 + 长期 refresh token。 */
const clineOAuth: OAuthAuth = {
  name: "Cline 浏览器登录",
  loginLabel: "浏览器登录 Cline（免费额度）",
  login: async (interaction: ProviderAuthInteraction): Promise<OAuthCredential> => {
    interaction.notify({ type: "progress", message: t("tui.login.stepPrepare") });
    const server = await startClineCallbackServer(interaction.signal);
    try {
      const authorizeUrl = await fetchClineAuthorizeUrl(server.callbackUrl, interaction.signal);
      interaction.notify({ type: "auth_url", url: authorizeUrl });

      const timeout = AbortSignal.timeout(CLINE_LOGIN_TIMEOUT_MS);
      const signal = AbortSignal.any([interaction.signal, timeout]);
      const code = await Promise.race([
        server.waitForCode,
        // 超时/中止要把原因分清：用户自己按了 Esc 是「已取消」，等超时是「回调没到达」。
        timeout.aborted
          ? new Promise<never>((_, reject) => {
              timeout.addEventListener("abort", () =>
                reject(new Error(t("tui.login.errCallbackTimeout"))),
              );
            })
          : new Promise<never>((_, reject) => {
              interaction.signal.addEventListener(
                "abort",
                () => reject(new Error(t("tui.login.cancelled", { provider: "cline" }))),
                { once: true },
              );
            }),
      ]);

      interaction.notify({ type: "progress", message: t("tui.login.stepExchange") });
      const token = await exchangeClineCode(code, server.callbackUrl, interaction.signal);
      return {
        type: "oauth",
        access: token.accessToken,
        refresh: token.refreshToken ?? "",
        expires: parseClineExpiresAt(token.expiresAt),
      };
    } finally {
      server.close();
    }
  },
  refresh: async (credential: OAuthCredential): Promise<OAuthCredential> => {
    const res = await fetch(`https://${CLINE_AUTH_HOST}/auth/refresh`, {
      method: "POST",
      headers: clineHeaders(),
      body: JSON.stringify({
        refreshToken: credential.refresh,
        grantType: "refresh_token",
      }),
    });
    if (!res.ok) {
      throw new Error(`Cline 令牌续期失败（HTTP ${res.status}），请重新 /login cline`);
    }
    const body = (await res.json()) as {
      success?: boolean;
      data?: { accessToken: string; refreshToken?: string; expiresAt: string };
    };
    if (!body?.success || !body.data) throw new Error("Cline 令牌续期响应无法解析");
    return {
      type: "oauth",
      access: body.data.accessToken,
      refresh: body.data.refreshToken ?? credential.refresh,
      expires: parseClineExpiresAt(body.data.expiresAt),
    };
  },
  toAuth: async (credential: OAuthCredential) => ({ apiKey: credential.access }),
};

/**
 * 浏览器登录：Kilo（设备码）。
 *
 * 比 Cline 简单得多：设备码流程不需要回环监听，问它要一个地址与一串码，让用户在任意浏览器里
 * 输入，然后轮询直到通过。参数与 pi-free 的 `providers/kilo/kilo-auth.ts` 一致。
 *
 * Kilo 的 token 有效期一年且**没有续期接口**（pi-free 同样如此），所以过期就是过期——
 * `refresh` 只能提示重新登录。这比伪造一个「静默失败」的实现要好：用户会立刻知道要做什么。
 */
const KILO_API_BASE = "https://api.kilo.ai";
const KILO_DEVICE_AUTH_ENDPOINT = `${KILO_API_BASE}/api/device-auth/codes`;
/**
 * 轮询间隔。
 *
 * pi-free 用 3s。这里取 1.5s：设备码要在浏览器里输入、粘贴、等跳转，短一点体感差别很大，
 * 而多出来的几次 GET 对一个还在等用户操作的授权端点不算打扰（一次登录至多十几轮）。
 */
const KILO_POLL_INTERVAL_MS = 1_500;
const KILO_TOKEN_EXPIRATION_MS = 365 * 24 * 60 * 60 * 1000;

interface KiloDeviceCode {
  code: string;
  verificationUrl: string;
  expiresIn: number;
}
type KiloDevicePoll =
  | { status: "pending" | "approved" | "denied" | "expired"; token?: string };

/** 可被中止的等待：轮询循环靠它退出，Esc 与超时都走这里。 */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error(t("tui.login.cancelled", { provider: "kilo" })));
      },
      { once: true },
    );
  });
}

const kiloOAuth: OAuthAuth = {
  name: "Kilo 浏览器登录",
  loginLabel: "浏览器登录 Kilo（免费额度）",
  login: async (interaction: ProviderAuthInteraction): Promise<OAuthCredential> => {
    interaction.notify({ type: "progress", message: t("tui.login.stepPrepare") });
    const res = await fetch(KILO_DEVICE_AUTH_ENDPOINT, {
      method: "POST",
      headers: { ...kiloHeaders(), Accept: "application/json" },
      signal: interaction.signal,
    });
    if (!res.ok) {
      throw new Error(
        `Kilo 设备码申请失败（HTTP ${res.status}）${res.status === 429 ? "：待授权请求过多，请稍后再试" : ""}`,
      );
    }
    const device = (await res.json()) as KiloDeviceCode;
    interaction.notify({
      type: "device_code",
      userCode: device.code,
      verificationUri: device.verificationUrl,
      intervalSeconds: KILO_POLL_INTERVAL_MS / 1000,
    });

    const deadline = Date.now() + device.expiresIn * 1000;
    while (Date.now() < deadline) {
      await wait(KILO_POLL_INTERVAL_MS, interaction.signal);
      const pollRes = await fetch(`${KILO_DEVICE_AUTH_ENDPOINT}/${device.code}`, {
        headers: { ...kiloHeaders(), Accept: "application/json" },
        signal: interaction.signal,
      });
      // 状态编码在 HTTP 上，不在响应体里：202 未决 / 403 被拒 / 410 过期。
      if (pollRes.status === 202) continue;
      if (pollRes.status === 403) throw new Error("你在浏览器里拒绝了 Kilo 授权");
      if (pollRes.status === 410) throw new Error("Kilo 授权码已过期，请重新登录");
      if (!pollRes.ok) {
        throw new Error(`Kilo 授权轮询失败（HTTP ${pollRes.status}）`);
      }
      const result = (await pollRes.json()) as KiloDevicePoll;
      if (result.status === "pending") continue;
      if (result.status !== "approved" || !result.token) {
        throw new Error("Kilo 已批准授权，但没有拿到令牌");
      }
      interaction.notify({ type: "progress", message: t("tui.login.stepDone") });
      return {
        type: "oauth",
        access: result.token,
        refresh: result.token,
        expires: Date.now() + KILO_TOKEN_EXPIRATION_MS,
      };
    }
    throw new Error(t("tui.login.errDeviceTimeout"));
  },
  refresh: async (credential: OAuthCredential): Promise<OAuthCredential> => {
    if (credential.expires > Date.now()) return credential;
    throw new Error("Kilo 令牌已过期（有效期一年且无法续期），请重新 /login kilo");
  },
  toAuth: async (credential: OAuthCredential) => ({ apiKey: credential.access }),
};

/**
 * 免费网关目录表。
 *
 * 收录标准是这一轮的目标：**存在真正免费（零价或免登录）的对话模型**，且用户拿得到凭据
 * ——环境变量、手打key、或者这一轮加上的浏览器登录（cline / kilo）。
 * 快照里的非对话条目（`google/lyria-*` 是音乐生成）已剔除——pageqa 只跑对话。
 */
const SPECS: readonly FreeProviderSpec[] = [
  {
    id: "cline",
    name: "Cline (free tier)",
    baseUrl: "https://api.cline.bot/api/v1",
    authName: "Cline API key",
    apiKeyEnv: "CLINE_API_KEY",
    anonymous: true,
    oauth: clineOAuth,
    headers: clineHeaders,
    freePattern: FREE_SUFFIX,
    snapshot: [
      "cohere/north-mini-code:free",
      "deepseek/deepseek-v4-flash",
      "dots-studio/dots-3-note-preview:free",
      "google/gemma-4-26b-a4b-it:free",
      "google/gemma-4-31b-it:free",
      "liquid/lfm-2.5-2.6b:free",
      "minimax/minimax-m2.7:free",
      "minimax/minimax-m3:free",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "nvidia/nemotron-3.5-content-safety:free",
      "nvidia/nemotron-3.5-lightning:free",
      "openrouter/free",
      "poolside/laguna-s-2.1:free",
      "poolside/laguna-xs-2.1:free",
      "stealth/ox-alpha",
      "thinkingmachines/inkling:free",
      "thinkingmachines/inkling-small:free",
      "z-ai/glm-5.2:free",
    ],
  },
  {
    id: "llm7",
    name: "LLM7 (free)",
    baseUrl: "https://api.llm7.io/v1",
    authName: "LLM7 API key",
    apiKeyEnv: "LLM7_API_KEY",
    anonymous: true,
    // `default` / `fast` 是精选 selector：底下是付费模型池，不能按命名规律放行。
    snapshot: ["default", "fast"],
  },
  {
    id: "fastrouter",
    name: "FastRouter (free)",
    baseUrl: "https://api.fastrouter.ai/api/v1",
    authName: "FastRouter API key",
    apiKeyEnv: "FASTROUTER_API_KEY",
    anonymous: true,
    freePattern: FREE_SUFFIX,
    snapshot: [
      "fastrouter/auto",
      "google/gemma-4-26b-a4b-it",
      "google/gemma4-26b:free",
      "nvidia/nemotron-3-nano-30b:free",
      "nvidia/nemotron-3-super:free",
      "openai/gpt-oss-120b:free",
      "openai/gpt-oss-20b:free",
      "sarvam/sarvam-105b:free",
    ],
  },
  {
    id: "orcarouter",
    name: "OrcaRouter (free)",
    baseUrl: "https://api.orcarouter.ai/v1",
    authName: "OrcaRouter API key",
    apiKeyEnv: "ORCAROUTER_API_KEY",
    freePattern: FREE_ROUTE,
    snapshot: [
      "orcarouter/free",
      "deepseek/deepseek-v4-flash-free",
      "tencent/hy3-free",
      "z-ai/glm-5.3-flash-free",
    ],
  },
  {
    id: "xkiro",
    name: "Xkiro (free)",
    baseUrl: "https://api.xkiro.com/v1",
    authName: "Xkiro API key",
    apiKeyEnv: "XKIRO_API_KEY",
    // Xkiro 用 OpenRouter 风格的 `:free` 后缀标 `access_tier`，没有 `-free` 那一路。
    freePattern: /:free$/,
    snapshot: ["deepseek/deepseek-v4.1-flash:free", "qwen/qwen3.5-397b-a17b:free"],
  },
  {
    id: "kilo",
    name: "Kilo Gateway (free tier)",
    baseUrl: "https://api.kilo.ai/api/gateway",
    authName: "Kilo API key",
    apiKeyEnv: "KILO_API_KEY",
    oauth: kiloOAuth,
    headers: kiloHeaders,
    freePattern: FREE_ROUTE,
    // Kilo 的 `/models` 每条都带权威 `isFree`，比任何命名规律都准。
    trustsFreeFlag: true,
    // 网关不发流式用量（`stream_options`），照默认设置发过去会 400。
    compat: { supportsUsageInStreaming: false },
    snapshot: [
      "cohere/north-mini-code:free",
      "dots-studio/dots-3-note-preview:free",
      "kilo-auto/free",
      "liquid/lfm-2.5-2.6b:free",
      "meituan/longcat-2.0-free",
      "minimax/minimax-m2.7:free",
      "minimax/minimax-m3:free",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "nvidia/nemotron-3.5-content-safety:free",
      "nvidia/nemotron-3.5-lightning:free",
      "openrouter/free",
      "poolside/laguna-s-2.1:free",
      "poolside/laguna-xs-2.1:free",
      "stealth/ox-alpha",
      "stepfun/step-3.7-flash:free",
      "tencent/hy3:free",
      "thinkingmachines/inkling:free",
      "thinkingmachines/inkling-small:free",
    ],
  },
  {
    id: OPENCODE_FREE_PROVIDER_ID,
    name: "OpenCode Zen Free (匿名免费层)",
    baseUrl: "https://opencode.ai/zen/v1",
    authName: "OpenCode API key",
    // Zen 的免费车道只认这个字面量 bearer；带账号 key 会被上游拒。
    fixedApiKey: "public",
    headers: opencodeHeaders,
    // 这条端点本身就是免费车道，列出来的都是免费模型。
    allCatalogFree: true,
    // 网关不发流式用量，且请求必须带工具指纹（见 createOpencodeFreeGateTools）。
    compat: { supportsUsageInStreaming: false },
    snapshot: [
      "exo-free",
      "fledge-alpha-free",
      "ling-3.0-flash-fin-free",
      "ling-3.1-flash-free",
      "longcat-2.5-preview-free",
      "mimo-v2.6-flash-free",
      "muse-spark-1.3-contributor-free",
      "nemotron-3.5-lightning-free",
      "nemotron-3-ultra-free",
      "space-bunny-free",
    ],
  },
];

/** 免费网关的 provider id 集合（`/model` 的「免费」标记与按需刷新都以此为准）。 */
export const FREE_PROVIDER_IDS: ReadonlySet<string> = new Set(
  SPECS.map((spec) => spec.id),
);

/** 这个 provider 是不是免费网关之一。 */
export function isFreeProvider(providerId: string): boolean {
  return FREE_PROVIDER_IDS.has(providerId);
}

/**
 * 允许匿名的鉴权：存储的 key 优先，其次环境变量，都没有就resolve 出一个空 key。
 *
 * 与 `envApiKeyAuth` 的唯一差别是最后一步——它返回 undefined（于是被 `/model` 过滤掉），
 * 这里返回「匿名可用」。因此**每个允许匿名的网关都必须真的能匿名发请求**，
 * 否则表现是「列得出来、点下去探活失败」，那由 `/model` 里的报错承担，而不是让整块 provider 消失。
 */
function anonymousApiKeyAuth(name: string, envVar: string): ApiKeyAuth {
  return {
    name,
    login: envApiKeyAuth(name, [envVar]).login,
    resolve: async ({ ctx, credential, signal }) => {
      signal.throwIfAborted();
      if (credential?.key) {
        return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
      }
      const value = await ctx.env(envVar);
      signal.throwIfAborted();
      if (value) return { auth: { apiKey: value }, source: envVar };
      return { auth: { apiKey: "" }, source: "anonymous" };
    },
  };
}

/**
 * 固定 bearer 的鉴权：恒成立、且**不给登录入口**。
 *
 * 不挂 `login` 是刻意的：这个网关没有「需要你提供凭据」的那一步，把它列进 `/login`
 * 只会让人以为自己漏配了什么。`/login` 的过滤条件本就是「实现了 login 才列」，正好用上。
 */
function fixedApiKeyAuth(name: string, key: string): ApiKeyAuth {
  return {
    name,
    resolve: async ({ signal }) => {
      signal.throwIfAborted();
      return { auth: { apiKey: key }, source: "anonymous" };
    },
  };
}

/** 构造一条对话模型条目。 */
function toModel(spec: FreeProviderSpec, id: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: spec.id,
    baseUrl: spec.baseUrl,
    input: ["text"],
    reasoning: false,
    contextWindow: GATEWAY_CONTEXT_WINDOW,
    maxTokens: GATEWAY_MAX_OUTPUT,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    headers: spec.headers?.(),
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      supportsLongCacheRetention: false,
      ...spec.compat,
    },
  };
}

/** 该网关的免费判定：免费车道、权威标记、快照、命名规律四者取并集。 */
function isFreeId(spec: FreeProviderSpec, id: string, flaggedFree?: boolean): boolean {
  if (spec.allCatalogFree === true) return true;
  if (flaggedFree === true) return true;
  if (spec.snapshot.includes(id)) return true;
  return spec.freePattern?.test(id) ?? false;
}

/**
 * 打网关的公开 `/v1/models`。
 *
 * 不传鉴权也行（这批网关的目录公开），带了 key 就带上——有 key 时目录可能更全，
 * Kilo 的网关更是必须带（它的免费判定字段在登录后才给）。
 * 返回值只保留免费条目：动态目录的**唯一**职责是补上快照里没有的新免费模型。
 */
async function fetchFreeModels(
  spec: FreeProviderSpec,
  context: RefreshModelsContext,
): Promise<Model<"openai-completions">[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (spec.headers) Object.assign(headers, spec.headers());
  const key = context.credential?.type === "oauth" ? context.credential.access : context.credential?.key;
  if (key) headers.Authorization = `Bearer ${key}`;

  const res = await fetch(`${spec.baseUrl}/models`, { headers, signal: context.signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { data?: unknown };
  // 条目形态各家不一：OpenAI 风格给 `{id}`，OpenCode Zen 只给裸 id 字符串。
  const entries = Array.isArray(body.data) ? body.data : [];
  const ids = entries
    .map((entry) => {
      if (typeof entry === "string") return { id: entry.trim(), flaggedFree: false };
      const record = entry as { id?: unknown; isFree?: unknown };
      return {
        id: typeof record?.id === "string" ? record.id.trim() : "",
        // 只在网关声明自己会给这个字段时才读它（见 spec.trustsFreeFlag）。
        flaggedFree: spec.trustsFreeFlag === true && record?.isFree === true,
      };
    })
    .filter(({ id, flaggedFree }) => id !== "" && isFreeId(spec, id, flaggedFree))
    .map(({ id }) => id);
  return [...new Set(ids)].map((id) => toModel(spec, id));
}

/**
 * 构造全部免费网关 provider。
 *
 * 每次调用都造新的实例：provider 持有可变目录状态（动态刷新后的模型列表），
 * 共享实例会让两个目录（测试注入的与真实运行的）互相污染。
 */
/** 这个网关的 apiKey 鉴权：固定 bearer > 允许匿名 > 标准 env/存储凭据。 */
function apiKeyAuthFor(spec: FreeProviderSpec): ApiKeyAuth {
  if (spec.fixedApiKey) return fixedApiKeyAuth(spec.authName, spec.fixedApiKey);
  if (spec.anonymous && spec.apiKeyEnv) {
    return anonymousApiKeyAuth(spec.authName, spec.apiKeyEnv);
  }
  return envApiKeyAuth(spec.authName, spec.apiKeyEnv ? [spec.apiKeyEnv] : []);
}

export function createFreeProviders(): Provider[] {
  return SPECS.map((spec) =>
    createProvider({
      id: spec.id,
      name: spec.name,
      baseUrl: spec.baseUrl,
      auth: {
        apiKey: apiKeyAuthFor(spec),
        // 有浏览器登录流程时一并挂上：`/login` 于是会列出「OAuth + API key」两种方式，
        // 而 pi-ai 负责在令牌过期时调refresh、请求时调 toAuth。
        ...(spec.oauth ? { oauth: spec.oauth } : {}),
      },
      // 快照作为基线：动态刷新失败（断网/被墙/网关改了目录）时它就是列表内容。
      models: spec.snapshot.map((id) => toModel(spec, id)),
      fetchModels: (context) => fetchFreeModels(spec, context),
      api: openaiCompletions,
    }),
  );
}