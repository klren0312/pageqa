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

/** 一次运行中某个占位符的实际取值（用于把录制到的具体值还原回占位符写法）。 */
export interface RunVarValue {
  /** 占位符名，如 `timestamp`。 */
  name: string;
  /** 占位符原文，如 `${timestamp}`。 */
  placeholder: string;
  /** 本次运行展开出的具体值，如 `202609191146`。 */
  value: string;
}

/**
 * 取本次运行各预设占位符的实际取值。
 *
 * 录制回放脚本时，模型看到的是**已展开**的值（如 `自动化测试产品202609191146`），
 * 直接写进脚本会让脚本只能跑一次（下次回放撞名）。因此需要用同一时刻的取值反查，
 * 把具体值还原成 `${timestamp}`，回放时再重新展开。
 */
export function captureRunVars(now: Date = new Date()): RunVarValue[] {
  return Object.entries(PRESETS).map(([name, fmt]) => ({
    name,
    placeholder: `\${${name}}`,
    value: formatLocalTime(now, fmt),
  }));
}

/**
 * 把文本里的运行时变量取值还原成占位符写法（`202609191146` -> `${timestamp}`）。
 *
 * 只处理长度 >= 8 的取值：`${time}`（`HHmmss`，6 位纯数字）太容易撞上页面里无关的数字
 * （编号、编码、CSS 类名），替换错了反而会破坏定位符，宁可不还原。
 * 长值优先替换，否则 `${date}` 会先吃掉 `${datetime}` 的前缀。
 */
export function restorePlaceholders(
  text: string,
  vars: RunVarValue[],
): string {
  let out = text;
  for (const v of [...vars]
    .filter((v) => v.value.length >= 8)
    .sort((a, b) => b.value.length - a.value.length)) {
    if (!out.includes(v.value)) continue;
    out = out.split(v.value).join(v.placeholder);
  }
  return out;
}

/** 供 `--help`/文档展示的占位符清单（读取脚本时按运行时本地时间展开）。 */
export const VAR_HELP = [
  "  ${timestamp}                 yyyyMMddHHmm（如 202609191146）",
  "  ${date} / ${time}            yyyyMMdd / HHmmss",
  "  ${datetime}                  yyyyMMddHHmmss",
  "  ${timestamp:<格式>}          自定义格式，支持 yyyy/yy/MM/dd/HH/mm/ss/SSS",
  "                               例：${timestamp:yyyy-MM-dd HH:mm}",
].join("\n");
