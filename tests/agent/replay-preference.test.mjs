import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFreshReplay } from "../../dist/agent/replay-preference.js";
import {
  REPLAY_FORMAT,
  REPLAY_VERSION,
  scriptHash,
} from "../../dist/agent/replay.js";

const CASE = "## 登录\n打开 https://example.com\n断言页面包含 Example";

function makeScript(casePath, caseText, overrides = {}) {
  return {
    format: REPLAY_FORMAT,
    version: REPLAY_VERSION,
    recordedAt: new Date().toISOString(),
    source: { path: casePath, hash: scriptHash(caseText) },
    scenarios: [
      {
        name: "登录",
        caseSteps: ["打开 https://example.com"],
        steps: [{ kind: "navigate", step: 1, url: "https://example.com" }],
      },
    ],
    ...overrides,
  };
}

describe("--prefer-replay 的脚本匹配", () => {
  test("源路径一致且哈希未变：命中", () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-prefer-replay-"));
    try {
      const casePath = join(dir, "case.md");
      const scriptPath = join(dir, "case.replay.json");
      writeFileSync(casePath, CASE, "utf8");
      writeFileSync(scriptPath, JSON.stringify(makeScript(casePath, CASE)), "utf8");

      const found = findFreshReplay(casePath, scriptPath);
      assert.equal(found.kind, "use");
      assert.equal(found.path, scriptPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("用例已变更、没有脚本、没有哈希、来源不同都回退", () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-prefer-replay-"));
    try {
      const casePath = join(dir, "case.md");
      const scriptPath = join(dir, "case.replay.json");
      writeFileSync(casePath, CASE, "utf8");

      assert.equal(findFreshReplay(casePath, scriptPath).kind, "skip");

      writeFileSync(scriptPath, JSON.stringify(makeScript(casePath, CASE)), "utf8");
      writeFileSync(casePath, CASE + "\n断言页面包含 More", "utf8");
      const stale = findFreshReplay(casePath, scriptPath);
      assert.equal(stale.kind, "skip");
      assert.ok(stale.reason.length > 0);

      writeFileSync(
        scriptPath,
        JSON.stringify(
          makeScript(casePath, CASE, {
            source: { path: join(dir, "other.md"), hash: scriptHash(CASE) },
          }),
        ),
        "utf8",
      );
      assert.equal(findFreshReplay(casePath, scriptPath).kind, "skip");

      writeFileSync(
        scriptPath,
        JSON.stringify(
          makeScript(casePath, CASE, { source: { path: casePath, hash: null } }),
        ),
        "utf8",
      );
      assert.equal(findFreshReplay(casePath, scriptPath).kind, "skip");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("脚本结构不合法时回退，而不是抛错", () => {
    const dir = mkdtempSync(join(tmpdir(), "pageqa-prefer-replay-"));
    try {
      const casePath = join(dir, "case.md");
      const scriptPath = join(dir, "case.replay.json");
      writeFileSync(casePath, CASE, "utf8");
      writeFileSync(scriptPath, "not json", "utf8");

      const found = findFreshReplay(casePath, scriptPath);
      assert.equal(found.kind, "skip");
      assert.ok(found.reason.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
