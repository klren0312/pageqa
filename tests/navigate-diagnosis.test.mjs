import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  diagnoseNavigateFailure,
  extractBrowserErrorCode,
  isLocalTarget,
  readErrorText,
} from "../dist/bsk/navigate-diagnosis.js";

// 纯单元测试：不依赖浏览器与 LLM。
//
// 下面这些错误文本是**实测抓取的真实输出**（bsk 0.3.0 / protocol 1.3），
// 不是照着猜的格式——这类诊断层最容易在「格式猜错」上静默失效。

/** 本机未监听的端口（实测：http://127.0.0.1:18888/ 与 http://localhost:18888/...）。 */
const REFUSED_STDERR = [
  "error: browser rejected the underlying CDP call",
  "hint: confirm the tab is still in a loaded state and retry; reloading the tab usually resets a stuck DevTools session",
  "details: Page.navigate rejected: net::ERR_CONNECTION_REFUSED",
].join("\n");

/** Chrome 拒绝的低位端口（实测：http://127.0.0.1:1/）。 */
const UNSAFE_PORT_STDERR = [
  "error: browser rejected the underlying CDP call",
  "hint: confirm the tab is still in a loaded state and retry; reloading the tab usually resets a stuck DevTools session",
  "details: Page.navigate rejected: net::ERR_UNSAFE_PORT",
].join("\n");

describe("navigate 失败的诊断", () => {
  test("本机端口未监听：指出是本机、给出下一步，且不再重复 bsk 那句劝人重试的 hint", () => {
    const text = diagnoseNavigateFailure(
      "http://localhost:18888/smoke-test-page.html",
      REFUSED_STDERR,
    );
    assert.ok(text);
    assert.match(text, /连接被拒绝/);
    assert.match(text, /net::ERR_CONNECTION_REFUSED/);
    assert.match(text, /这是本机地址/);
    assert.match(text, /启动该端口的服务/);
    // 关键：bsk 的通用 hint 会诱导模型反复重试，必须消失
    assert.equal(/reloading the tab/.test(text), false);
    assert.equal(/rejected the underlying CDP call/.test(text), false);
    assert.equal(/Command failed/.test(text), false);
  });

  test("翻译后的消息足够短，不会被日志/轨迹的截断切掉关键信息", () => {
    const text = diagnoseNavigateFailure(
      "http://localhost:18888/smoke-test-page.html",
      REFUSED_STDERR,
    );
    // agent.ts 的 clipOneLine 上限是 160，且它会把换行压成空格
    const oneLine = text.replace(/\s+/g, " ");
    assert.ok(
      oneLine.length < 160,
      `翻译后 ${oneLine.length} 字符，会被截断：${oneLine}`,
    );
    // 截断不能吃掉错误码
    assert.ok(oneLine.includes("net::ERR_CONNECTION_REFUSED"));
  });

  test("远程地址不说「这是本机地址」", () => {
    const text = diagnoseNavigateFailure(
      "https://example.com/page",
      REFUSED_STDERR,
    );
    assert.ok(text);
    assert.match(text, /连接被拒绝/);
    assert.equal(/这是本机地址/.test(text), false);
    assert.match(text, /确认目标服务已启动/);
  });

  test("不安全端口给出确切的解释与做法", () => {
    const text = diagnoseNavigateFailure("http://127.0.0.1:1/", UNSAFE_PORT_STDERR);
    assert.ok(text);
    assert.match(text, /不安全端口/);
    assert.match(text, /net::ERR_UNSAFE_PORT/);
  });

  test("证书类按家族解释（不逐个枚举码）", () => {
    const text = diagnoseNavigateFailure(
      "https://self-signed.example/",
      "details: Page.navigate rejected: net::ERR_CERT_DATE_INVALID",
    );
    assert.ok(text);
    assert.match(text, /证书/);
    assert.match(text, /net::ERR_CERT_DATE_INVALID/);
  });

  test("未收录的错误码：如实说未收录并保留原始信息，绝不编一个解释", () => {
    const raw =
      "details: Page.navigate rejected: net::ERR_SOMETHING_BRAND_NEW";
    const text = diagnoseNavigateFailure("http://example.com/", raw);
    assert.ok(text);
    assert.match(text, /尚未收录/);
    assert.match(text, /net::ERR_SOMETHING_BRAND_NEW/);
    assert.match(text, /Page\.navigate rejected/);
  });

  test("完全没有浏览器错误码时返回 null（交给调用方原样抛出，一个字都不加工）", () => {
    assert.equal(diagnoseNavigateFailure("http://example.com/", "error: session not found"), null);
    assert.equal(diagnoseNavigateFailure("http://example.com/", "Tool bsk not found"), null);
    assert.equal(diagnoseNavigateFailure("http://example.com/", ""), null);
    // 超时是 pageqa 自己给的文案（bsk 进程超时），不该被浏览器错误码那套解释
    assert.equal(
      diagnoseNavigateFailure(
        "http://example.com/",
        "bsk 命令执行超时（60s）：可能 bsk daemon 未启动或未连接浏览器。",
      ),
      null,
    );
  });
});

describe("错误码与错误文本的提取", () => {
  test("从 bsk 的三段式输出里取到错误码", () => {
    assert.equal(
      extractBrowserErrorCode(REFUSED_STDERR),
      "ERR_CONNECTION_REFUSED",
    );
    assert.equal(extractBrowserErrorCode(UNSAFE_PORT_STDERR), "ERR_UNSAFE_PORT");
    assert.equal(extractBrowserErrorCode("no code here"), null);
  });

  test("readErrorText 优先用 stderr（err.message 只是 Command failed 加 stderr 的拼接）", () => {
    const err = Object.assign(new Error("Command failed: bsk navigate …"), {
      stderr: REFUSED_STDERR,
    });
    assert.equal(readErrorText(err), REFUSED_STDERR);
    // 没有 stderr 时退回 message
    assert.equal(readErrorText(new Error("boom")), "boom");
    assert.equal(readErrorText("plain"), "plain");
    assert.equal(readErrorText(undefined), "undefined");
  });

  test("isLocalTarget 认得出本机地址，非法 URL 不抛错", () => {
    for (const url of [
      "http://localhost:18888/x",
      "http://127.0.0.1:1/",
      "http://[::1]:8080/",
      "http://app.localhost/",
    ]) {
      assert.equal(isLocalTarget(url), true, url);
    }
    for (const url of ["https://example.com/", "http://192.168.1.10/", "不是 URL"]) {
      assert.equal(isLocalTarget(url), false, url);
    }
  });
});
