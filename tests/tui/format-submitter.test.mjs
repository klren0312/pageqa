import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FormatSubmitter } from "../../dist/tui/format-submitter.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("格式化提交的串行队列", () => {
  test("按提交顺序串行执行，size 包含在飞与排队", async () => {
    const events = [];
    let release;
    let markStarted;
    const gate = new Promise((resolve) => (release = resolve));
    const started = new Promise((resolve) => (markStarted = resolve));
    const submitter = new FormatSubmitter();

    const first = submitter.submit(async () => {
      events.push("first:start");
      markStarted();
      await gate;
      events.push("first:end");
    });
    const second = submitter.submit(async () => {
      events.push("second");
    });

    await started;
    assert.deepEqual(events, ["first:start"]);
    assert.equal(submitter.size, 2);

    release();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["first:start", "first:end", "second"]);
    assert.equal(submitter.size, 0);
  });

  test("cancelAll 取消在飞与排队任务，且不触发 onError", async () => {
    const events = [];
    const errors = [];
    let markStarted;
    const started = new Promise((resolve) => (markStarted = resolve));
    const submitter = new FormatSubmitter();

    const first = submitter.submit(
      async (signal) => {
        events.push("first");
        markStarted();
        await new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
        events.push("never");
      },
      (error) => errors.push(error),
    );
    const second = submitter.submit(async () => {
      events.push("second");
    });

    await started;
    assert.equal(submitter.size, 2);
    assert.equal(submitter.cancelAll(new Error("cancel")), 2);
    assert.equal(submitter.size, 0);

    await Promise.all([first, second]);
    assert.deepEqual(events, ["first"]);
    assert.deepEqual(errors, []);
  });

  test("已取消但还没开始的提交不会调用 run", async () => {
    const events = [];
    const submitter = new FormatSubmitter();
    const job = submitter.submit(async () => {
      events.push("run");
    });

    assert.equal(submitter.cancelAll(), 1);
    await job;
    assert.deepEqual(events, []);
  });

  test("任务抛错交给 onError，后续提交继续执行", async () => {
    const errors = [];
    const events = [];
    const submitter = new FormatSubmitter();

    const first = submitter.submit(
      async () => {
        throw new Error("boom");
      },
      (error) => errors.push(error.message),
    );
    const second = submitter.submit(async () => {
      events.push("next");
    });

    await Promise.all([first, second]);
    assert.deepEqual(errors, ["boom"]);
    assert.deepEqual(events, ["next"]);
    assert.equal(submitter.size, 0);
  });

  test("onChange 在提交、收尾与取消时刷新", async () => {
    let changes = 0;
    const submitter = new FormatSubmitter(() => {
      changes += 1;
    });

    await submitter.submit(async () => {});
    assert.equal(changes, 2);

    const pending = submitter.submit(async (signal) => {
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    });
    await tick();
    submitter.cancelAll();
    await pending;
    assert.ok(changes >= 4);
  });
});
