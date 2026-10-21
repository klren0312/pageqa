/**
 * `pageqa update`：检查 npm 上的最新版本，并（默认）执行全局安装。
 *
 * 版本查询走 `npm view`，安装走 `npm install -g pageqa@latest`：两者都沿用用户
 * 当前的 npm registry 配置。pnpm 用户如果遇到全局路径/权限问题，失败信息里会给出手动命令。
 *
 * 核心流程做成可注入依赖，测试不需要联网、也不会真的执行全局安装。
 */
import { spawn } from "node:child_process";
import { t } from "./shared/i18n.js";
import { packageVersion } from "./shared/version.js";

const PACKAGE = "pageqa";
const NPM = "npm";

/** Windows 上直接 spawn `npm.cmd` 会 EINVAL；用固定命令串交给 shell，避免参数注入面。 */
function spawnNpm(
  args: string[],
  options: Parameters<typeof spawn>[2],
): ReturnType<typeof spawn> {
  if (process.platform === "win32") {
    return spawn([NPM, ...args].join(" "), {
      ...options,
      shell: true,
    });
  }
  return spawn(NPM, args, options);
}

export interface UpdateOptions {
  /** `--check`：只检查，不安装。 */
  check: boolean;
  /** `--json`：只检查并以 JSON 输出（隐含 check）。 */
  json: boolean;
  /** `update --help`。 */
  help: boolean;
}

export interface UpdateDeps {
  currentVersion: () => string;
  latestVersion: () => Promise<string>;
  install: () => Promise<number>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** 比较两个 `x.y.z` 版本；非数字/缺段都当作相等（调用方只在能解析时使用）。 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

function captureNpm(args: string[], timeoutMs = 30_000): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawnNpm(args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    // stdio 指定了 pipe；类型上仍是 nullable，这里按可选处理，避免为提升类型写重载。
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(t("update.timeout", { ms: timeoutMs })));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function fetchLatestVersion(): Promise<string> {
  const result = await captureNpm(["view", PACKAGE, "dist-tags", "--json"]);
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || t("update.npmExit", { code: String(result.code) }),
    );
  }
  const value = result.stdout.trim();
  let latest: string | undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    // 这个 npm 版本会把单个查询结果也包成数组：`[{"latest":"0.14.1"}]`。
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const tag = (first as Record<string, unknown>).latest;
      if (typeof tag === "string") latest = tag;
    } else if (typeof first === "string") {
      latest = first;
    }
  } catch {
    // 旧版 npm 可能直接输出裸版本号；下面用正则兜底。
  }
  if (!latest) {
    const match = /(\d+\.\d+\.\d+)/.exec(value);
    if (match) latest = match[1];
  }
  if (!latest || !/^\d+\.\d+\.\d+/.test(latest)) {
    throw new Error(t("update.badVersion", { value }));
  }
  return latest;
}

function installLatest(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawnNpm(["install", "-g", `${PACKAGE}@latest`], {
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

const defaultDeps: UpdateDeps = {
  currentVersion: packageVersion,
  latestVersion: fetchLatestVersion,
  install: installLatest,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/**
 * 执行 update 子命令。
 *
 * `--json` 只检查并输出机器可读结果（不会安装）；默认/`--check` 之外的路径才会安装。
 * 检查成功即返回 0，即使发现新版本；安装失败返回 1。
 */
export async function runUpdate(
  opts: UpdateOptions,
  deps: UpdateDeps = defaultDeps,
): Promise<number> {
  if (opts.help) {
    deps.stdout(t("help.update") + "\n");
    return 0;
  }
  const current = deps.currentVersion();
  const checkOnly = opts.check || opts.json;
  if (!opts.json) deps.stdout(t("update.checking") + "\n");

  let latest: string;
  try {
    latest = await deps.latestVersion();
  } catch (err) {
    deps.stderr(
      t("update.error", { msg: err instanceof Error ? err.message : String(err) }) +
        "\n",
    );
    return 1;
  }

  if (current === "unknown") {
    if (opts.json) {
      deps.stdout(
        JSON.stringify(
          { current, latest, updateAvailable: null },
          null,
          2,
        ) + "\n",
      );
    } else {
      deps.stdout(t("update.unknown", { latest }) + "\n");
    }
    return 0;
  }

  const updateAvailable = compareVersions(latest, current) > 0;
  if (opts.json) {
    deps.stdout(
      JSON.stringify({ current, latest, updateAvailable }, null, 2) + "\n",
    );
    return 0;
  }
  if (!updateAvailable) {
    deps.stdout(t("update.upToDate", { current }) + "\n");
    return 0;
  }
  if (checkOnly) {
    deps.stdout(t("update.available", { current, latest }) + "\n");
    return 0;
  }

  deps.stdout(t("update.installing", { current, latest }) + "\n");
  let code: number;
  try {
    code = await deps.install();
  } catch (err) {
    deps.stderr(
      t("update.installError", {
        msg: err instanceof Error ? err.message : String(err),
      }) + "\n",
    );
    return 1;
  }
  if (code !== 0) {
    deps.stderr(t("update.failed", { code: String(code) }) + "\n");
    return 1;
  }
  deps.stdout(t("update.done", { version: latest }) + "\n");
  return 0;
}
