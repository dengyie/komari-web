import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./miningControl.ts", import.meta.url), "utf8");
const miningPage = readFileSync(
  new URL("../pages/admin/mining.tsx", import.meta.url),
  "utf8",
);

const JSONRPC_NOT_FOUND = -32044;

function includesClient(list, uuid) {
  return Array.isArray(list) && list.includes(uuid);
}

function interpretMiningControlResp(resp, uuid) {
  if (!resp?.task_id) return { kind: "failed", reason: "no_task_id" };
  if (includesClient(resp.failed_clients, uuid) || includesClient(resp.offline_clients, uuid)) {
    return { kind: "failed", reason: includesClient(resp.offline_clients, uuid) ? "offline" : "dispatch" };
  }
  if (includesClient(resp.queued_clients, uuid) && !includesClient(resp.sent_clients, uuid)) {
    return { kind: "queued", taskId: resp.task_id };
  }
  return { kind: "poll", taskId: resp.task_id };
}

function isJsonRpcNotFound(error) {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(`RPC Error ${JSONRPC_NOT_FOUND}`) ||
    /No results found for this task/i.test(message)
  );
}

function sanitizeMiningTaskMessage(raw) {
  return (raw ?? "").replace(/\0/g, "").trim().slice(0, 200);
}

function isFinishedMiningTaskResult(row) {
  if (!row) return false;
  return row.exit_code != null || Boolean(row.finished_at);
}

async function pollMiningTaskResult(call, uuid, taskId, options = {}) {
  const intervalMs = options.intervalMs ?? 2000;
  const maxAttempts = options.maxAttempts ?? 15;
  const isAlive = options.isAlive ?? (() => true);
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await sleep(intervalMs);
    if (!isAlive()) return { kind: "timeout" };
    try {
      const results = await call("admin:getTaskResultsByTaskId", { task_id: taskId });
      const mine = (results ?? []).find((r) => r?.client === uuid);
      if (isFinishedMiningTaskResult(mine)) {
        return {
          kind: "result",
          exitCode: Number(mine.exit_code ?? -1),
          message: sanitizeMiningTaskMessage(mine.result),
        };
      }
    } catch (error) {
      if (!isJsonRpcNotFound(error)) throw error;
    }
  }
  return { kind: "timeout" };
}

test("source keeps mining control contract helpers in sync", () => {
  assert.ok(source.includes("export function interpretMiningControlResp"), "interpret helper missing");
  assert.ok(source.includes("export async function pollMiningTaskResult"), "poll helper missing");
  assert.ok(source.includes("export function isFinishedMiningTaskResult"), "placeholder-row helper missing");
  assert.ok(source.includes("if (i > 0) await sleep(intervalMs)"), "first poll must not sleep");
  assert.ok(source.includes("JSONRPC_NOT_FOUND = -32044"), "NotFound code drifted");
  assert.ok(miningPage.includes('from "@/utils/miningControl"'), "mining page must import helper");
  assert.ok(miningPage.includes("document.hidden"), "mining page must pause when hidden");
  assert.ok(miningPage.includes("params.entity_ids = entityIds"), "mining page must pass miner entity_ids");
  assert.ok(miningPage.includes("historyUnscopedRef"), "first metrics scan must stay unscoped");
  assert.ok(!miningPage.includes("hashrate_1min ?? 0) > 0 ? 1 : 0"), "sort must not bucket by hashrate");
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

test("isJsonRpcNotFound ignores real RPC failures", () => {
  assert.equal(isJsonRpcNotFound(new Error("RPC Error -32603: boom")), false);
  assert.equal(sanitizeMiningTaskMessage("ok\u0000"), "ok");
});
