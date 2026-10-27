import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  maskFrontmatter,
  mergeMiniprogramConfig,
  splitFrontmatter,
} from "../../dist/shared/case-meta.js";
import { splitScenarios } from "../../dist/agent/agent.js";
import { lintCase } from "../../dist/agent/lint.js";

// 纯单元测试：用例头的解析、与正文的切分、以及「不污染步骤数/行号」。

describe("splitFrontmatter：解析用例头", () => {
  test("嵌套写法：只覆盖显式给出的字段", () => {
    const input = [
      "---",
      "miniprogram:",
      '  projectPath: "D:\\\\1project\\\\yudao"',
      "  cliPath: D:\\Apps\\cli.bat",
      "  platform: ios",
      "---",
      "",
      "## 场景",
      "打开 mp://pages/index/index",
    ].join("\n");
    const { meta, body, found } = splitFrontmatter(input);
    assert.equal(found, true);
    assert.deepEqual(meta.miniprogram, {
      projectPath: "D:\\1project\\yudao",
      cliPath: "D:\\Apps\\cli.bat",
      platform: "ios",
    });
    assert.equal(body.trimStart(), "## 场景\n打开 mp://pages/index/index");
  });

  test("扁平写法 miniprogram.projectPath", () => {
    const input = "---\nminiprogram.projectPath: D:\\1project\\flat\n---\n## X\n打开 mp://a";
    assert.deepEqual(splitFrontmatter(input).meta, {
      miniprogram: { projectPath: "D:\\1project\\flat" },
    });
  });

  test("没有闭合的 ---：不当作用例头", () => {
    const input = "---\nfoo: 1\n## X\n打开 mp://a";
    const { meta, found, body } = splitFrontmatter(input);
    assert.equal(found, false);
    assert.deepEqual(meta, {});
    assert.equal(body, input);
  });

  test("开头有空行也认", () => {
    const input = "\n\n---\nminiprogram:\n  port: 9420\n---\n## X\n打开 mp://a";
    assert.deepEqual(splitFrontmatter(input).meta, {
      miniprogram: { port: 9420 },
    });
  });
});

describe("mergeMiniprogramConfig：用例覆盖全局，缺省字段保留", () => {
  test("只覆盖写了的字段", () => {
    const merged = mergeMiniprogramConfig(
      { cliPath: "C:\\cli.bat", projectPath: "C:\\old", port: 9420 },
      { projectPath: "D:\\new" },
    );
    assert.deepEqual(merged, {
      cliPath: "C:\\cli.bat",
      projectPath: "D:\\new",
      platform: undefined,
      timeout: undefined,
      port: 9420,
      account: undefined,
    });
  });

  test("没有用例覆盖时原样返回全局配置", () => {
    const base = { projectPath: "C:\\old" };
    assert.deepEqual(mergeMiniprogramConfig(base, undefined), base);
  });
});

describe("maskFrontmatter：保持行号", () => {
  test("用例头换成空行，正文行号不位移", () => {
    const input = "---\nminiprogram:\n  port: 1\n---\n## X\n打开 mp://a";
    const masked = maskFrontmatter(input);
    const lines = masked.split("\n");
    assert.equal(lines[0], "");
    assert.equal(lines[4], "## X");
    assert.equal(lines[5], "打开 mp://a");
  });
});

describe("用例头不污染运行时与校验", () => {
  test("splitScenarios 不会把 frontmatter 当成正文", () => {
    const input = "---\nminiprogram:\n  port: 1\n---\n## W1\n打开 mp://a";
    const scenarios = splitScenarios(input);
    assert.equal(scenarios.length, 1);
    assert.equal(scenarios[0].name, "W1");
    assert.equal(scenarios[0].body, "打开 mp://a");
  });

  test("lintCase：不报 preambleText，步骤/断言计数与正文一致", () => {
    const input = [
      "---",
      "miniprogram:",
      '  projectPath: "D:\\\\1project\\\\yudao"',
      "---",
      "",
      "## W1 打开",
      "打开 mp://pages/index/index 并断言页面包含 '工作台'",
    ].join("\n");
    const result = lintCase(input);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.counts, {
      scenarios: 1,
      steps: 1,
      assertions: 1,
      downloads: 0,
    });
  });
});
