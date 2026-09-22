/**
 * 模型目录：把「自定义端点 + pi-ai 内置 provider」装进同一个 `Models` 集合，
 * 供交互模式切换模型（/model）与登录 provider（/login）使用。
 *
 * 设计要点：
 * - **内置 provider 延迟加载**：`@earendil-works/pi-ai/providers/all` 会把 40 多个
 *   provider（连带各自的模型目录）拉进来，批处理跑自定义端点时完全用不上。
 *   因此只有「当前选择的 provider 不是 pageqa」或用户打开 /model、/login 时才 import。
 * - **可用性以「是否配好鉴权」为准**：与 pi-coding-agent 一致——没配鉴权的 provider
 *   不列进 /model（列出来也没法用，反而让人以为坏了）。
 * - 本模块不持有「当前模型」状态：那是会话级状态，由 TUI / agent 调用方持有并传入。
 */
import {
  createModels,
  defaultProviderAuthContext,
  type Api,
  type AuthType,
  type CredentialStore,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { loadConfig, PAGEQA_PROVIDER_ID, type PageQaConfig } from "./config.js";
import { FileCredentialStore } from "./auth.js";
import { createPageqaProvider } from "./llm.js";

export { PAGEQA_PROVIDER_ID };

/** 一次模型选择：provider id + 该 provider 内的模型 id。 */
export interface ModelChoice {
  provider: string;
  model: string;
}

/** 模型目录：一个共享的 `Models` 集合 + 凭据存储 + 配置里保存的默认选择。 */
export interface ModelCatalog {
  models: MutableModels;
  /**
   * 凭据存储。pi-ai 没有公开「从 Models 反查 credentials」的口子，而 /logout
   * 需要 `list()`，因此这里自留一份引用。
   */
  credentials: CredentialStore;
  /** 配置文件里保存的默认选择（批处理模式与交互模式的初始值）。 */
  defaultChoice: ModelChoice;
  /** 内置 provider 是否已注册（/model、/login 需要）。 */
  builtinsLoaded: boolean;
}

export interface CreateCatalogOptions {
  /** 是否立刻注册内置 provider（默认只注册自定义端点，保持批处理启动开销不变）。 */
  loadBuiltins?: boolean;
  /** 凭据存储（测试注入用；默认落 ~/.pageqa/auth.json）。 */
  credentials?: CredentialStore;
}

/** 构造模型目录。 */
export async function createModelCatalog(
  opts: CreateCatalogOptions = {},
): Promise<ModelCatalog> {
  const cfg: PageQaConfig = loadConfig();
  const credentials = opts.credentials ?? new FileCredentialStore();
  const models = createModels({
    credentials,
    // 默认 auth context：从 process.env 读 API Key、探测 ~/.aws 等环境凭据。
    authContext: defaultProviderAuthContext(),
  });
  // 自定义端点永远先注册：内置 provider 里没有同名 id，不存在被覆盖的问题。
  models.setProvider(createPageqaProvider(cfg));

  const catalog: ModelCatalog = {
    models,
    credentials,
    builtinsLoaded: false,
    defaultChoice: { provider: cfg.modelProvider, model: cfg.model },
  };
  if (opts.loadBuiltins) await loadBuiltinProviders(catalog);
  return catalog;
}

/**
 * 注册全部内置 provider（幂等）。
 *
 * 用动态 import：只有真正需要时才付出这份加载开销。
 */
export async function loadBuiltinProviders(
  catalog: ModelCatalog,
): Promise<void> {
  if (catalog.builtinsLoaded) return;
  const { builtinProviders } = await import(
    "@earendil-works/pi-ai/providers/all"
  );
  for (const provider of builtinProviders()) {
    // 自定义端点优先：同名 id（理论上不存在）时不覆盖用户自己的端点。
    if (provider.id === PAGEQA_PROVIDER_ID) continue;
    catalog.models.setProvider(provider);
  }
  catalog.builtinsLoaded = true;
}

/** 按选择取到具体模型；未注册返回 undefined（调用方据此给出可读报错）。 */
export function resolveModel(
  catalog: ModelCatalog,
  choice: ModelChoice,
): Model<Api> | undefined {
  return catalog.models.getModel(choice.provider, choice.model);
}

/** 模型目录里是否已经有这个 provider。 */
export function hasProvider(catalog: ModelCatalog, providerId: string): boolean {
  return catalog.models.getProvider(providerId) !== undefined;
}

/** /model 选择器的一项：扁平化后的「provider + 模型」。 */
export interface ModelOption {
  provider: string;
  providerName: string;
  model: string;
  name: string;
  contextWindow: number;
}

/**
 * 列出当前**可用**（provider 已配好鉴权）的全部模型。
 *
 * 自定义端点的鉴权是静态配置、恒成立，因此它的模型总是列出——否则用户第一次
 * 打开 /model 会得到一个空列表，看起来像功能坏了。
 */
export async function listModelOptions(
  catalog: ModelCatalog,
  opts: { signal?: AbortSignal } = {},
): Promise<ModelOption[]> {
  const out: ModelOption[] = [];
  for (const provider of catalog.models.getProviders()) {
    opts.signal?.throwIfAborted();
    if (provider.id !== PAGEQA_PROVIDER_ID) {
      const configured = await checkConfigured(catalog, provider.id, opts.signal);
      if (!configured) continue;
    }
    for (const model of provider.getModels()) {
      out.push({
        provider: provider.id,
        providerName: provider.name,
        model: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
      });
    }
  }
  return out.sort(
    (a, b) =>
      a.providerName.localeCompare(b.providerName) ||
      a.model.localeCompare(b.model),
  );
}

/** 包一层 try/catch：某个 provider 的鉴权探测出错不该让整个列表失败。 */
async function checkConfigured(
  catalog: ModelCatalog,
  providerId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const check = await catalog.models.checkAuth(providerId, { signal });
    return check !== undefined;
  } catch {
    return false;
  }
}

/** /login 选择器的一项：provider 的一种登录方式。 */
export interface LoginOption {
  provider: string;
  providerName: string;
  /** `api_key` 或 `oauth`。 */
  type: AuthType;
  /** OAuth 的订阅文案（provider 自有，如 "Anthropic (Claude Pro/Max)"）；API Key 为空。 */
  label?: string;
  /** 该 provider 当前是否已配置鉴权（已登录的再点一次表示覆盖）。 */
  configured: boolean;
}

/**
 * 列出可登录的 provider × 登录方式。
 *
 * 只有实现了 `login()` 的方式才算「可登录」：只支持环境变量/云凭据的 provider
 * （如 Amazon Bedrock）没有交互式登录流程，列出来只会让人点进去看到一句
 * 「请在外部配置」——与 pi-coding-agent 一样把它们排除在候选之外。
 */
export async function listLoginOptions(
  catalog: ModelCatalog,
  opts: { signal?: AbortSignal } = {},
): Promise<LoginOption[]> {
  const out: LoginOption[] = [];
  for (const provider of catalog.models.getProviders()) {
    opts.signal?.throwIfAborted();
    const configured = await checkConfigured(
      catalog,
      provider.id,
      opts.signal,
    );
    const { apiKey, oauth } = provider.auth;
    if (oauth?.login) {
      out.push({
        provider: provider.id,
        providerName: provider.name,
        type: "oauth",
        label: oauth.loginLabel ?? oauth.name,
        configured,
      });
    }
    if (apiKey?.login) {
      out.push({
        provider: provider.id,
        providerName: provider.name,
        type: "api_key",
        configured,
      });
    }
  }
  return out.sort(
    (a, b) =>
      a.providerName.localeCompare(b.providerName) ||
      a.type.localeCompare(b.type),
  );
}

/** /logout 选择器的一项：已存储凭据的 provider。 */
export interface LogoutOption {
  provider: string;
  providerName: string;
  type: AuthType;
}

/**
 * 列出已存储凭据的 provider（只有它才能被 /logout 移除）。
 *
 * 环境变量与 models.json 提供的鉴权不在此列——它们不是 pageqa 写下的，
 * 移除它们既越权也做不到。
 */
export async function listLogoutOptions(
  catalog: ModelCatalog,
  opts: { signal?: AbortSignal } = {},
): Promise<LogoutOption[]> {
  const entries = await catalog.credentials.list({ signal: opts.signal });
  return entries
    .map(({ providerId, type }) => ({
      provider: providerId,
      providerName: catalog.models.getProvider(providerId)?.name ?? providerId,
      type,
    }))
    .sort((a, b) => a.providerName.localeCompare(b.providerName));
}
