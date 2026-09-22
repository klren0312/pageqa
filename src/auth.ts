/**
 * 凭据存储：把 /login 得到的 API Key / OAuth token 落到 `~/.pageqa/auth.json`。
 *
 * 对标 pi-coding-agent 的 `~/.pi/agent/auth.json`：文件是「provider id → 一条凭据」
 * 的映射，凭据按 `type` 区分 `api_key` 与 `oauth`（见 pi-ai 的 `Credential`）。
 * 之所以自持一份而不是复用 pi-coding-agent 的实现：那份依赖 `proper-lockfile`
 * 做跨进程文件锁，pageqa 不需要把这份依赖带进来——单进程内的写已足够（交互模式下
 * 同一时刻只有一个登录流程，批处理只读）。
 *
 * 实现约定（与 pi-ai 的 `CredentialStore` 契约一致）：
 * - `modify` 是**唯一**写入口：`Models.getAuth()` 会在它内部做 OAuth 刷新，
 *   因此所有写操作必须串行化，否则并发刷新可能把已轮换的 token 写回去；
 * - 文件里的 api_key 允许写成 `!command` / `$ENV` 形式（pi 的约定），
 *   这类值只在解析时展开，存储层原样保留，不做任何解释。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR, ensureConfigDir } from "./config.js";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

/** 凭据文件路径（与 config.json 同目录）。 */
export const AUTH_PATH = join(CONFIG_DIR, "auth.json");

/** 文件权限只给当前用户：凭据等同于密钥。Windows 上 mode 不生效，仅在 POSIX 有意义。 */
const AUTH_FILE_MODE = 0o600;

type AuthFileData = Record<string, Credential>;

/**
 * 基于 JSON 文件的凭据存储。
 *
 * 构造函数允许传入自定义路径，供测试注入临时目录（生产走默认的 ~/.pageqa/auth.json）。
 */
export class FileCredentialStore implements CredentialStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string = AUTH_PATH) {}

  /** 读整个文件；不存在/损坏一律当作空（绝不因为一个坏文件把登录/运行路径拖崩）。 */
  private load(): AuthFileData {
    if (!existsSync(this.path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      return parsed as AuthFileData;
    } catch {
      return {};
    }
  }

  /**
   * 原子写：先写临时文件再 rename 覆盖。
   *
   * 直接写目标文件的话，写到一半被中断会留下半截 JSON——而 auth.json 一旦解析
   * 失败就会被当成「没有任何凭据」，用户会莫名其妙地被要求重新登录。
   */
  private save(data: AuthFileData): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), {
        encoding: "utf8",
        mode: AUTH_FILE_MODE,
      });
      renameSync(tmp, this.path);
    } catch (err) {
      // 临时文件残留不影响读取，但会污染目录，失败时尽量清掉。
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // 清理失败无所谓，别掩盖真正的写入错误。
      }
      throw err;
    }
  }

  /**
   * 串行化所有操作。
   *
   * 读也一起排队：`modify` 的语义是「读-改-写」，若读绕过队列，可能读到
   * 某个 modify 写到一半的数据。代价是读也多了一次微任务等待，可忽略。
   */
  private enqueue<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async read(
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const credential = await this.enqueue(() => this.load()[providerId]);
    options?.signal?.throwIfAborted();
    // 交出去的是副本：调用方（含 pi-ai 的 token 刷新）不该改到我们缓存的对象。
    return credential ? structuredClone(credential) : undefined;
  }

  async list(
    options?: AuthOperationOptions,
  ): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const entries = await this.enqueue(() =>
      Object.entries(this.load()).map(
        ([providerId, credential]): CredentialInfo => ({
          providerId,
          type: credential.type,
        }),
      ),
    );
    options?.signal?.throwIfAborted();
    return entries;
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return this.enqueue(async () => {
      options?.signal?.throwIfAborted();
      const data = this.load();
      const next = await fn(data[providerId]);
      options?.signal?.throwIfAborted();
      // 返回 undefined 表示「不改动」（pi-ai 用这个表达式保持原值）。
      if (next === undefined) return data[providerId];
      this.save({ ...data, [providerId]: next });
      return next;
    });
  }

  async delete(
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    await this.enqueue(() => {
      const data = this.load();
      if (!(providerId in data)) return;
      delete data[providerId];
      this.save(data);
    });
  }
}

/** 确保凭据目录存在（登录前调用，让权限设置先于文件落盘）。 */
export function ensureAuthDir(): string {
  return ensureConfigDir();
}

/** 平台无关地展示凭据文件位置（帮助/文档用）。 */
export function describeAuthLocation(): string {
  return AUTH_PATH;
}
