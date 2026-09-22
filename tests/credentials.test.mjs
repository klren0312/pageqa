import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "../dist/auth.js";

// 纯单元测试：不依赖浏览器、LLM 与真实 TTY，也不会写用户主目录（凭据文件路径显式注入）。

const dir = mkdtempSync(join(tmpdir(), "pageqa-auth-"));
const authPath = () => join(dir, `auth-${Math.random().toString(36).slice(2)}.json`);

const apiKey = (key) => ({ type: "api_key", key });
const oauth = () => ({
  type: "oauth",
  access: "access-token",
  refresh: "refresh-token",
  expires: Date.now() + 3600_000,
});

describe("凭据存储（auth.json）", () => {
  test("文件不存在时读到空、列出为空（不因缺文件报错）", async () => {
    const store = new FileCredentialStore(authPath());
    assert.equal(await store.read("anthropic"), undefined);
    assert.deepEqual(await store.list(), []);
  });

  test("modify 写入后可读回，且落盘是合法 JSON（provider → 凭据）", async () => {
    const path = authPath();
    const store = new FileCredentialStore(path);
    await store.modify("anthropic", async () => apiKey("sk-ant-1"));

    assert.deepEqual(await store.read("anthropic"), apiKey("sk-ant-1"));
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(onDisk, { anthropic: apiKey("sk-ant-1") });
  });

  test("modify 返回 undefined 表示「不改动」，原有凭据保持不变", async () => {
    const store = new FileCredentialStore(authPath());
    await store.modify("openai", async () => apiKey("k1"));
    await store.modify("openai", async () => undefined);
    assert.deepEqual(await store.read("openai"), apiKey("k1"));
  });

  test("并发 modify 不会互相覆盖（每个 provider 都留在文件里）", async () => {
    const path = authPath();
    const store = new FileCredentialStore(path);
    await Promise.all([
      store.modify("a", async () => apiKey("1")),
      store.modify("b", async () => apiKey("2")),
      store.modify("c", async () => apiKey("3")),
    ]);
    const ids = (await store.list()).map((e) => e.providerId).sort();
    assert.deepEqual(ids, ["a", "b", "c"]);
    assert.equal(Object.keys(JSON.parse(readFileSync(path, "utf8"))).length, 3);
  });

  test("list 只给 provider 与类型，不泄露密钥值", async () => {
    const store = new FileCredentialStore(authPath());
    await store.modify("anthropic", async () => apiKey("sk-ant-secret"));
    const [entry] = await store.list();
    assert.deepEqual(entry, { providerId: "anthropic", type: "api_key" });
    assert.equal(JSON.stringify(entry).includes("sk-ant-secret"), false);
  });

  test("delete 移除指定 provider，其它 provider 不受影响", async () => {
    const path = authPath();
    const store = new FileCredentialStore(path);
    await store.modify("anthropic", async () => apiKey("a"));
    await store.modify("openai", async () => oauth());
    await store.delete("anthropic");

    assert.equal(await store.read("anthropic"), undefined);
    assert.equal((await store.read("openai")).type, "oauth");
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8"))), ["openai"]);
  });

  test("delete 不存在的 provider 不写坏文件", async () => {
    const path = authPath();
    const store = new FileCredentialStore(path);
    await store.modify("anthropic", async () => apiKey("a"));
    await store.delete("nope");
    assert.deepEqual(await store.read("anthropic"), apiKey("a"));
  });

  test("文件损坏时按「没有凭据」处理，而不是抛错（宁可要求重新登录也不崩）", async () => {
    const path = authPath();
    writeFileSync(path, "{ 这不是 JSON");
    const store = new FileCredentialStore(path);
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.read("anthropic"), undefined);
    // 损坏文件仍可被下一次写入修好。
    await store.modify("anthropic", async () => apiKey("new"));
    assert.deepEqual(await store.read("anthropic"), apiKey("new"));
  });

  test("read 返回副本：调用方改动不会污染存储里的值", async () => {
    const store = new FileCredentialStore(authPath());
    await store.modify("anthropic", async () => oauth());
    const first = await store.read("anthropic");
    first.access = "tampered";
    assert.equal((await store.read("anthropic")).access, "access-token");
  });

  test("已 abort 的 signal 立即拒绝（不落盘）", async () => {
    const store = new FileCredentialStore(authPath());
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      store.modify("anthropic", async () => apiKey("x"), {
        signal: controller.signal,
      }),
    );
    assert.deepEqual(await store.list(), []);
  });
});
