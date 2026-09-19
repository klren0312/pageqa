/**
 * 脚本运行时变量：读取测试脚本时把 `${...}` 占位符替换为本次运行的实际取值，
 * 避免用例名称里的时间戳被写死（例如反复运行会撞名）。
 *
 * 支持 `${名称}` 与 `${名称:<格式>}` 两种写法：
 *   - timestamp  -> yyyyMMddHHmm（默认格式）
 *   - date       -> yyyyMMdd
 *   - time       -> HHmmss
 *   - datetime   -> yyyyMMddHHmmss
 * 自定义格式支持 yyyy / yy / MM / dd / HH / mm / ss / SSS 组合，例如
 * `${timestamp:yyyy-MM-dd HH:mm}`。
 *
 * 未识别的名称或格式原样保留，因此脚本里写 `${PATH}` 之类的字面量不会被误替换。
 */

const PRESETS: Record<string, string> = {
  timestamp: "yyyyMMddHHmm",
  date: "yyyyMMdd",
  time: "HHmmss",
  datetime: "yyyyMMddHHmmss",
};

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g;

function pad(n: number, len: number): string {
  return String(n).padStart(len, "0");
}

/** 按本机本地时间格式化，支持 yyyy/yy/MM/dd/HH/mm/ss/SSS。 */
export function formatLocalTime(date: Date, pattern: string): string {
  return pattern.replace(/yyyy|yy|MM|dd|HH|mm|ss|SSS/g, (token) => {
    switch (token) {
      case "yyyy":
        return pad(date.getFullYear(), 4);
      case "yy":
        return pad(date.getFullYear() % 100, 2);
      case "MM":
        return pad(date.getMonth() + 1, 2);
      case "dd":
        return pad(date.getDate(), 2);
      case "HH":
        return pad(date.getHours(), 2);
      case "mm":
        return pad(date.getMinutes(), 2);
      case "ss":
        return pad(date.getSeconds(), 2);
      case "SSS":
        return pad(date.getMilliseconds(), 3);
      default:
        return token;
    }
  });
}

/** 展开脚本中的运行时变量占位符；同一脚本共用同一时刻，保证各处取值一致。 */
export function expandVars(script: string, now: Date = new Date()): string {
  return script.replace(
    PLACEHOLDER,
    (whole: string, name: string, pattern?: string) => {
      const preset = Object.prototype.hasOwnProperty.call(PRESETS, name)
        ? PRESETS[name]
        : undefined;
      if (preset === undefined) return whole;
      const fmt = pattern?.trim();
      return formatLocalTime(now, fmt ? fmt : preset);
    },
  );
}

/** 供 `--help`/文档展示的占位符清单（读取脚本时按运行时本地时间展开）。 */
export const VAR_HELP = [
  "  ${timestamp}                 yyyyMMddHHmm（如 202609191146）",
  "  ${date} / ${time}            yyyyMMdd / HHmmss",
  "  ${datetime}                  yyyyMMddHHmmss",
  "  ${timestamp:<格式>}          自定义格式，支持 yyyy/yy/MM/dd/HH/mm/ss/SSS",
  "                               例：${timestamp:yyyy-MM-dd HH:mm}",
].join("\n");
