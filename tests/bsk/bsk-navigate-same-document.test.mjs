import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { canonicalUrl, isSameDocumentNavigation } from "../../dist/bsk/tools.js";

// 这两条判据决定「navigate 等不到生命周期时该不该改判成功」，所以两个方向都要钉：
// - 判宽了 → 真失败（被重定向、导航没完成）被当成成功，用例在一片「通过」里跑偏；
// - 判窄了 → 同文档 hash / SPA 路由切换继续白等 30s 并判死（钉钉日志用例的实测现场）。

describe("isSameDocumentNavigation：同源 + 同 path/query 才算同文档", () => {
  test("只差 hash：同文档（浏览器不会产生新的文档加载）", () => {
    assert.equal(
      isSameDocumentNavigation("https://a.com/app", "https://a.com/app#/form1"),
      true,
    );
    assert.equal(
      isSameDocumentNavigation("https://a.com/app#/form1", "https://a.com/app#/form2"),
      true,
    );
    // 完全相等也是
    assert.equal(isSameDocumentNavigation("https://a.com/app", "https://a.com/app"), true);
  });

  test("hash 路由里带 query：path/query 相同，仍算同文档", () => {
    assert.equal(
      isSameDocumentNavigation(
        "https://a.com/#/system/messages/dingtalk-log",
        "https://a.com/#/system/messages/dingtalk-log?pageNo=2",
      ),
      true,
    );
  });

  test("path 或 query 不同：不是同文档（必须真等导航）", () => {
    assert.equal(isSameDocumentNavigation("https://a.com/a", "https://a.com/b"), false);
    assert.equal(
      isSameDocumentNavigation("https://a.com/a?x=1", "https://a.com/a?x=2"),
      false,
    );
  });

  test("跨源：不是同文档", () => {
    assert.equal(isSameDocumentNavigation("https://a.com/x", "https://b.com/x"), false);
    assert.equal(
      isSameDocumentNavigation("http://a.com/x", "https://a.com/x"),
      false,
    );
  });

  test("空串一律不算（缺一侧就没法比较，不能猜成同文档）", () => {
    assert.equal(isSameDocumentNavigation("", "https://a.com/x"), false);
    assert.equal(isSameDocumentNavigation("https://a.com/x", ""), false);
    assert.equal(isSameDocumentNavigation("", ""), false);
  });

  test("解析不了的地址退回「去 hash 后字符相等」，而不是直接判否", () => {
    assert.equal(isSameDocumentNavigation("about:blank", "about:blank#x"), true);
    assert.equal(isSameDocumentNavigation("about:blank", "about:srcdoc"), false);
  });
});

describe("canonicalUrl：只归一 `#/` 与空 hash，别的一律原样", () => {
  test("空 hash 与 `#/` 视为同一个地址（SPA 首页最常见的一种）", () => {
    assert.equal(canonicalUrl("https://a.com/app#"), "https://a.com/app");
    assert.equal(canonicalUrl("https://a.com/app#/"), "https://a.com/app");
    assert.equal(
      canonicalUrl("https://a.com/app#"),
      canonicalUrl("https://a.com/app"),
      "不然「导航到 /app」之后核对当前地址 /app# 会一直对不上",
    );
  });

  test("有实义 hash 时原样保留（归一掉就会把 /a#x 与 /a#y 混成一个）", () => {
    assert.equal(canonicalUrl("https://a.com/app#/form1"), "https://a.com/app#/form1");
    assert.equal(canonicalUrl("https://a.com/app#top"), "https://a.com/app#top");
  });

  test("没有 hash 的地址原样返回；首尾空白被剥掉", () => {
    assert.equal(canonicalUrl("https://a.com/app"), "https://a.com/app");
    assert.equal(canonicalUrl("  https://a.com/app  "), "https://a.com/app");
    assert.equal(canonicalUrl(""), "");
  });
});
