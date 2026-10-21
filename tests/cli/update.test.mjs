import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, runUpdate } from "../../dist/update.js";

function makeDeps(overrides = {}) {
  const out = [];
  const err = [];
  let installs = 0;
  let latestCalls = 0;
  const deps = {
    currentVersion: () => overrides.current ?? "0.15.0",
    latestVersion: async () => {
      latestCalls += 1;
      if (overrides.latestError) throw overrides.latestError;
      return overrides.latest ?? "0.16.0";
    },
    install: async () => {
      installs += 1;
      return overrides.installCode ?? 0;
    },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return {
    deps,
    out,
    err,
    installs: () => installs,
    latestCalls: () => latestCalls,
  };
}

describe("pageqa update", () => {
  test("有新版本时执行安装", async () => {
    const h = makeDeps();
    const code = await runUpdate(
      { check: false, json: false, help: false },
      h.deps,
    );
    assert.equal(code, 0);
    assert.equal(h.installs(), 1);
    assert.ok(h.out.some((line) => line.includes("0.15.0") && line.includes("0.16.0")));
  });

  test("已是最新版本时不安装", async () => {
    const h = makeDeps({ latest: "0.15.0" });
    const code = await runUpdate(
      { check: false, json: false, help: false },
      h.deps,
    );
    assert.equal(code, 0);
    assert.equal(h.installs(), 0);
  });

  test("--check 只检查，不安装", async () => {
    const h = makeDeps();
    const code = await runUpdate(
      { check: true, json: false, help: false },
      h.deps,
    );
    assert.equal(code, 0);
    assert.equal(h.installs(), 0);
    assert.ok(h.out.some((line) => line.includes("0.16.0")));
  });

  test("--json 输出机器可读结果且不安装", async () => {
    const h = makeDeps();
    const code = await runUpdate(
      { check: true, json: true, help: false },
      h.deps,
    );
    assert.equal(code, 0);
    assert.equal(h.installs(), 0);
    const parsed = JSON.parse(h.out.join(""));
    assert.deepEqual(parsed, {
      current: "0.15.0",
      latest: "0.16.0",
      updateAvailable: true,
    });
  });

  test("安装失败与查询失败都返回 1", async () => {
    const failed = makeDeps({ installCode: 1 });
    assert.equal(
      await runUpdate({ check: false, json: false, help: false }, failed.deps),
      1,
    );
    assert.ok(failed.err.length > 0);

    const offline = makeDeps({ latestError: new Error("offline") });
    assert.equal(
      await runUpdate({ check: false, json: false, help: false }, offline.deps),
      1,
    );
    assert.ok(offline.err.some((line) => line.includes("offline")));
  });

  test("当前版本未知时不冒险安装；help 不查版本", async () => {
    const unknown = makeDeps({ current: "unknown" });
    assert.equal(
      await runUpdate({ check: false, json: false, help: false }, unknown.deps),
      0,
    );
    assert.equal(unknown.installs(), 0);

    const help = makeDeps();
    assert.equal(
      await runUpdate({ check: false, json: false, help: true }, help.deps),
      0,
    );
    assert.equal(help.latestCalls(), 0);
  });

  test("版本比较", () => {
    assert.equal(compareVersions("0.16.0", "0.15.0"), 1);
    assert.equal(compareVersions("0.15.0", "0.15.0"), 0);
    assert.equal(compareVersions("0.9.0", "0.15.0"), -1);
    assert.equal(compareVersions("v0.16.0", "0.15.0"), 1);
    assert.equal(compareVersions("bad", "0.15.0"), 0);
  });
});
