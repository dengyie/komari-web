/**
 * 挖矿管控 RPC 契约解释与任务结果轮询（无 React 依赖）。
 * Hub admin:miningControl 会分区返回 sent / queued / failed / offline；
 * 前端必须先消费这些字段，再决定是否轮询 getTaskResultsByTaskId。
 */

export const MINING_TASK_RESULT_POLL_MS = 2000;
export const MINING_TASK_RESULT_POLL_MAX = 15; // 首次立即查询 + 14 次间隔，覆盖 ~30s
export const JSONRPC_NOT_FOUND = -32044;

export type MiningControlResp = {
  task_id?: string;
  action?: string;
  clients?: string[];
  sent_clients?: string[];
  queued_clients?: string[];
  offline_clients?: string[];
  failed_clients?: string[];
};

export type MiningTaskResult = {
  client?: string;
  result?: string;
  exit_code?: number;
};

export type MiningControlOutcome =
  | { kind: "poll"; taskId: string }
  | { kind: "queued"; taskId: string }
  | { kind: "failed"; reason: "offline" | "dispatch" | "no_task_id" };

export type MiningPollOutcome =
  | { kind: "result"; exitCode: number; message: string }
  | { kind: "timeout" };

export type MiningTaskRpcCall = (
  method: string,
  params: { task_id: string },
) => Promise<MiningTaskResult[] | null | undefined>;

export function includesClient(list: string[] | undefined, uuid: string): boolean {
  return Array.isArray(list) && list.includes(uuid);
}

export function interpretMiningControlResp(
  resp: MiningControlResp | null | undefined,
  uuid: string,
): MiningControlOutcome {
  if (!resp?.task_id) return { kind: "failed", reason: "no_task_id" };
  if (includesClient(resp.failed_clients, uuid) || includesClient(resp.offline_clients, uuid)) {
    return { kind: "failed", reason: includesClient(resp.offline_clients, uuid) ? "offline" : "dispatch" };
  }
  if (includesClient(resp.queued_clients, uuid) && !includesClient(resp.sent_clients, uuid)) {
    return { kind: "queued", taskId: resp.task_id };
  }
  return { kind: "poll", taskId: resp.task_id };
}

export function isJsonRpcNotFound(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(`RPC Error ${JSONRPC_NOT_FOUND}`) ||
    /No results found for this task/i.test(message)
  );
}

export function sanitizeMiningTaskMessage(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\0/g, "").trim().slice(0, 200);
}

export async function pollMiningTaskResult(
  call: MiningTaskRpcCall,
  uuid: string,
  taskId: string,
  options?: {
    intervalMs?: number;
    maxAttempts?: number;
    isAlive?: () => boolean;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<MiningPollOutcome> {
  const intervalMs = options?.intervalMs ?? MINING_TASK_RESULT_POLL_MS;
  const maxAttempts = options?.maxAttempts ?? MINING_TASK_RESULT_POLL_MAX;
  const isAlive = options?.isAlive ?? (() => true);
  const sleep = options?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await sleep(intervalMs);
    if (!isAlive()) return { kind: "timeout" };
    try {
      const results = await call("admin:getTaskResultsByTaskId", { task_id: taskId });
      const mine = (results ?? []).find((r) => r?.client === uuid);
      if (mine) {
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
