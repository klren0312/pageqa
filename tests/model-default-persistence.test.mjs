/**
 * `/model` 文案一致性：`选中即写盘` 之后，帮助与浮层提示都不该再提 Ctrl+S。
 *
 * 这是一条**文案守卫**，不是行为测试：浮层按键交互在本仓库没有可驱动的测试夹具
 * （`tests/tui.test.mjs` 只覆盖队列 / 批次 / 场景拆分这类纯逻辑），但「帮助文本怎么说」
 * 恰恰是最容易在改了行为之后忘记同步的地方——文案留着 Ctrl+S，用户按了没反应，
 * 就会认定功能坏了（与 ADR-0008「Ctrl+C 是正常退出」踩过的是同一类坑）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { setLocale, t } from "../dist/shared/i18n.js";

describe("/model 的帮助与提示文案", () => {
  for (const locale of ["zh", "en"]) {
    test(`${locale}：帮助与选择器提示都不再提Ctrl+S，且说明选中即写盘`, () => {
      setLocale(locale);
      const help = t("help.full");
      const tuiHelp = t("tui.help");
      const hint = t("tui.model.hint");

      for (const [name, text] of [
        ["help.full", help],
        ["tui.help", tuiHelp],
        ["tui.model.hint", hint],
      ]) {
        assert.ok(
          !/Ctrl\+S/i.test(text),
          `${name} 仍在提 Ctrl+S（该键已随ADR-0015 移除）：${text}`,
        );
      }
      assert.match(hint, /startup default|启动默认/);
      setLocale("zh");
    });
  }

  test("zh：写盘提示说清「下次启动生效」，失败时说清「本次会话已生效」", () => {
    setLocale("zh");
    // 成功：一条合并后的提示，必须点明它同时是下次启动的默认。
    assert.match(t("tui.model.applied"), /下次启动生效/);
    // 失败：如实说明内存已切、但默认没写进去（不把锅甩给用户看不懂的地方）。
    const failed = t("tui.model.saveDefaultFailed", {
      provider: "anthropic",
      model: "claude-x",
      msg: "EACCES",
    });
    assert.match(failed, /本次会话已切到 anthropic\/claude-x/);
    assert.match(failed, /下次启动仍用旧的/);
  });

  test("zh：env 优先级在场时给出提示，而不是静默让写入看起来无效", () => {
    setLocale("zh");
    assert.match(t("tui.model.envOverride"), /PAGEQA_LLM_MODEL/);
  });

  test("zh：fallback 自愈后说明 config.json 已同步", () => {
    setLocale("zh");
    const healed = t("tui.model.fallback", {
      provider: "anthropic",
      model: "claude-x",
      next: "hunyuan-2.0-instruct",
      healed: t("tui.model.fallbackHealed"),
    });
    assert.match(healed, /已同步更新/);
    assert.match(healed, /退回并改用 hunyuan-2\.0-instruct/);
  });
});