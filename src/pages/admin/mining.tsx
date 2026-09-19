import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Callout,
  Flex,
  Popover,
  Separator,
  Text,
} from "@radix-ui/themes";
import { useTranslation } from "react-i18next";
import {
  Pause,
  Play,
  Pickaxe,
  Info,
  ChartNoAxesCombined,
  Activity,
} from "lucide-react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { useNodeList, type NodeBasicInfo } from "@/contexts/NodeListContext";
import { useRPC2Call } from "@/contexts/RPC2Context";
import Loading from "@/components/loading";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { cn } from "@/lib/utils";

type MiningLive = { algorithm?: string; hashrate_1min?: number };
type LatestStatus = Record<
  string,
  { online?: boolean; mining?: MiningLive | null }
>;

type MetricPoint = {
  time: string;
  value: number | null;
  count?: number;
};

type MetricSeries = {
  metric_key: string;
  entity_id: string;
  points: MetricPoint[] | null;
};

type QueryMetricsResponse = {
  series?: MetricSeries[];
};

type MiningControlResp = {
  task_id: string;
  sent_clients?: string[];
  failed_clients?: string[];
};

type TaskResult = { client: string; result: string; exit_code: number };

const STATUS_POLL_MS = 4000;
const METRICS_POLL_MS = 30000;
const RESULT_POLL_MS = 2000;
const RESULT_POLL_MAX = 15; // ~30s, 覆盖 supervisord startsecs + 看门狗拉起路径

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

/**
 * 迷你 Sparkline 走势图组件，行内展示 24h 算力轨迹并支持点击弹层看详细折线图
 */
function HashrateSparkline({
  points,
  hashrate1min,
  isOnline,
  uuid,
  nodeName,
  algorithm,
}: {
  points?: MetricPoint[];
  hashrate1min: number;
  isOnline: boolean;
  uuid: string;
  nodeName: string;
  algorithm?: string;
}) {
  const { t } = useTranslation();

  // 整理时序数据
  const chartRows = useMemo(() => {
    if (!points || points.length === 0) return [];
    return points
      .map((p) => {
        const timeNum = new Date(p.time).getTime();
        const val = p.value != null && isFinite(p.value) ? Math.max(0, p.value) : 0;
        return {
          time: timeNum,
          timeStr: new Date(p.time).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
          value: val,
        };
      })
      .sort((a, b) => a.time - b.time);
  }, [points]);

  // 统计指标
  const stats = useMemo(() => {
    if (chartRows.length === 0) {
      return { peak: hashrate1min, avg: hashrate1min };
    }
    let max = 0;
    let sum = 0;
    let count = 0;
    for (const r of chartRows) {
      if (r.value > max) max = r.value;
      sum += r.value;
      count++;
    }
    return {
      peak: Math.max(max, hashrate1min),
      avg: count > 0 ? sum / count : hashrate1min,
    };
  }, [chartRows, hashrate1min]);

  // 生成 SVG Sparkline 坐标
  const sparklineData = useMemo(() => {
    const width = 110;
    const height = 26;
    const padTop = 3;
    const padBottom = 3;
    const padX = 2;

    if (chartRows.length < 2) {
      return null;
    }

    const values = chartRows.map((r) => r.value);
    const minVal = 0;
    const maxVal = Math.max(...values, hashrate1min, 1);
    const range = maxVal - minVal || 1;

    const coords = chartRows.map((r, i) => {
      const x = padX + (i / (chartRows.length - 1)) * (width - padX * 2);
      const y =
        height - padBottom - ((r.value - minVal) / range) * (height - padTop - padBottom);
      return { x, y };
    });

    const pathD = coords
      .map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
      .join(" ");

    const areaD = `${pathD} L ${coords[coords.length - 1].x.toFixed(1)} ${height} L ${coords[0].x.toFixed(1)} ${height} Z`;

    return { width, height, pathD, areaD };
  }, [chartRows, hashrate1min]);

  const chartConfig = useMemo<ChartConfig>(
    () => ({
      value: {
        label: t("admin.mining.hashrate", "算力"),
        color: isOnline && hashrate1min > 0 ? "#10b981" : "var(--accent-9)",
      },
    }),
    [t, isOnline, hashrate1min],
  );

  const strokeColor =
    isOnline && hashrate1min > 0
      ? "#10b981"
      : isOnline
        ? "var(--accent-9)"
        : "var(--gray-8)";

  const gradientId = `hashrate-spark-${uuid.slice(0, 8)}`;

  return (
    <Popover.Root>
      <Popover.Trigger>
        <button
          type="button"
          className="flex items-center gap-1.5 px-1.5 py-0.5 rounded-md hover:bg-[var(--gray-3)] transition-colors cursor-pointer text-left group"
          title={t("admin.mining.clickToExpand", "点击查看 24 小时详细趋势")}
        >
          {sparklineData ? (
            <svg
              width={sparklineData.width}
              height={sparklineData.height}
              className="overflow-visible block shrink-0"
            >
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={strokeColor} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={strokeColor} stopOpacity={0.0} />
                </linearGradient>
              </defs>
              <path d={sparklineData.areaD} fill={`url(#${gradientId})`} />
              <path
                d={sparklineData.pathD}
                fill="none"
                stroke={strokeColor}
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <div className="w-[110px] h-[26px] flex items-center justify-center text-[10px] text-[var(--gray-8)] border border-dashed border-[var(--gray-5)] rounded">
              {hashrate1min > 0 ? formatHashrate(hashrate1min) : "—"}
            </div>
          )}
          <ChartNoAxesCombined
            size={13}
            className="text-[var(--gray-8)] group-hover:text-[var(--accent-9)] transition-colors shrink-0"
          />
        </button>
      </Popover.Trigger>

      <Popover.Content style={{ width: 440 }} className="p-3 shadow-lg">
        <Flex direction="column" gap="2">
          {/* 详图头部信息 */}
          <Flex justify="between" align="center" wrap="wrap" gap="2">
            <div className="flex flex-col">
              <Text size="2" weight="bold" className="truncate max-w-[260px]">
                {nodeName}
              </Text>
              {algorithm && (
                <span className="text-[11px] font-mono text-[var(--gray-9)]">
                  {algorithm}
                </span>
              )}
            </div>
            <Flex gap="3" align="center">
              <div className="flex flex-col items-end">
                <span className="text-[10px] text-[var(--gray-9)]">
                  {t("admin.mining.peakHashrate", "最高算力")}
                </span>
                <span className="text-xs font-mono font-medium text-emerald-600 dark:text-emerald-400">
                  {formatHashrate(stats.peak)}
                </span>
              </div>
              <div className="flex flex-col items-end">
                <span className="text-[10px] text-[var(--gray-9)]">
                  {t("admin.mining.avgHashrate", "平均算力")}
                </span>
                <span className="text-xs font-mono font-medium text-[var(--gray-11)]">
                  {formatHashrate(stats.avg)}
                </span>
              </div>
            </Flex>
          </Flex>

          <Separator size="4" />

          {/* 详图 Recharts 图表 */}
          {chartRows.length === 0 ? (
            <Flex align="center" justify="center" style={{ height: 170 }}>
              <Text size="2" color="gray">
                {t("admin.mining.noChartData", "暂无历史算力记录")}
              </Text>
            </Flex>
          ) : (
            <ChartContainer
              config={chartConfig}
              className="h-[170px] w-full"
              style={{ aspectRatio: "auto" }}
            >
              <LineChart
                data={chartRows}
                margin={{ top: 12, right: 8, bottom: 4, left: 0 }}
              >
                <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.3} />
                <XAxis
                  dataKey="time"
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: any) =>
                    new Date(v).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  }
                  tick={{ fontSize: 10 }}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={68}
                  tickFormatter={(v: any) => formatHashrate(Number(v))}
                  tick={{ fontSize: 10 }}
                />
                <ChartTooltip
                  content={({ active, payload }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const item = payload[0];
                    const dataPoint = item.payload;
                    return (
                      <div className="rounded-lg border bg-background p-2 shadow-sm text-xs">
                        <div className="font-mono text-[var(--gray-9)] text-[11px] mb-1">
                          {new Date(dataPoint.time).toLocaleString()}
                        </div>
                        <div className="flex items-center gap-1.5 font-semibold text-emerald-600 dark:text-emerald-400">
                          <Activity size={12} />
                          <span>{formatHashrate(Number(item.value))}</span>
                        </div>
                      </div>
                    );
                  }}
                />
                <Line
                  dataKey="value"
                  type="monotone"
                  stroke={strokeColor}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ChartContainer>
          )}
        </Flex>
      </Popover.Content>
    </Popover.Root>
  );
}

export default function Mining() {
  const { t } = useTranslation();
  const { call } = useRPC2Call();
  const { nodeList, isLoading } = useNodeList();
  const [latest, setLatest] = useState<LatestStatus>({});
  const [historyMetrics, setHistoryMetrics] = useState<Record<string, MetricPoint[]>>({});
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // 轮询节点实时算力状态（4s）
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

  // 批量拉取 24 小时历史算力曲线（30s）
  const loadHistoryMetrics = useCallback(async () => {
    try {
      const resp = await call<any, QueryMetricsResponse>("public:queryMetrics", {
        metric_keys: ["mining.hashrate"],
        hours: 24,
        max_points: 60,
        aggregation: "avg",
      });
      if (!aliveRef.current) return;
      const map: Record<string, MetricPoint[]> = {};
      for (const s of resp?.series ?? []) {
        if (s.entity_id && s.points && s.points.length > 0) {
          map[s.entity_id] = s.points;
        }
      }
      setHistoryMetrics(map);
    } catch (e) {
      console.warn("[mining] queryMetrics failed:", e);
    }
  }, [call]);

  useEffect(() => {
    loadHistoryMetrics();
    const timer = setInterval(loadHistoryMetrics, METRICS_POLL_MS);
    return () => clearInterval(timer);
  }, [loadHistoryMetrics]);

  // 轮询任务执行结果
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
                message: (mine.result ?? "")
                  .replace(/\0/g, "")
                  .trim()
                  .slice(0, 200),
              },
            }));
            // 操作成功后立即刷新一轮时序数据
            loadHistoryMetrics();
            return;
          }
        } catch {
          // 任务尚未写入结果或返回 NotFound 时继续重试
        }
      }
      if (!aliveRef.current) return;
      setRows((p) => ({
        ...p,
        [uuid]: {
          busy: null,
          status: "failed",
          message: t(
            "admin.mining.pollTimeout",
            "查询执行结果超时，请稍后在任务结果中查看",
          ),
        },
      }));
    },
    [call, loadHistoryMetrics, t],
  );

  // 下发启停管控
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
            message: t(
              "admin.mining.dispatchFailed",
              "下发失败（节点不在线或 agent 不支持）",
            ),
          },
        }));
      }
    },
    [call, pollTaskResult, t],
  );

  if (nodeList === null || (isLoading && nodeList.length === 0)) {
    return (
      <div className="km-page-admin-mining p-6 flex justify-center items-center min-h-[300px]">
        <Loading />
      </div>
    );
  }

  const nodes = nodeList ?? [];
  const miners: Array<{
    info: NodeBasicInfo;
    online: boolean;
    mining: MiningLive | null;
    isMiner: boolean;
  }> = nodes.map((info) => {
    const st = latest[info.uuid];
    const hasLiveMining = st?.mining != null;
    const hasHistoryMetrics = (historyMetrics[info.uuid]?.length ?? 0) > 0;
    const hasMinerTag =
      Boolean(info.tags?.toLowerCase().includes("miner")) ||
      Boolean(info.tags?.toLowerCase().includes("mining"));

    // 判别是否为挖矿节点（具有挖矿能力/配置）
    const isMiner = hasLiveMining || hasHistoryMetrics || hasMinerTag;

    return {
      info,
      online: Boolean(st?.online),
      mining: st?.mining ?? null,
      isMiner,
    };
  });

  // 排序规则：
  // 1. 挖矿节点排在未配置节点前面
  // 2. 挖矿节点中：在线且在挖（算力 > 0）最前，其次是在线空闲，再次是离线矿机
  // 3. 未配置节点：在线在前，离线在后
  // 4. 同级按节点名称字母升序
  miners.sort((a, b) => {
    if (a.isMiner !== b.isMiner) return a.isMiner ? -1 : 1;

    if (a.isMiner && b.isMiner) {
      const aMining = a.online && Number(a.mining?.hashrate_1min ?? 0) > 0 ? 1 : 0;
      const bMining = b.online && Number(b.mining?.hashrate_1min ?? 0) > 0 ? 1 : 0;
      if (aMining !== bMining) return bMining - aMining;
    }

    if (a.online !== b.online) return a.online ? -1 : 1;
    return (a.info.name || "").localeCompare(b.info.name || "");
  });

  // 活跃算力台数：必须在线且算力 > 0
  const activeCount = miners.filter(
    (m) => m.online && Number(m.mining?.hashrate_1min ?? 0) > 0,
  ).length;

  return (
    <div className="km-page-admin-mining p-4 flex flex-col gap-4">
      {/* 头部标题与在挖统计 */}
      <div className="flex flex-col gap-1">
        <Flex align="center" gap="3" wrap="wrap">
          <Pickaxe className="text-[var(--accent-9)]" size={24} />
          <h1 className="text-2xl font-bold">
            {t("admin.mining.title", "挖矿管理")}
          </h1>
          <Badge
            color={activeCount > 0 ? "green" : "gray"}
            variant="soft"
            size="2"
          >
            {t("admin.mining.activeCount", "{{count}} 台在挖", {
              count: activeCount,
            })}
          </Badge>
        </Flex>
        <Text size="2" color="gray" className="mt-0.5">
          {t(
            "admin.mining.subtitle",
            "集中监控集群节点算力与算法状态，通过任务链路远程下发矿机启停指令",
          )}
        </Text>
      </div>

      <Separator size="4" />

      {/* 提示 Callout 风格 */}
      <Callout.Root color="blue" size="1" variant="surface">
        <Callout.Icon>
          <Info size={16} />
        </Callout.Icon>
        <Callout.Text>
          {t(
            "admin.mining.hint",
            "对节点执行中心端启停需要该节点 agent 配置 AGENT_MINER_CONTROL_CMD 模板（含 {action} 占位符）；结果由任务通道回传，约需数秒。",
          )}
        </Callout.Text>
      </Callout.Root>

      {/* 标准表格区域 */}
      <div className="km-page-admin-mining-table rounded-xl overflow-hidden border border-[var(--accent-3)] shadow-xs">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-52">{t("admin.mining.node", "节点")}</TableHead>
              <TableHead className="w-20">{t("admin.mining.state", "状态")}</TableHead>
              <TableHead className="w-28">{t("admin.mining.algorithm", "算法")}</TableHead>
              <TableHead className="w-32">{t("admin.mining.hashrate", "算力 (1min)")}</TableHead>
              <TableHead className="w-44">{t("admin.mining.trend", "算力趋势 (24h)")}</TableHead>
              <TableHead>{t("admin.mining.control", "管控")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {miners.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center py-12 text-[var(--gray-9)]"
                >
                  {t("admin.mining.noNodes", "暂无可用节点")}
                </TableCell>
              </TableRow>
            ) : (
              miners.map((m) => {
                const row = rows[m.info.uuid] ?? {
                  busy: null,
                  status: null,
                  message: "",
                };
                const hs = Number(m.mining?.hashrate_1min ?? 0);
                const isOnline = m.online;
                const isMiner = m.isMiner;
                const points = historyMetrics[m.info.uuid];

                return (
                  <TableRow key={m.info.uuid}>
                    {/* 节点名称与 UUID */}
                    <TableCell className="font-medium">
                      <div className="flex flex-col">
                        <span
                          className="truncate max-w-[190px]"
                          title={m.info.name || m.info.uuid}
                        >
                          {m.info.name || m.info.uuid}
                        </span>
                        {m.info.name && (
                          <span className="text-[11px] font-mono text-[var(--gray-9)] truncate max-w-[170px]">
                            {m.info.uuid}
                          </span>
                        )}
                      </div>
                    </TableCell>

                    {/* 在线/离线状态 */}
                    <TableCell>
                      <Badge
                        color={isOnline ? "green" : "gray"}
                        variant="soft"
                        className="w-fit"
                      >
                        {isOnline
                          ? t("admin.mining.online", "在线")
                          : t("admin.mining.offline", "离线")}
                      </Badge>
                    </TableCell>

                    {/* 算法 */}
                    <TableCell className="font-mono text-xs text-[var(--gray-11)]">
                      {isMiner && isOnline && m.mining?.algorithm
                        ? m.mining.algorithm
                        : "—"}
                    </TableCell>

                    {/* 1分钟算力 */}
                    <TableCell>
                      {isMiner ? (
                        <span
                          className={cn(
                            "font-mono text-xs",
                            hs > 0 && isOnline
                              ? "font-semibold text-emerald-600 dark:text-emerald-400"
                              : "text-[var(--gray-9)]",
                          )}
                        >
                          {isOnline ? formatHashrate(hs) : "—"}
                        </span>
                      ) : (
                        <span className="text-[var(--gray-9)]">—</span>
                      )}
                    </TableCell>

                    {/* 算力趋势 (24h) */}
                    <TableCell>
                      {isMiner ? (
                        <HashrateSparkline
                          points={points}
                          hashrate1min={hs}
                          isOnline={isOnline}
                          uuid={m.info.uuid}
                          nodeName={m.info.name || m.info.uuid}
                          algorithm={m.mining?.algorithm}
                        />
                      ) : (
                        <span className="text-[var(--gray-9)] text-xs">—</span>
                      )}
                    </TableCell>

                    {/* 操作管控 */}
                    <TableCell>
                      {isMiner ? (
                        <Flex gap="2" align="center" wrap="wrap">
                          <Button
                            size="1"
                            variant="soft"
                            color="green"
                            disabled={row.busy !== null || !isOnline}
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
                            disabled={row.busy !== null || !isOnline}
                            onClick={() => dispatch(m.info.uuid, "stop")}
                          >
                            <Pause size={12} />
                            {row.busy === "stop"
                              ? t("admin.mining.stopping", "暂停中...")
                              : t("admin.mining.stop", "暂停")}
                          </Button>

                          {/* 操作反馈消息 */}
                          {row.status === "success" && (
                            <Text
                              size="1"
                              color="green"
                              className="max-w-[320px] truncate"
                              title={row.message}
                            >
                              {t("admin.mining.success", "指令已执行")}
                              {row.message ? `: ${row.message}` : ""}
                            </Text>
                          )}
                          {row.status === "failed" && (
                            <Text
                              size="1"
                              color="red"
                              className="max-w-[320px] truncate"
                              title={row.message}
                            >
                              {row.message ||
                                t("admin.mining.failed", "执行失败")}
                            </Text>
                          )}
                        </Flex>
                      ) : (
                        <Badge variant="surface" color="gray" size="1">
                          {t("admin.mining.notConfigured", "未配置挖矿")}
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
