/**
 * bsk daemon 的常驻 IPC 通道：把「每条命令起一个 bsk 进程」降成「一次往返」。
 *
 * 为什么值得做（实测，2026-09-28，本机）：
 * - `bsk --version`（纯进程启动）≈ 11–21ms，`bsk status --json` ≈ 15–40ms；
 * - 同一个 daemon 的 IPC 往返（本模块）≈ 0–1ms。
 * 也就是说每条命令约 13–20ms 花在「起进程 + 连管道 + daemon 探测」上，而不是花在浏览器上。
 * 一条几十步的回放里每步要发 1 次快照 + 1 次动作，这部分就是秒级的纯开销。
 *
 * 协议（来自 BrowserSkill 源码，crates/bsk-cli/src/daemon/ipc.rs、crates/bsk-protocol/src/frame.rs）：
 * - 传输：Unix 上是 UDS（`$BSK_HOME/run/daemon.sock`），Windows 上是每用户命名管道
 *   （`\\.\pipe\bsk-daemon-<hash>`，名字由用户名 + BSK_HOME 哈希而来，无法在 JS 侧重算）；
 * - 端点发现：一律读 `$BSK_HOME/daemon.json` 的 `sock_path`（CLI 自己也是这么找的）；
 * - 帧：一行一个 UTF-8 JSON，`{"id","method","params"}` 请求 →
 *   `{"id","result"}` 或 `{"id","error":{code,message,data}}` 响应；
 * - **一条连接上严格串行**：daemon 读完一行、等 handler 结束、再写回，然后才读下一行
 *   （ipc.rs 的 handle_connection）。所以「按 session 一条连接」正好对应 bsk 自己的
 *   「一个 session 一次只跑一条命令」；要并行就得开多条连接（daemon 对每条连接各起一个
 *   task，命名管道也是多实例）。
 *
 * 刻意**不**用 execFile 的 CLI 去拿这些能力：bsk 没有批量命令（`bsk --help` 里没有），
 * 唯一的长连接入口就是这条 IPC。
 *
 * 边界与风险：这是 bsk 的内部协议，不是对外承诺的契约。因此本模块只负责传输，
 * 任何「认不出来」的情况都抛 `BskIpcTransportError`，由调用方退回 CLI（见 tools.ts 的
 * runBskCommand）：协议漂移的后果是「变慢」，不是「变错」。
 */

import { readFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { debugLog } from "../shared/log.js";

/** `$BSK_HOME`（默认 `~/.bsk`）——daemon.json 与 UDS 都在这下面。 */
export function bskHome(): string {
  const fromEnv = process.env.BSK_HOME?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".bsk");
}

/** daemon.json 里我们用得到的字段（pid/sock_path/version；其余忽略）。 */
export interface BskDaemonEndpoint {
  sockPath: string;
  pid: number;
  version: string;
}

interface RawDaemonInfo {
  pid?: unknown;
  sock_path?: unknown;
  version?: unknown;
}

/**
 * 读 daemon.json 得到 IPC 端点；读不到/形状不对返回 null（调用方退回 CLI）。
 *
 * 用 `pid` 判活是抄 CLI 的 `probe_async`：升级或崩溃会留下一个指向死 daemon 的
 * daemon.json，直接去连只会拿到一个含义模糊的连接错误——那种情况下该让 CLI 去
 * 走它自己的「daemon 没起就拉起」路径。
 */
export function readDaemonEndpoint(home: string = bskHome()): BskDaemonEndpoint | null {
  let raw: RawDaemonInfo;
  try {
    raw = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as RawDaemonInfo;
  } catch {
    return null;
  }
  const sockPath = typeof raw?.sock_path === "string" ? raw.sock_path : "";
  if (!sockPath) return null;
  const pid = typeof raw?.pid === "number" && Number.isFinite(raw.pid) ? raw.pid : 0;
  if (pid <= 0 || !processAlive(pid)) return null;
  return {
    sockPath,
    pid,
    version: typeof raw?.version === "string" ? raw.version : "",
  };
}

/** 进程是否还活着（`kill(pid, 0)` 不发信号，只做存在性检查）。 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但不属于我们（Windows 上也可能出现）；只有 ESRCH 才算死了。
    return (err as { code?: string }).code === "EPERM";
  }
}

/**
 * 传输层问题（连不上、超时、收到认不出的帧、协议漂移）——调用方据此决定是否退回 CLI。
 *
 * `sent` 是这里最要紧的一个字段：请求**是否已经写进管道**。
 * - `false`：这条命令根本没送达（连不上、握手失败），退回 CLI 重发是安全的；
 * - `true`：命令可能已经在 daemon/浏览器侧执行，改动型命令**绝不能**重发
 *   （重发就是点两次、填两次）。调用方据此改用「如实报失败」的处置。
 */
export class BskIpcTransportError extends Error {
  constructor(message: string, readonly cause?: unknown, readonly sent = false) {
    super(message);
    this.name = "BskIpcTransportError";
  }
}

/** 调用方中途中止（交互模式按 Esc）。与 CLI 路径的 BskAbortError 同义，由 tools.ts 翻译。 */
export class BskIpcAbortError extends Error {
  constructor(readonly cmd: string) {
    super(`命令被中止：${cmd}`);
    this.name = "BskIpcAbortError";
  }
}

/** daemon 回的结构化错误（**真实结果**，不是传输问题；不能靠回退 CLI 来"重试"）。 */
export class BskIpcRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: unknown,
    /** 发起这条 RPC 时用的 correlation id（排障用）。 */
    readonly rpcId?: string,
  ) {
    super(message);
    this.name = "BskIpcRpcError";
  }
}

interface PendingCall {
  id: string;
  cmd: string;
  /** 请求是否已经写进管道（决定这条命令能否安全地退回 CLI 重发）。 */
  sent: boolean;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * 把「这条请求已经写进管道」的事实记到错误上（连接级错误本身不知道自己是被哪条调用触发的）。
 * 已经是 `sent: true` 的直接复用，避免无谓地再造一个错误对象。
 */
function markSent(err: BskIpcTransportError, sent: boolean): BskIpcTransportError {
  if (!sent || err.sent) return err;
  return new BskIpcTransportError(err.message, err.cause, true);
}

/** 生成 correlation id（bsk 用 12 位十六进制；形状不重要，唯一即可）。 */
function randomId(): string {
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0");
  }
  return out;
}

/**
 * 一条到 daemon 的连接。**一条连接对应一个 session**（见文件头：daemon 侧单连接严格串行）。
 */
class Connection {
  private buffer = "";
  private readonly pending = new Map<string, PendingCall>();
  private dead: BskIpcTransportError | null = null;

  private constructor(
    private readonly socket: net.Socket,
    readonly sockPath: string,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (err: Error) => this.fail(new BskIpcTransportError(`IPC 连接错误：${err.message}`, err)));
    socket.on("close", () => this.fail(new BskIpcTransportError("IPC 连接已关闭")));
  }

  /**
   * 连接并做一次 `system.ping` 握手。
   *
   * 握手不是礼貌，是校验：管道路径来自文件，指向的可能根本不是 bsk daemon
   * （旧版本、被别的程序占用的名字）。先确认「对面讲这个协议」，再接业务命令。
   */
  static async open(sockPath: string, timeoutMs: number): Promise<Connection> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect({ path: sockPath });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new BskIpcTransportError(`连接 bsk daemon 超时（${sockPath}）`));
      }, timeoutMs);
      s.once("connect", () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", (err: Error) => {
        clearTimeout(timer);
        reject(new BskIpcTransportError(`连接 bsk daemon 失败（${sockPath}）：${err.message}`, err));
      });
    });
    // 常驻连接不该把宿主进程钉在事件循环上：进程该退就退。
    socket.unref();
    const conn = new Connection(socket, sockPath);
    let pong: { pong?: unknown };
    try {
      pong = (await conn.call("system.ping", {}, timeoutMs)) as { pong?: unknown };
    } catch (err) {
      conn.close();
      // 握手失败时**业务命令一条都还没发**：把 sent 归零，让调用方可以安全地退回 CLI。
      throw new BskIpcTransportError(
        `bsk daemon 握手失败：${err instanceof Error ? err.message : String(err)}`,
        err,
        false,
      );
    }
    if (pong?.pong !== true) {
      conn.close();
      throw new BskIpcTransportError("对面不是 bsk daemon：system.ping 未返回 pong");
    }
    return conn;
  }

  get alive(): boolean {
    return this.dead === null && !this.socket.destroyed;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) return;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let frame: { id?: unknown; result?: unknown; error?: unknown };
      try {
        frame = JSON.parse(line) as typeof frame;
      } catch {
        // 认不出的行 = 协议漂移：整条连接不可信，作废并让调用方退回 CLI。
        this.fail(new BskIpcTransportError("IPC 收到无法解析的帧（协议不匹配？）"));
        return;
      }
      const id = typeof frame.id === "string" ? frame.id : "";
      const pending = this.pending.get(id);
      if (!pending) continue; // 已被中止/超时丢弃的响应：丢掉即可
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (frame.error !== undefined && frame.error !== null) {
        const err = frame.error as { code?: unknown; message?: unknown; data?: unknown };
        pending.reject(
          new BskIpcRpcError(
            typeof err.code === "string" ? err.code : "protocol_error",
            typeof err.message === "string" ? err.message : JSON.stringify(err),
            err.data,
            id,
          ),
        );
        continue;
      }
      pending.resolve(frame.result);
    }
  }

  /** 整条连接作废：拒绝所有在途调用（daemon 侧严格串行，一条卡住则后面的都排队）。 */
  private fail(err: BskIpcTransportError): void {
    if (this.dead) return;
    this.dead = err;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(markSent(err, pending.sent));
    }
    this.pending.clear();
    if (!this.socket.destroyed) this.socket.destroy();
  }

  close(): void {
    this.fail(new BskIpcTransportError("IPC 连接已关闭"));
  }

  /**
   * 发一条 RPC。
   * - daemon 结构化错误 → 抛 `BskIpcRpcError`（**真实结果**：这一条不能靠回退 CLI 重来）；
   * - 传输问题/超时 → 抛 `BskIpcTransportError`（调用方退回 CLI）；
   * - 中止 → 先在**另一条连接**上发 `cancel {rpc_id}`，再抛 `BskIpcAbortError`。
   *
   * 为什么取消要另开连接：daemon 对同一连接是严格串行的，本连接上的 cancel 要等
   * 当前 handler 结束才会被读到——那正好是它想打断的那个 handler。bsk 自己的 CLI
   * 也是这么做的（SIGINT 时另开一条连接发 cancel）。
   */
  async call(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.dead) throw this.dead;
    if (signal?.aborted) throw new BskIpcAbortError(method);
    const id = randomId();
    const cmd = `${method} ${JSON.stringify(params)}`;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 超时后连接不可复用：那条命令可能仍在 daemon/浏览器侧跑着，
        // 后续命令排在同一条串行连接后面只会一起卡住。
        // 超时必然发生在 write 之后，因此 sent 为真：改动型命令不该被上层重发。
        this.fail(new BskIpcTransportError(`IPC 调用超时：${method}`, undefined, true));
      }, timeoutMs);
      this.pending.set(id, { id, cmd, sent: false, resolve, reject, timer });
    });

    const onAbort = (): void => {
      this.sendCancel(id);
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new BskIpcAbortError(cmd));
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      this.socket.write(JSON.stringify({ id, method, params }) + "\n");
      const entry = this.pending.get(id);
      if (entry) entry.sent = true;
      return await result;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
      }
    }
  }

  /** 另开一条连接把 `cancel {rpc_id}` 送进 daemon（尽力而为，失败只记 debug）。 */
  private sendCancel(rpcId: string): void {
    const sock = net.connect({ path: this.sockPath });
    sock.on("error", (err: Error) => {
      debugLog(`[bsk-ipc] 发送 cancel 失败：${err.message}`);
    });
    sock.on("connect", () => {
      sock.write(
        JSON.stringify({ id: randomId(), method: "cancel", params: { rpc_id: rpcId } }) + "\n",
      );
      // 不等响应：daemon 收到就会去 trip 取消令牌，我们这边已经不再等结果了。
      setTimeout(() => sock.destroy(), 1_000).unref();
    });
    sock.unref();
  }
}

/** 池化后的端点 + 各 session 的连接。任何传输失败都整体作废，下次重新发现/重连。 */
interface Pool {
  endpoint: BskDaemonEndpoint;
  conns: Map<string, Promise<Connection>>;
}

let pool: Pool | null = null;

/** 让下一次 `ipcCall` 重新读 daemon.json 并建连（daemon 重启、端口/管道变化时用）。 */
export function resetIpcPool(): void {
  if (!pool) return;
  for (const conn of pool.conns.values()) {
    void conn.then((c) => c.close()).catch(() => undefined);
  }
  pool = null;
}

/** 复用同一个池的唯一条件：daemon.json 还是同一份（同 pid 同端点）。 */
function currentPool(endpoint: BskDaemonEndpoint): Pool {
  if (pool && pool.endpoint.pid === endpoint.pid && pool.endpoint.sockPath === endpoint.sockPath) {
    return pool;
  }
  resetIpcPool();
  pool = { endpoint, conns: new Map() };
  return pool;
}

function connectionFor(p: Pool, key: string, connectTimeoutMs: number): Promise<Connection> {
  const existing = p.conns.get(key);
  if (existing) return existing;
  const created = Connection.open(p.endpoint.sockPath, connectTimeoutMs).catch((err: unknown) => {
    // 建连失败不能留在池子里，否则后面每条命令都拿到同一个失败的 promise。
    p.conns.delete(key);
    throw err;
  });
  p.conns.set(key, created);
  return created;
}

/**
 * 走 IPC 发一条命令。返回 daemon 的 `result`；`result` 为 null 表示这条命令没有返回值。
 *
 * `sessionKey` 决定复用哪条连接：同一个 session 必须共用一条（daemon 侧单连接串行，
 * 正好等于「一个 session 一次一条命令」）；无 session 的命令（`tool.wait_ms`）用固定键。
 */
export async function ipcCall(
  sessionKey: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const endpoint = readDaemonEndpoint();
  if (!endpoint) throw new BskIpcTransportError("读不到 bsk daemon 端点（daemon.json）");
  const p = currentPool(endpoint);
  const conn = await connectionFor(p, sessionKey, Math.min(timeoutMs, 10_000));
  if (!conn.alive) {
    p.conns.delete(sessionKey);
    throw new BskIpcTransportError("IPC 连接已失效");
  }
  try {
    return await conn.call(method, params, timeoutMs, signal);
  } catch (err) {
    if (err instanceof BskIpcRpcError || err instanceof BskIpcAbortError) throw err;
    // 传输层面的问题一律作废整个池：下次调用会重新发现端点、重新建连。
    p.conns.delete(sessionKey);
    resetIpcPool();
    throw err;
  }
}
