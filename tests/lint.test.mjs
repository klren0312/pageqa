import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LINT_RULE_IDS, lintCase, lintHasErrors } from "../dist/agent/lint.js";
import { getLocale, setLocale, t } from "../dist/shared/i18n.js";
import { countAssertions, numberSteps } from "../dist/report/report.js";

// 纯单元测试：lintCase 是纯函数（只吃文本、吐问题清单），不开浏览器也不调模型。

/** 用例文本命中的规则 id 集合。 */
function rules(input) {
  return lintCase(input).issues.map((i) => i.rule);
}

function hasRule(input, rule) {
  return rules(input).includes(rule);
}

describe("lintCase：干净用例不报问题", () => {
  test("规范写法的多场景用例", () => {
    const input = [
      "# 套件",
      "",
      "> 前置：先起本地静态服务",
      "",
      "## 打开页面",
      "打开 http://localhost:18888/smoke-test-page.html",
      "等到页面出现 `冒烟测试页面`",
      "断言标题包含 冒烟测试页面",
      "",
      "## 表单填写",
      "点击「表单页面 1」链接",
      "在「姓名」输入框填写 张三${timestamp}",
      "在「城市」下拉框中选择 北京",
      "点击「提交表单」按钮",
      "等到页面出现 `表单提交成功`",
      "断言页面出现 `表单提交成功`",
    ].join("\n");
    const result = lintCase(input);
    assert.deepEqual(result.issues, []);
    assert.equal(result.errors, 0);
    assert.equal(result.counts.scenarios, 2);
  });

  test("内联单场景（没有 `## `）不会因为缺场景头被报错", () => {
    assert.deepEqual(rules("打开 https://example.com 并断言标题包含 Example"), []);
  });
});

describe("lintCase：error 级规则", () => {
  test("preambleText：`## ` 之前的正文（这里是 warn，但会真的被丢掉）", () => {
    const result = lintCase("这是开场说明。\n\n## 场景\n打开 https://example.com\n断言页面包含 A");
    assert.ok(result.issues.some((i) => i.rule === "preambleText" && i.severity === "warn"));
    assert.equal(result.issues.find((i) => i.rule === "preambleText").line, 1);
  });

  test("emptyScenario：`## ` 场景下只有注释/空行", () => {
    const input = "## 空场景\n\n> 只有一句说明\n\n## 有步骤\n打开 https://example.com\n断言页面包含 A";
    assert.ok(hasRule(input, "emptyScenario"));
    assert.ok(lintHasErrors(lintCase(input)));
  });

  test("duplicateScenario：标题重复（`--only` 无法区分）", () => {
    const input = "## 登录\n打开 https://a.com\n断言页面包含 A\n\n## 登录\n打开 https://b.com\n断言页面包含 B";
    assert.ok(hasRule(input, "duplicateScenario"));
  });

  test("snapshotRef：@e 快照编号", () => {
    assert.ok(hasRule("## 场景\n打开 https://example.com\n点击 @e3 按钮\n断言页面包含 A", "snapshotRef"));
  });

  test("urlScheme：打开后面的地址缺 http/https", () => {
    assert.ok(hasRule("打开 example.com 并断言标题包含 Example", "urlScheme"));
    assert.ok(!hasRule("打开 https://example.com 并断言标题包含 Example", "urlScheme"));
    // 「点击『打开』按钮」不是导航，别误报
    assert.ok(!hasRule("点击「打开」按钮\n断言页面包含 弹窗", "urlScheme"));
  });

  test("unknownPlaceholder：未识别的 ${...} 会被原样保留", () => {
    assert.ok(hasRule("在「名称」输入框填写 产品${PATH}\n断言页面包含 A", "unknownPlaceholder"));
    assert.ok(!hasRule("在「名称」输入框填写 产品${timestamp}\n断言页面包含 A", "unknownPlaceholder"));
  });

  test("uploadPath：上传必须是绝对路径", () => {
    assert.ok(hasRule("点击「选择文件」并上传本地文件 ./a.xlsx\n断言页面包含 A", "uploadPath"));
    assert.ok(hasRule("点击「选择文件」并上传本地文件\n断言页面包含 A", "uploadPath"));
    assert.ok(!hasRule("点击「选择文件」并上传本地文件 D:\\data\\a.xlsx\n断言页面包含 A", "uploadPath"));
    // 「点击『文件上传』链接」不是上传动作，别误报
    assert.ok(!hasRule("点击「文件上传」链接\n断言页面出现 上传区域", "uploadPath"));
  });
});

describe("lintCase：warn 级规则", () => {
  test("hardWait：页面内的固定等待该写条件等待", () => {
    assert.ok(hasRule("点击「提交」按钮\n等待 2 秒，让页面加载\n断言页面包含 A", "hardWait"));
    assert.ok(!hasRule("点击「提交」按钮\n等到页面出现「成功」\n断言页面包含 A", "hardWait"));
  });

  test("selectAsFill：下拉框写成了填写", () => {
    assert.ok(hasRule("在「城市」下拉框中填写 北京\n断言页面包含 A", "selectAsFill"));
    // 原生日期输入框用「填写」是正常的
    assert.ok(!hasRule("在「出生日期」输入框填写 1990-01-01\n断言页面包含 A", "selectAsFill"));
    // 推荐写法（点击下拉框再选）不该报
    assert.ok(!hasRule("在「城市」下拉框中选择 北京\n断言页面包含 A", "selectAsFill"));
  });

  test("downloadExtraAssert：下载本身即断言，别再单写一行文件名断言", () => {
    assert.ok(hasRule("断言文件名以 .txt 结尾", "downloadExtraAssert"));
    // 同一行里已有捕获下载的动作：那是推荐写法
    assert.ok(
      !hasRule(
        "用 download 工具把「下载」链接作为触发元素，捕获文件并断言磁盘上已拿到；文件名以 .txt 结尾",
        "downloadExtraAssert",
      ),
    );
    // 「上传的文件名」与下载无关
    assert.ok(!hasRule("断言页面中已出现上传的文件名", "downloadExtraAssert"));
  });

  test("vagueAssertion：断言里没有可字面匹配的文本", () => {
    // 状态描述：断言工具只能做字面包含，模型只能去快照里读一个当前值顶上
    assert.ok(hasRule("断言表格中存在数据行", "vagueAssertion"));
    assert.ok(hasRule("断言弹框已打开", "vagueAssertion"));
    // 有具体文本（引号锚点，或「包含 X」里的 X 是具体文案）→ 不报
    assert.ok(!hasRule("断言页面出现「保存成功」", "vagueAssertion"));
    assert.ok(!hasRule("断言标题包含 Example", "vagueAssertion"));
    assert.ok(!hasRule("断言表格中出现「详情」按钮", "vagueAssertion"));
    // 工具型断言读的是浏览器侧缓冲，本来就没有对应的页面文本
    assert.ok(!hasRule("断言页面没有控制台报错", "vagueAssertion"));
    assert.ok(
      !hasRule("断言请求 /api/dingtalk 返回 200，方法是 POST", "vagueAssertion"),
    );
  });

  test("proseStep：说明性文字被当成了步骤", () => {
    assert.ok(hasRule("## 场景\n打开 https://example.com\n这条用例用来覆盖长流程。\n断言页面包含 A", "proseStep"));
    assert.ok(hasRule("## 场景\n打开 https://example.com\n注意：这一步要慢一点\n断言页面包含 A", "proseStep"));
  });

  test("noAssertion：整个场景没有断言行", () => {
    assert.ok(hasRule("## 场景\n打开 https://example.com\n点击「登录」按钮", "noAssertion"));
    // 下载捕获算断言，不该报
    assert.ok(
      !hasRule(
        "## 场景\n打开 https://example.com\n用 download 工具把「导出」按钮作为触发元素并捕获文件",
        "noAssertion",
      ),
    );
  });
});

describe("lintCase：计数口径与运行时一致", () => {
  test("steps 与 numberSteps 一致、assertions 与 countAssertions 一致", () => {
    const input = [
      "# 套件",
      "> 这句是注释",
      "## A",
      "打开 https://example.com",
      "点击「Learn more」链接",
      "断言页面包含 IANA",
      "## B",
      "打开 https://example.org",
      "断言标题包含 Example",
    ].join("\n");
    const result = lintCase(input);
    assert.equal(result.counts.steps, numberSteps(input).steps.length);
    assert.equal(result.counts.assertions, countAssertions(input));
  });
});

describe("lintCase 文案：zh 与 en 都不缺", () => {
  test("每条规则、以及通用文案，两种语种都能渲染（而不是把 key 原样返回）", () => {
    const previous = getLocale();
    try {
      for (const locale of ["zh", "en"]) {
        setLocale(locale);
        for (const id of LINT_RULE_IDS) {
          const key = `lint.rule.${id}`;
          assert.notEqual(t(key), key, `${locale} 缺译：${key}`);
        }
      }
    } finally {
      setLocale(previous);
    }
  });
});
