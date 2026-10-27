import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  caseNameFromFile,
  caseNameFromPath,
  caseNameFromText,
  escapeHtml,
  formatDurationMs,
  renderHtml,
  htmlReportFilePath,
  reportTitle,
  writeHtmlReport,
} from "../../dist/report/report-html.js";
import { getLocale, setLocale } from "../../dist/shared/i18n.js";

const base = (over = {}) => ({
  status: "pass",
  assertions: [{ expectation: "标题包含 pageqa", verdict: "pass", evidence: "页面中包含「pageqa」" }],
  transcript: "",
  summary: "全部断言成立",
  ...over,
});

describe("截图内联", () => {
  // 1x1 的合法 PNG：内容不重要，重要的是「文件真能读出来并被 base64 化」。
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  test("有截图时内联成 data URL，并保留文件名作为图注", () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-shots-"));
    const path = join(dir, "shot.png");
    writeFileSync(path, PNG);
    try {
      const html = renderHtml(base({ screenshots: [path] }));
      assert.ok(html.includes('class="shots"'));
      assert.ok(html.includes("data:image/png;base64,"));
      assert.ok(html.includes("shot.png"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("截图文件不在了 → 退化成一行路径，报告照常渲染", () => {
    const html = renderHtml(base({ screenshots: ["D:/does/not/exist.png"] }));
    assert.ok(html.includes('class="shots"'));
    assert.ok(!html.includes("data:image/png;base64,"));
    assert.ok(html.includes("D:/does/not/exist.png"));
  });

  test("没有截图时不渲染截图区", () => {
    assert.ok(!renderHtml(base()).includes('class="shots"'));
  });
});

describe("renderHtml", () => {
  test("单场景：状态徽章、断言、摘要、耗时", () => {
    // 计划用例漏了 trace：断言 `<details` 需要有轨迹才渲染折叠块，此处补最小轨迹。
    const html = renderHtml(base({ durationMs: 1234, trace: ["[tool] navigate"] }));
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.ok(html.includes("PASS"));
    assert.ok(html.includes("标题包含 pageqa"));
    assert.ok(html.includes("页面中包含「pageqa」"));
    assert.ok(html.includes("全部断言成立"));
    assert.ok(html.includes("1.2s"));
    assert.ok(html.includes("<details"));
  });

  test("套件：汇总计数与逐场景节", () => {
    const html = renderHtml(
      base({
        status: "fail",
        durationMs: 3000,
        scenarios: [
          { name: "A 登录", status: "pass", steps: ["打开页面"], trace: ["[tool] navigate"], assertions: [] },
          { name: "B 下单", status: "cancelled", steps: [], trace: [], assertions: [], cancelReason: undefined },
        ],
        assertions: [],
      }),
    );
    assert.ok(html.includes("A 登录"));
    assert.ok(html.includes("B 下单"));
    assert.ok(html.includes("FAIL"));
    assert.ok(html.includes("navigate"));
  });

  test("cancelled 徽章用 statusTag 中文口径", () => {
    const html = renderHtml(base({ status: "cancelled", cancelReason: "用户中止" }));
    assert.ok(html.includes("已取消"));
    assert.ok(html.includes("用户中止"));
  });

  test("场景名 HTML 转义，不产生可执行标签", () => {
    const html = renderHtml(
      base({
        scenarios: [
          { name: "<script>alert(1)</script>", status: "pass", steps: [], trace: [], assertions: [] },
        ],
      }),
    );
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.ok(html.includes("&lt;script&gt;"));
  });

  test("空 scenarios 仍是套件视图：零计数 + 套件标题 + 汇总行", () => {
    const html = renderHtml(
      base({
        status: "pass",
        scenarios: [],
        assertions: [],
        summary: "共 0 个场景，通过 0 个",
      }),
    );
    assert.ok(html.includes("页面测试套件报告"));
    assert.ok(html.includes("汇总: 共 0 个场景，通过 0 个"));
    assert.ok(html.includes("<b>0</b>总场景"));
    assert.ok(!html.includes("<b>1</b>总场景"));
    assert.ok(html.includes("<b>0</b>通过"));
  });

  test("套件场景节渲染 summary 与 skipped", () => {
    const html = renderHtml(
      base({
        status: "pass",
        assertions: [],
        scenarios: [
          {
            name: "A 回放",
            status: "pass",
            steps: [],
            trace: [],
            assertions: [],
            summary: "回放 5 步，执行 4 步",
            skipped: ["第 3 步：<b>关闭</b>弹窗"],
          },
        ],
      }),
    );
    assert.ok(html.includes("摘要: 回放 5 步，执行 4 步"));
    assert.ok(html.includes("跳过 1 步"));
    assert.ok(html.includes("第 3 步：&lt;b&gt;关闭&lt;/b&gt;弹窗"));
    assert.ok(!html.includes("<b>关闭</b>弹窗"));
  });

  test("套件场景节未带 summary/skipped 时不渲染对应块", () => {
    const html = renderHtml(
      base({
        status: "pass",
        assertions: [],
        summary: "共 1 个场景，通过 1 个",
        scenarios: [
          { name: "A", status: "pass", steps: [], trace: [], assertions: [] },
        ],
      }),
    );
    assert.ok(!html.includes("跳过 0 步"));
    assert.ok(!html.includes("摘要: 回放"));
  });

  test("lang 跟随当前语种", () => {
    const prev = getLocale();
    try {
      setLocale("zh");
      assert.ok(renderHtml(base()).includes('<html lang="zh">'));
      setLocale("en");
      assert.ok(renderHtml(base()).includes('<html lang="en">'));
    } finally {
      setLocale(prev);
    }
  });

  test("HTML 标题不带 === 装饰，h1 与页签一致", () => {
    const html = renderHtml(base());
    assert.ok(html.includes("<title>页面测试报告</title>"));
    assert.ok(html.includes("<h1>页面测试报告"));
    assert.ok(!html.includes("<title>==="));
    assert.ok(!html.includes("<h1>==="));
  });

  // 报告抬头要说清「这是哪条用例的报告」（2026-10-20 反馈：直接用「<用例名>-测试报告」）。
  // 单场景、套件都用同一个名字：套件里各场景名太长，堆在页签里反而看不出重点。
  test("带用例名 → 页签与 h1 都是「<用例名>-测试报告」", () => {
    const html = renderHtml(base({ caseName: "钉钉推送日志用例" }));
    assert.ok(html.includes("<title>钉钉推送日志用例-测试报告</title>"));
    assert.ok(html.includes("<h1>钉钉推送日志用例-测试报告"));
    assert.ok(!html.includes("<h1>页面测试报告"));
  });

  test("套件也只用用例名，不把各场景名堆进标题", () => {
    const html = renderHtml(
      base({
        caseName: "钉钉推送日志用例",
        scenarios: [
          { name: "D1 很长很长的场景名", status: "pass", steps: [], trace: [], assertions: [] },
          { name: "D2 另一个场景", status: "fail", steps: [], trace: [], assertions: [] },
        ],
      }),
    );
    assert.ok(html.includes("<title>钉钉推送日志用例-测试报告</title>"));
    // 场景名仍然逐节出现在正文里
    assert.ok(html.includes("D1 很长很长的场景名"));
  });

  test("用例名里的 HTML 字符照样转义（名字来自用例文件，不可信）", () => {
    const html = renderHtml(base({ caseName: "<script>alert(1)</script>" }));
    assert.ok(!html.includes("<title><script>alert(1)</script>"));
    assert.ok(html.includes("&lt;script&gt;"));
  });

  test("套件文档标题用套件名且无 ===", () => {
    const html = renderHtml(
      base({ scenarios: [], assertions: [], summary: "共 0 个场景，通过 0 个" }),
    );
    assert.ok(html.includes("<title>页面测试套件报告</title>"));
    assert.ok(!html.includes("<h1>==="));
  });

  test("单场景节标题用「用例明细」，耗时不挤掉标题", () => {
    const html = renderHtml(base({ durationMs: 1234, trace: ["[tool] navigate"] }));
    assert.ok(html.includes("<h2>用例明细"));
    assert.ok(html.includes("耗时: 1.2s"));
    assert.ok(!html.includes("<h2>==="));
    assert.ok(!html.includes("<h2>耗时:"));
  });
});

describe("escapeHtml / formatDurationMs", () => {
  test("escapeHtml 转义五个危险字符", () => {
    assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });

  test("formatDurationMs 分钟与秒", () => {
    assert.equal(formatDurationMs(1234), "1.2s");
    assert.equal(formatDurationMs(900), "0.9s");
    assert.equal(formatDurationMs(65_000), "1m5s");
  });
});

describe("htmlReportFilePath", () => {
  // 报告名就是「<用例名>-测试报告」：同一条用例永远落在同一个文件上（2026-10-20 反馈）。
  test("用例名 + 测试报告，默认放在 pageqa-report 下", () => {
    assert.equal(
      htmlReportFilePath(undefined, "钉钉推送日志用例").replace(/\\/g, "/"),
      "pageqa-report/钉钉推送日志用例-测试报告.html",
    );
    assert.equal(
      htmlReportFilePath("out", "plm-material-drawing-no").replace(/\\/g, "/"),
      "out/plm-material-drawing-no-测试报告.html",
    );
  });

  test("没有用例名时只剩「测试报告.html」", () => {
    assert.equal(
      htmlReportFilePath().replace(/\\/g, "/"),
      "pageqa-report/测试报告.html",
    );
  });

  test("非法文件名字符被换掉，超长被截断", () => {
    const bad = htmlReportFilePath(undefined, 'a/b\\c:d*e?f"g<h>i|j');
    const name = bad.replace(/\\/g, "/").split("/").at(-1);
    assert.equal(bad.replace(/\\/g, "/").split("/").length, 2, "不能多出一层目录");
    assert.ok(!/[\\/:*?"<>|]/.test(name), `文件名仍含非法字符：${name}`);
    assert.ok(name.endsWith("-测试报告.html"));
    assert.ok(
      htmlReportFilePath(undefined, "x".repeat(200)).split(/[\\/]/).at(-1).length <=
        60 + "-测试报告.html".length,
    );
    assert.ok(
      htmlReportFilePath(undefined, "   ").replace(/\\/g, "/").endsWith("/测试报告.html"),
    );
  });
});

describe("caseNameFromText / caseNameFromPath / caseNameFromFile", () => {
  test("用例文件的 H1 就是用例名（文件名是拼音/英文时尤其重要）", () => {
    assert.equal(
      caseNameFromText("# 钉钉推送日志用例\n\n正文…\n"),
      "钉钉推送日志用例",
    );
    assert.equal(
      caseNameFromText("> 说明\n\n#   PLM 新建物料并核对列表图号  \n"),
      "PLM 新建物料并核对列表图号",
    );
  });

  test("没有 H1 / H1 是空的 → undefined（不拿 ## 场景标题或空串顶替）", () => {
    assert.equal(caseNameFromText("## 场景一\n步骤"), undefined);
    assert.equal(caseNameFromText("#\n# \n"), undefined);
    assert.equal(caseNameFromText(""), undefined);
    assert.equal(caseNameFromText(null), undefined);
  });

  test("路径：用 .md 去扩展名，回放脚本的 .replay.json 整段去掉", () => {
    assert.equal(
      caseNameFromPath("C:/Users/dll/Desktop/plm-material-drawing-no.md"),
      "plm-material-drawing-no",
    );
    assert.equal(caseNameFromPath("examples/smoke.md"), "smoke");
    assert.equal(
      caseNameFromPath("C:/x/plm-material-drawing-no.replay.json"),
      "plm-material-drawing-no",
    );
  });

  test("路径取不到名字时返回 undefined", () => {
    assert.equal(caseNameFromPath(""), undefined);
    assert.equal(caseNameFromPath("   "), undefined);
    assert.equal(caseNameFromPath(null), undefined);
    assert.equal(caseNameFromPath(".md"), undefined);
  });

  test("从文件读：读得到 H1 就用 H1，读不到（文件没了）退回文件名", () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-case-"));
    try {
      const p = join(dir, "dingtalk-log.md");
      writeFileSync(p, "# 钉钉推送日志用例\n\n## D1 场景\n", "utf8");
      assert.equal(caseNameFromFile(p), "钉钉推送日志用例");
      assert.equal(caseNameFromFile(join(dir, "gone.md")), "gone");
      assert.equal(caseNameFromFile(null), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reportTitle", () => {
  test("用例名 + 测试报告（与文件名同源，产物清单里的路径与打开后的抬头一致）", () => {
    assert.equal(reportTitle(base({ caseName: "钉钉推送日志用例" })), "钉钉推送日志用例-测试报告");
  });

  test("没有用例名时返回空串：渲染层据此退回通用标题", () => {
    assert.equal(reportTitle(base()), "");
    assert.equal(reportTitle(base({ caseName: "  " })), "");
  });
});

describe("writeHtmlReport", () => {
  test("自动建目录，内容为 renderHtml 输出", () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-html-"));
    try {
      const report = base({ durationMs: 500 });
      const { path } = writeHtmlReport(report, dir);
      assert.equal(path, htmlReportFilePath(dir));
      assert.ok(existsSync(path));
      const html = readFileSync(path, "utf8");
      assert.ok(html.includes("PASS"));
      assert.ok(html.includes("标题包含 pageqa"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("报告自带 caseName 时文件名跟着它走（旁路产物只传 report，不额外传名字）", () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-html-"));
    try {
      const { path } = writeHtmlReport(base({ caseName: "钉钉推送日志用例" }), dir);
      assert.ok(path.replace(/\\/g, "/").endsWith("/钉钉推送日志用例-测试报告.html"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 缺陷（ADR-0022）──
describe("缺陷展示", () => {
  const defect = {
    title: "保存后列表未刷新",
    severity: "critical",
    kind: "functional",
    expectation: "列表出现新记录",
    actual: "列表仍是旧数据",
    evidence: "截图见本次运行",
  };

  test("缺陷表带严重度与类型，标题按 HTML 转义", () => {
    const html = renderHtml(
      base({
        status: "pass",
        defects: [{ ...defect, title: '<script>alert("x")</script>' }],
      }),
    );
    assert.ok(html.includes('class="defects"'));
    assert.ok(html.includes("严重"));
    assert.ok(html.includes("功能"));
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(!html.includes('<script>alert("x")</script>'));
  });

  test("PASS 带缺陷时统计里出现缺陷计数（不能只看「通过」）", () => {
    const html = renderHtml(base({ status: "pass", defects: [defect] }));
    assert.ok(html.includes("<b>1</b>缺陷"));
  });

  test("套件只在顶部渲染一份缺陷表，场景节不重复", () => {
    const html = renderHtml(
      base({
        status: "pass",
        assertions: [],
        defects: [{ ...defect, scenario: "场景A" }],
        scenarios: [
          { name: "场景A", status: "pass", steps: [], trace: [], assertions: [] },
        ],
      }),
    );
    assert.equal(html.split('class="defects"').length - 1, 1);
    assert.ok(html.includes("场景A"));
  });

  test("FAIL 且没有缺陷时说明「未识别为产品缺陷」", () => {
    const html = renderHtml(base({ status: "fail", defects: undefined }));
    assert.ok(html.includes("未识别为产品缺陷"));
    assert.ok(!html.includes('class="defects"'));
  });
});
