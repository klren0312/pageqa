import type { Driver, MiniProgramConfig } from "../config/config.js";

export type { Driver, MiniProgramConfig };

/**
 * 某动作在小程序驱动里没有对应物（如 upload / wheel / pick_date / select_option）。
 *
 * 这些工具根本不会在小程序模式的工具集里注册（模型看不到），但若回放脚本里残留了它们，
 * 对应操作会抛这个错——比「静默当作成功」更诚实，也让人知道该改用例。
 */
export class UnsupportedInDriverError extends Error {
  constructor(action: string) {
    super(
      `小程序驱动不支持「${action}」：该动作在小程序运行时里没有对应能力，用例请勿使用。`,
    );
    this.name = "UnsupportedInDriverError";
  }
}
