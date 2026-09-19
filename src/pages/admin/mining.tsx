import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Flex, Text } from "@radix-ui/themes";
import { useTranslation } from "react-i18next";
import { Pause, Play, Pickaxe } from "lucide-react";
import { useNodeList, type NodeBasicInfo } from "@/contexts/NodeListContext";
import { useRPC2Call } from "@/contexts/RPC2Context";
import Loading from "@/components/loading";
import Tips from "@/components/ui/tips";

type MiningLive = { algorithm?: string; hashrate_1min?: number };
type LatestStatus = Record<
  string,
  { online?: boolean; mining?: MiningLive | null }
>;

type MiningControlResp = {
  task_id: string;
  sent_clients?: string[];
  failed_clients?: string[];
};

type TaskResult = { client: string; result: string; exit_code: number };

const STATUS_POLL_MS = 4000;
const RESULT_POLL_MS = 2000;
const RESULT_POLL_MAX = 15; // ~30s,覆盖 supervisord startsecs+看门狗拉起路径

function formatHashrate(hs: number | null | undefined): string {
  if (hs == null || !isFinite(hs) || hs <= 0) return "0 H/s";
  const units = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s", "PH/s"];
  let value = hs;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

type RowState = {
  busy: "start" | "stop" | null;
  status: "success" | "failed" | null;
  message: string;
};

export default function Mining() {
  const { t } = useTranslation();
  const { call } = useRPC2Call();
  const { nodeList } = useNodeList();
  const [latest, setLatest] = useState<LatestStatus>({});
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const resp = await call<any, LatestStatus>(
        "common:getNodesLatestStatus",
        {},
      );
      if (aliveRef.current) setLatest(resp ?? {});
    } catch {
      // 4s 轮询，失败等下一轮
    }
  }, [call]);

  useEffect(() => {
    loadStatus();
    const timer = setInterval(loadStatus, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [loadStatus]);

  const pollTaskResult = useCallback(
    async (uuid: string, taskId: string) => {
      for (let i = 0; i < RESULT_POLL_MAX; i++) {
        await new Promise((r) => setTimeout(r, RESULT_POLL_MS));
        if (!aliveRef.current) return;
        try {
          const results = await call<any, TaskResult[]>(
            "admin:getTaskResultsByTaskId",
            { task_id: taskId },
          );
          const mine = (results ?? []).find((r) => r?.client === uuid);
          if (mine) {
            if (!aliveRef.current) return;
            setRows((p) => ({
              ...p,
              [uuid]: {
                busy: null,
                status: mine.exit_code === 0 ? "success" : "failed",
                message: (mine.result ?? "").trim().slice(0, 200),
              },
            }));
            return;
          }
        } catch {
          // 继续重试
        }
      }
      if (!aliveRef.current) return;
      setRows((p) => ({
        ...p,
        [uuid]: {
          busy: null,
          status: "failed",
          message: t("admin.mining.pollTimeout", "查询执行结果超时，请稍后在任务结果中查看"),
        },
      }));
    },
    [call, t],
  );

  const dispatch = useCallback(
    async (uuid: string, action: "start" | "stop") => {
      setRows((p) => ({
        ...p,
        [uuid]: { busy: action, status: null, message: "" },
      }));
      try {
        const resp = await call<any, MiningControlResp>("admin:miningControl", {
          clients: [uuid],
          action,
        });
        if (!resp?.task_id) throw new Error("no task id");
        await pollTaskResult(uuid, resp.task_id);
      } catch (e) {
        console.warn("[mining] dispatch failed:", e);
        if (!aliveRef.current) return;
        setRows((p) => ({
          ...p,
          [uuid]: {
            busy: null,
            status: "failed",
            message: t("admin.mining.dispatchFailed", "下发失败（节点不在线或 agent 不支持）"),
          },
        }));
      }
    },
    [call, pollTaskResult, t],
  );

  const miners: Array<{ info: NodeBasicInfo; online: boolean; mining: MiningLive | null }> = [];
  for (const info of nodeList ?? []) {
    const st = latest[info.uuid];
    miners.push({
      info,
      online: !!st?.online,
      mining: st?.mining ?? null,
    });
  }
  // 挖矿中的排前面，其余按名称
  miners.sort((a, b) => {
    const am = a.mining ? 1 : 0;
    const bm = b.mining ? 1 : 0;
    if (am !== bm) return bm - am;
    return (a.info.name || "").localeCompare(b.info.name || "");
  });

  const activeCount = miners.filter((m) => Number(m.mining?.hashrate_1min ?? 0) > 0).length;

  return (
    <Flex direction="column" gap="4" p="4">
      <Flex align="center" gap="3">
        <Pickaxe size={20} />
        <Text size="5" weight="bold">
          {t("admin.mining.title", "挖矿管理")}
        </Text>
        <Badge color={activeCount > 0 ? "green" : "gray"} variant="soft">
          {t("admin.mining.activeCount", "{{count}} 台在挖", {
            count: activeCount,
          })}
        </Badge>
      </Flex>
      <Tips>
        {t(
          "admin.mining.hint",
          "对节点执行中心端启停需要该节点 agent 配置 AGENT_MINER_CONTROL_CMD 模板（含 {action} 占位符）；结果由任务通道回传，约需数秒。",
        )}
      </Tips>

      <Card>
        {(nodeList ?? []).length === 0 ? (
          <Flex justify="center" p="6">
            <Loading />
          </Flex>
        ) : (
          <Flex direction="column" gap="2">
            <Flex gap="3" px="3" py="2" className="text-sm text-gray-500" align="center">
              <Text weight="medium" style={{ width: 200 }}>
                {t("admin.mining.node", "节点")}
              </Text>
              <Text weight="medium" style={{ width: 90 }}>
                {t("admin.mining.state", "状态")}
              </Text>
              <Text weight="medium" style={{ width: 120 }}>
                {t("admin.mining.algorithm", "算法")}
              </Text>
              <Text weight="medium" style={{ width: 130 }}>
                {t("admin.mining.hashrate", "算力 (1min)")}
              </Text>
              <Text weight="medium" style={{ flex: 1 }}>
                {t("admin.mining.control", "管控")}
              </Text>
            </Flex>
            {miners.map((m) => {
              const row = rows[m.info.uuid] ?? {
                busy: null,
                status: null,
                message: "",
              };
              const hs = m.mining?.hashrate_1min ?? 0;
              void hs;
              return (
                <Flex
                  key={m.info.uuid}
                  gap="3"
                  px="3"
                  py="2"
                  align="center"
                  className="border-t border-gray-100 dark:border-gray-800"
                >
                  <Text style={{ width: 200 }} truncate>
                    {m.info.name || m.info.uuid}
                  </Text>
                  <Badge
                    color={m.online ? "green" : "gray"}
                    variant="soft"
                    style={{ width: 90 }}
                  >
                    {m.online
                      ? t("admin.mining.online", "在线")
                      : t("admin.mining.offline", "离线")}
                  </Badge>
                  <Text style={{ width: 120 }}>
                    {m.mining?.algorithm || "—"}
                  </Text>
                  <Text
                    style={{ width: 130 }}
                    color={hs > 0 ? undefined : "gray"}
                  >
                    {formatHashrate(hs)}
                  </Text>
                  <Flex gap="2" align="center" style={{ flex: 1 }} wrap="wrap">
                    <Button
                      size="1"
                      variant="soft"
                      disabled={row.busy !== null}
                      onClick={() => dispatch(m.info.uuid, "start")}
                    >
                      <Play size={12} />
                      {row.busy === "start"
                        ? t("admin.mining.starting", "启动中...")
                        : t("admin.mining.start", "启动")}
                    </Button>
                    <Button
                      size="1"
                      variant="soft"
                      color="red"
                      disabled={row.busy !== null}
                      onClick={() => dispatch(m.info.uuid, "stop")}
                    >
                      <Pause size={12} />
                      {row.busy === "stop"
                        ? t("admin.mining.stopping", "暂停中...")
                        : t("admin.mining.stop", "暂停")}
                    </Button>
                    {row.status === "success" && (
                      <Text size="1" color="green" style={{ maxWidth: 360 }}>
                        {t("admin.mining.success", "指令已执行")}
                        {row.message ? `: ${row.message}` : ""}
                      </Text>
                    )}
                    {row.status === "failed" && (
                      <Text size="1" color="red" style={{ maxWidth: 360 }}>
                        {row.message ||
                          t("admin.mining.failed", "执行失败")}
                      </Text>
                    )}
                  </Flex>
                </Flex>
              );
            })}
          </Flex>
        )}
      </Card>
    </Flex>
  );
}
