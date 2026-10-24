/**
 * L2 试点：ip-config 的 **循环版** —— 4 行规划数据、8 个步骤在运行期产生。
 *
 * 这是 L2 相对 L1 的真正增量：JSON 里是 8 个手写/生成的步骤（每行重复一遍），
 * 这里是一行 `for` + 一个运行期 `if`（坏 IP 的行**期望被设备页拒绝**）。
 * 步骤的内容（desc/信号/槽位）与 `apps/ip-config/pack.json` 逐字段一致——
 * 由 `tests/ctx-pilots.test.ts` 对照 `expandPack` 钉住。
 */
export const meta = (kit) => ({
  id: "flow-ip-config",
  label: "L2 flow：按 Excel 规划表把每台设备的 IP 写进它自己的网络设置页（循环版）",
  goal: "按 Excel IP 规划表把每台设备的 ip / 子网掩码 / 网关写进它自己的网络设置页；表格里写错的那一行必须由设备页自己拒绝，并被如实报出来",
  model: "english",
  hosts: [],
  slots: {},
  invariants: [
    {
      id: "end-on-the-rejected-device-page",
      desc: "结束时停在 CAM-1003 自己的网络设置页，页面上是设备页给出的拒绝文案",
      signal: kit.judge.all(
        kit.judge.url("net_settings.html"),
        kit.judge.text("[data-test=sn]", "CAM-1003"),
        kit.judge.text("[data-test=error]", "IP 地址格式错误"),
      ),
    },
    {
      id: "the-rejected-value-is-the-planned-one",
      desc: "被拒绝的正是规划表里的那个值（10.0.1.999），不是执行器自己编的",
      signal: kit.judge.text("[data-test=error]", "10.0.1.999"),
    },
    {
      id: "rejection-is-not-reported-as-success",
      desc: "被拒绝的这一行没有谎报成功（save-ok 里没有「已保存」）",
      signal: kit.judge.not(kit.judge.text("[data-test=save-ok]", "已保存")),
    },
  ],
});

/** 规划表（本应用把 4 行当作计划数据；真实场景由 Excel 读出后传进来）。 */
const ROWS = [
  { sn: "CAM-1001", ip: "10.0.1.11", mask: "255.255.255.0", gw: "10.0.1.1" },
  { sn: "CAM-1002", ip: "10.0.1.12", mask: "255.255.255.0", gw: "10.0.1.1" },
  { sn: "PTZ-2001", ip: "10.0.2.21", mask: "255.255.255.0", gw: "10.0.2.1" },
  // 规划表写错的一行：CAM-1003 的 ip 不是合法 IPv4 —— 期望被设备页自己拒绝。
  { sn: "CAM-1003", ip: "10.0.1.999", mask: "255.255.255.0", gw: "10.0.1.1" },
];

/** 规划表里的值是否合法（运行期判断：坏行的期望与好行不同）。 */
function validIpv4(ip) {
  const parts = String(ip).split(".");
  return parts.length === 4 && parts.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);
}

export async function flow(ctx) {
  for (const row of ROWS) {
    const opened = await ctx.step(`打开 ${row.sn} 的网络设置页`, {
      url: "testpages/net_portal.html",
      act: ctx.hint(`a[data-test=net-${row.sn}]`),
      done: ctx.judge.text("[data-test=sn]", row.sn),
    });
    if (!opened.ok) throw new Error(`open ${row.sn} failed: ${opened.stopCode}`);

    const saved = await ctx.step(
      validIpv4(row.ip)
        ? `把规划的 IP / 子网掩码 / 网关 保存到 ${row.sn}`
        : `把规划的 IP / 子网掩码 / 网关 提交到 ${row.sn}（规划表写的是 ${row.ip}）`,
      {
        url: `testpages/net_settings.html?sn=${row.sn}`,
        act: ctx.hint("button[data-test=net-save]"),
        slots: { ip: row.ip, mask: row.mask, gw: row.gw },
        // 好行：设备页回显"已保存 + 这个 IP"；坏行：设备页自己报错 + 回显这个坏值 + 没有"已保存"。
        done: validIpv4(row.ip)
          ? ctx.judge.all(
              ctx.judge.text("[data-test=save-ok]", "已保存"),
              ctx.judge.text("[data-test=save-ok]", row.ip),
            )
          : ctx.judge.all(
              ctx.judge.text("[data-test=error]", "IP 地址格式错误"),
              ctx.judge.text("[data-test=error]", row.ip),
              ctx.judge.not(ctx.judge.text("[data-test=save-ok]", "已保存")),
            ),
      },
    );
    if (!saved.ok) throw new Error(`save ${row.sn} failed: ${saved.stopCode}`);
  }
  await ctx.done();
}
