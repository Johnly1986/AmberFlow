/**
 * **Host 信封（navigation envelope）—— 单一实现**（F2/L2 合并）。
 *
 * 历史：同一语义（URL 是否落在声明的 hosts 信封内）在 `extraction.ts`（`urlInHostsEnvelope`
 * 布尔视图）与 `executor-pure.ts`（`disallowedHost` 拒绝视图）各写一遍，修一处漏一处——
 * 而这是**安全语义**（导航/iframe 门禁），两份实现一旦漂移就有真实越权面。
 *
 * 这里收敛为一个核心判定 `hostEnvelopeViolation`，两个 API 从它派生，行为逐字节不变：
 *   - `disallowedHost`     → 拒绝视图：返回越界 host 或 null（executor 门禁用）。
 *   - `urlInHostsEnvelope` → 布尔视图：true = 在信封内（extraction/池抽帧用）。
 *
 * 判定规则（有意与合并前逐字节一致，勿改）：
 *   - 无 hosts / 空 → 不设防（true / null）。
 *   - URL 解析失败 → 放行（不可判 origin 时绝不擅自排除）。
 *   - `file:`/`about:`/`data:` → 放行（信封只管网络，不管 fixture）。
 *   - 否则精确 host 或任意子域匹配 → 放行。
 */
export function hostMatchesEnv(host: string, hosts: string[]): boolean {
  const h = String(host).toLowerCase();
  return hosts.some((raw) => {
    const e = String(raw).toLowerCase().replace(/^\.+/, "");
    if (!e) return false;
    return h === e || h.endsWith("." + e);
  });
}

/** 核心判定：URL 越出信封返回被拒 host，否则返回 null。单一实现。 */
export function hostEnvViolation(url: string, hosts: string[] | null | undefined): string | null {
  if (!hosts || hosts.length === 0) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // unparseable: whatever the page does next, it is checked again post-action.
    return null;
  }
  if (["file:", "about:", "data:"].includes(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  if (!host) return null;
  return hostMatchesEnv(host, hosts) ? null : host;
}

/** 拒绝视图：返回越界 host 或 null（导航/帧门禁）。 */
export function disallowedHost(url: string, hosts: string[] | null | undefined): string | null {
  return hostEnvViolation(url, hosts);
}

/** 信封布尔视图：true = 在信封内（放行）。 */
export function urlInHostsEnvelope(url: string, hosts: string[] | null | undefined): boolean {
  return hostEnvViolation(url, hosts) === null;
}