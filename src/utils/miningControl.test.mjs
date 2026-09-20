import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  interpretMiningControlResp,
  isFinishedMiningTaskResult,
  isJsonRpcNotFound,
  pollMiningTaskResult,
  sanitizeMiningTaskMessage,
} from "./miningControl.ts";

const miningPage = readFileSync(
  new URL("../pages/admin/mining.tsx", import.meta.url),
  "utf8",
);

test("mining page stays wired to the shared helper", () => {
  assert.ok(miningPage.includes('from "@/utils/miningControl"'), "mining page must import helper");
  assert.ok(miningPage.includes("document.hidden"), "mining page must pause when hidden");
  assert.ok(miningPage.includes("params.entity_ids = entityIds"), "mining page must pass miner entity_ids");
  assert.ok(miningPage.includes("historyUnscopedRef"), "first metrics scan must stay unscoped");
  assert.ok(!miningPage.includes("hashrate_1min ?? 0) > 0 ? 1 : 0"), "sort must not bucket by hashrate");
});

test("isFinishedMiningTaskResult waits for CreateTask placeholders", () => {
  assert.equal(isFinishedMiningTaskResult(null), false);
  assert.equal(isFinishedMiningTaskResult(undefined), false);
  assert.equal(
    isFinishedMiningTaskResult({ client: "a", result: "", exit_code: null, finished_at: null }),
    false,
  );
  assert.equal(isFinishedMiningTaskResult({ client: "a", exit_code: 0 }), true);
  assert.equal(isFinishedMiningTaskResult({ client: "a", exit_code: -1 }), true);
  assert.equal(
    isFinishedMiningTaskResult({ client: "a", finished_at: "2026-09-21T00:54:09Z" }),
    true,
  );
});

test("interpretMiningControlResp fails immediately for offline/failed/no task", () => {
  assert.deepEqual(interpretMiningControlResp(null, "a"), { kind: "failed", reason: "no_task_id" });
  assert.deepEqual(
    interpretMiningControlResp({ task_id: "t1", offline_clients: ["a"] }, "a"),
    { kind: "failed", reason: "offline" },
  );
  assert.deepEqual(
    interpretMiningControlResp({ task_id: "t1", failed_clients: ["a"] }, "a"),
    { kind: "failed", reason: "dispatch" },
  );
});

test("interpretMiningControlResp queues reconnecting clients and polls sent clients", () => {
  assert.deepEqual(
    interpretMiningControlResp({ task_id: "t1", queued_clients: ["a"] }, "a"),
    { kind: "queued", taskId: "t1" },
  );
  assert.deepEqual(
    interpretMiningControlResp({ task_id: "t1", sent_clients: ["a"], queued_clients: ["a"] }, "a"),
    { kind: "poll", taskId: "t1" },
  );
  assert.deepEqual(
    interpretMiningControlResp({ task_id: "t1", sent_clients: ["a"] }, "a"),
    { kind: "poll", taskId: "t1" },
  );
});

test("pollMiningTaskResult queries immediately then retries NotFound until result", async () => {
  let calls = 0;
  const sleeps = [];
  const outcome = await pollMiningTaskResult(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error("RPC Error -32044: No results found for this task");
      return [{ client: "a", result: "ok\u0000", exit_code: 0 }];
    },
    "a",
    "task-1",
    {
      maxAttempts: 3,
      intervalMs: 5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [5]);
  assert.deepEqual(outcome, { kind: "result", exitCode: 0, message: "ok" });
});

test("pollMiningTaskResult ignores unfinished CreateTask placeholder rows", async () => {
  let calls = 0;
  const outcome = await pollMiningTaskResult(
    async () => {
      calls += 1;
      if (calls === 1) {
        return [{ client: "a", result: "", exit_code: null, finished_at: null }];
      }
      return [{ client: "a", result: "started", exit_code: 0, finished_at: "2026-09-21T00:54:09Z" }];
    },
    "a",
    "task-1",
    { maxAttempts: 3, intervalMs: 1, sleep: async () => {} },
  );
  assert.equal(calls, 2);
  assert.deepEqual(outcome, { kind: "result", exitCode: 0, message: "started" });
});

test("pollMiningTaskResult times out if only placeholder rows appear", async () => {
  const outcome = await pollMiningTaskResult(
    async () => [{ client: "a", result: "", exit_code: null, finished_at: null }],
    "a",
    "task-1",
    { maxAttempts: 2, intervalMs: 1, sleep: async () => {} },
  );
  assert.deepEqual(outcome, { kind: "timeout" });
});

test("pollMiningTaskResult rethrows real RPC errors", async () => {
  await assert.rejects(
    () =>
      pollMiningTaskResult(
        async () => {
          throw new Error("RPC Error -32603: boom");
        },
        "a",
        "task-1",
        { maxAttempts: 1, sleep: async () => {} },
      ),
    /RPC Error -32603/,
  );
});

test("isJsonRpcNotFound ignores real RPC failures", () => {
  assert.equal(isJsonRpcNotFound(new Error("RPC Error -32603: boom")), false);
  assert.equal(isJsonRpcNotFound(new Error("RPC Error -32044: No results found for this task")), true);
  assert.equal(sanitizeMiningTaskMessage("ok\u0000"), "ok");
});
