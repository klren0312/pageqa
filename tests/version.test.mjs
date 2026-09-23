import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { packageVersion } from "../dist/version.js";

describe("packageVersion", () => {
  test("读到的就是包根 package.json 的 version", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    assert.equal(packageVersion(), pkg.version);
  });

  test("是形如 x.y.z 的版本号，而不是读失败时的 unknown", () => {
    assert.match(packageVersion(), /^\d+\.\d+\.\d+/);
  });
});
