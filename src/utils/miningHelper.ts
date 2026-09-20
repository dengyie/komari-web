/**
 * 挖矿指标格式化纯函数（无 React 依赖）。
 * H/s 自适应单位：H → kH → MH → GH → TH → PH。
 */
export function formatHashrate(hs: number | null | undefined): string {
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
