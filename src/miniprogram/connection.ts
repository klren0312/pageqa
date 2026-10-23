import { spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { debugLog, info } from "../shared/log.js";
import type { MiniProgramConfig } from "./types.js";

let miniProgram: any = null;
let consoleErrors: string[] = [];
/**
 * 本进程是否**自己开**的这条连接（= 不是复用来的）。
 *
 * 只用于日志：复用来的通道是共享资源（父进程与所有场景子进程连的是同一条），
 * 谁都不能擅自关掉——断了那条通道就会变成"只监听、不再接受新连接"的僵尸，
 * 下一次连接得重新开一遍。
 */
let ownsConnection = false;

const PACKAGE = "miniprogram-automator";

/** 预热（等页面 meta 可取）的最长等待时间。 */
const WARMUP_TIMEOUT_MS = 20_000;
/** 预热轮询间隔。 */
const WARMUP_INTERVAL_MS = 500;

async function loadAutomator(): Promise<any> {
  try {
    const mod: any = await import(PACKAGE);
    return mod && mod.default !== undefined ? mod.default : mod;
  } catch (err) {
    throw new Error(
      `未找到 ${PACKAGE}：请在项目中安装它（npm i -D ${PACKAGE}）后再运行小程序驱动。` +
        `底层错误：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** 返回累计捕获的小程序运行期报错（assert_no_console_error 用）。 */
export function getConsoleErrors(): string[] {
  return consoleErrors;
}

/** 清空报错缓冲（一次断言后调用，避免重复计数）。 */
export function resetConsoleErrors(): void {
  consoleErrors = [];
}

/**
 * 已建立连接的 ws 端点：写进环境变量后，子进程（套件 / TUI 的场景进程）会
 * 继承它，于是所有场景共用同一个开发者工具实例与同一条自动化通道。
 */
const WS_ENV = "PAGEQA_MINIPROGRAM_WS_ENDPOINT";
/** 自动化端口候选：开发者工具默认 9420，往后逐个试。 */
const CANDIDATE_PORTS = [9420, 9421, 9422, 9423, 9424, 9425];
/** 探测单个端点的 connect 超时（automator 的 ws 连接没有内置超时）。 */
const CONNECT_PROBE_TIMEOUT_MS = 1500;
/** 让开发者工具重开通道后，等 ws 就绪的上限。 */
const CHANNEL_READY_TIMEOUT_MS = 30_000;
/** 等 ws 就绪时的轮询间隔。 */
const CHANNEL_POLL_INTERVAL_MS = 500;

/** connect 带超时：探不到的端口会让 ws 客户端一直挂着（既不 open 也不 error）。 */
async function connectWithTimeout(
  a: any,
  wsEndpoint: string,
  timeoutMs: number,
): Promise<any> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      a.connect({ wsEndpoint }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`connect ${wsEndpoint} 超时`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** TCP 探测：端口上有没有东西在听（可能是上一轮留下的僵尸通道）。 */
function isPortListening(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (v: boolean) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** 跑一条 cli 命令并等它结束（失败不致命：达不到目的也只是白试一次）。 */
function runCli(
  cliPath: string,
  args: string[],
  timeoutMs = 20_000,
): Promise<void> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cliPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
        windowsHide: true,
      });
      const onData = (d: Buffer) =>
        debugLog(`[miniprogram] cli: ${String(d).trim().slice(0, 200)}`);
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 已经退出就算了 */
        }
        resolve();
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      child.on("exit", done);
      child.on("error", done);
    } catch {
      resolve();
    }
  });
}

/**
 * 让开发者工具为该项目开一条自动化通道（**端口由我们指定**）。
 *
 * 不用 `automator.launch`：它会自选一个*空闲*端口去 `cli auto --auto-port`，
 * 而开发者工具对同一项目只保留一条通道——两者对不上时 IDE 不会在新端口开通道，
 * 于是 launch 一直等到超时（而且它把 cli 的输出吞了，现场零线索）。
 *
 * 端口要**优先选「IDE 之前用过、现在还开着」的那个**：客户端断开之后那条通道会
 * 留在监听、却不再接受新连接（僵尸通道）；对同一个端口重跑一次 `cli auto`，IDE 会
 * 重新接管它。换新端口会被无视——这正是「跑一次之后就再也跑不起来」的成因。
 */
/** 最近一次开通道时 cli 的输出：失败时它是唯一的现场（IDE 说了什么、是不是在等弹窗）。 */
let lastCliOutput = "";

async function openChannel(
  a: any,
  cliPath: string,
  projectPath: string,
  port: number,
): Promise<any> {
  // 两轮：第一轮直接开；第二轮先把该项目窗口关掉再开。
  //
  // 第二轮的理由：开发者工具对同一项目只保留**一条**自动化通道，若旧窗口还开着
  // （另一个 pageqa 会话、或者用户自己开着这个项目），它不会为新端口再开一条——
  // 表现为 auto 说「成功」但 ws 永远连不上。`cli close` 关掉项目窗口，通道就释放了。
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt === 1) {
      debugLog("[miniprogram] 关掉该项目窗口后重试开通道…");
      await runCli(cliPath, ["close", "--project", projectPath]);
    }
    const child = spawn(
      cliPath,
      ["auto", "--project", projectPath, "--auto-port", String(port)],
      { stdio: ["ignore", "pipe", "pipe"], shell: true, windowsHide: true },
    );
    // cli 的输出要留着：失败时它是唯一的现场（IDE 说了什么、是不是在等一个弹窗）。
    let cliOutput = "";
    const onData = (d: Buffer) => {
      const line = String(d).trim();
      if (!line) return;
      cliOutput = (cliOutput + " " + line).slice(-400);
      debugLog(`[miniprogram] cli: ${line.slice(0, 200)}`);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const deadline = Date.now() + CHANNEL_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        return await connectWithTimeout(
          a,
          `ws://127.0.0.1:${port}`,
          CONNECT_PROBE_TIMEOUT_MS,
        );
      } catch {
        await sleep(CHANNEL_POLL_INTERVAL_MS);
      }
    }
    try {
      child.kill();
    } catch {
      /* 已经退出就算了 */
    }
    lastCliOutput = cliOutput;
  }
  throw new Error(
    `端口 ${port} 上一直没等到自动化通道就绪` +
      (lastCliOutput ? `（cli 输出：${lastCliOutput}）` : ""),
  );
}

/**
 * 启动微信开发者工具并载入项目（已启动则复用单例）。
 *
 * 连接模型与 bsk 的 `ensureBskReady` 对应：要求用户已装 `miniprogram-automator`，
 * 且本地有微信开发者工具。连不上时由调用方给出清晰指引（见 agent.ts / replay.ts）。
 *
 * 注：`automator.launch()` 的返回值即 MiniProgram 实例本身。
 */
export async function ensureMiniprogramReady(
  config: MiniProgramConfig = {},
): Promise<void> {
  if (miniProgram) return;
  if (!config.projectPath) {
    throw new Error(
      "小程序驱动缺少 projectPath：请在配置 miniprogram.projectPath 或设置环境变量 " +
        "PAGEQA_MINIPROGRAM_PROJECT_PATH 指定小程序项目根目录。",
    );
  }
  if (!config.cliPath) {
    throw new Error(
      "小程序驱动缺少 cliPath：请在配置 miniprogram.cliPath 或设置环境变量 " +
        "PAGEQA_MINIPROGRAM_CLI_PATH 指向微信开发者工具的 cli.bat。",
    );
  }
  const a = await loadAutomator();

  // ① 父进程传下来的端点：同一会话内的场景子进程走这条（父进程已经开好通道）。
  const fromEnv = (process.env[WS_ENV] ?? "").trim();
  if (fromEnv) {
    try {
      miniProgram = await connectWithTimeout(
        a,
        fromEnv,
        CONNECT_PROBE_TIMEOUT_MS,
      );
      debugLog(`[miniprogram] 复用父进程建立的通道 ${fromEnv}`);
    } catch {
      /* 父进程的通道已失效 → 往下走，自己开一条 */
    }
  }

  // ② 现成的活通道：IDE 侧还开着、且还接受新连接的那条。
  if (!miniProgram) {
    for (const port of CANDIDATE_PORTS) {
      const endpoint = `ws://127.0.0.1:${port}`;
      try {
        miniProgram = await connectWithTimeout(
          a,
          endpoint,
          CONNECT_PROBE_TIMEOUT_MS,
        );
        debugLog(`[miniprogram] 复用已开启的自动化通道 ${endpoint}`);
        process.env[WS_ENV] = endpoint;
        break;
      } catch {
        /* 该端点没有响应，试下一个 */
      }
    }
  }

  // ③ 自己开一条：端口优先选「IDE 之前用过、现在还开着」的那个（僵尸通道可复活）。
  if (!miniProgram) {
    debugLog("[miniprogram] 启动微信开发者工具并载入项目…");
    const listening: number[] = [];
    for (const port of CANDIDATE_PORTS) {
      if (await isPortListening(port)) listening.push(port);
    }
    const order = [
      ...listening,
      ...CANDIDATE_PORTS.filter((p) => !listening.includes(p)),
    ];
    let lastErr: unknown;
    for (const port of order.slice(0, 3)) {
      try {
        miniProgram = await openChannel(
          a,
          config.cliPath,
          config.projectPath,
          port,
        );
        process.env[WS_ENV] = `ws://127.0.0.1:${port}`;
        debugLog(`[miniprogram] 已在端口 ${port} 建立自动化通道`);
        break;
      } catch (err) {
        lastErr = err;
        debugLog(
          `[miniprogram] 端口 ${port} 开不出通道：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!miniProgram) {
      throw new Error(
        `无法连接微信开发者工具：候选端口（${CANDIDATE_PORTS.join(", ")}）都没能建立自动化通道。` +
          `请确认开发者工具已登录、且已开启服务端口（设置 → 安全设置）；` +
          `若该项目已在开发者工具里打开，请先把它关掉再重试。` +
          `另外请在开发者工具的「安全」里打开「自动化接口打开工具时默认信任项目」——` +
          `否则 IDE 会弹「是否信任该项目」的确认框，没人点，自动化就会一直等不到。` +
          `底层错误：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      );
    }
  }
  // 尽力订阅 console / 异常事件（事件名属内部实现，订阅失败不致命）。
  try {
    for (const ev of ["log", "exception", "error", "apperror"]) {
      miniProgram.on?.(ev, (...args: unknown[]) => {
        const text = args
          .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
          .join(" ");
        if (/error|exception|throw|reject/i.test(text)) consoleErrors.push(text);
      });
    }
  } catch {
    /* 事件订阅不可用则忽略 */
  }
  // 预热：automator 内部在首次取页面 meta 时才建立 webviewId 缓存，冷启动下
  // 项目还在编译加载，立刻取 meta 会拿到 null（报 `getPageMetaByWebviewId(...)
  // is null`），并连带让随后的 reLaunch/snapshot 失败。这里轮询到页面 meta
  // 可取为止，把「页面已就绪」这一前置条件显式化。
  const deadline = Date.now() + WARMUP_TIMEOUT_MS;
  let warmed = false;
  while (Date.now() < deadline) {
    try {
      await miniProgram.currentPage();
      warmed = true;
      break;
    } catch {
      await sleep(WARMUP_INTERVAL_MS);
    }
  }
  if (!warmed) {
    debugLog(
      "[miniprogram] 预热超时（页面 meta 暂不可取），后续操作将自带重试兜底。",
    );
  }
  info("小程序驱动已就绪（微信开发者工具已连接）");
}

/** 取已连接的小程序句柄；未就绪时抛错。 */
export async function getMiniProgram(): Promise<any> {
  if (!miniProgram) {
    throw new Error("小程序驱动尚未就绪：请先调用 ensureMiniprogramReady。");
  }
  return miniProgram;
}

/** 取当前页面句柄。 */
export async function getCurrentPage(): Promise<any> {
  const mp = await getMiniProgram();
  return mp.currentPage();
}

/** 关闭开发者工具连接（与 bsk 的 closeSession 对应）。 */
export async function closeMiniprogram(): Promise<void> {
  // **不断连**：断开的通道会留在 IDE 侧监听、却不再接受新连接（僵尸通道），
  // 让它留着，下个会话直接复用（真正需要重开时，我们自己能对同一个端口
  // 重跑 `cli auto` 把它复活）。
  if (ownsConnection) {
    debugLog("[miniprogram] 保留已建立的自动化通道，供后续会话复用");
  }
  miniProgram = null;
  ownsConnection = false;
  consoleErrors = [];
}
