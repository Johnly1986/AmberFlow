/**
 * 02-slots-and-signals —— 声明面：slots / requiredSlots；组合信号：all_of / not。
 *
 * 要点：
 *   - 值只来自声明：`ctx.slots.city` 来自 meta.slots 或 CLI `--slot city=…`；flow 里不写业务值。
 *   - `requiredSlots` 是“必须有值”的声明；加载期仍要求 meta.slots 里有默认值（可以是空串），
 *     否则 `apps check` 会报 `required slot "…" has no value`。
 *   - 完成信号可以组合：`all_of`（同时成立）+ `not`（反向证据：“不该出现的东西不在”）。
 *   - `act` 是命令闭集 + 槽位绑定：fill/select 的值只能来自声明（ctx.value.slot(...)），不猜。
 *
 * 页面形状是占位示例（example.com 上并没有这些控件）：dry 校验调用序列与声明形状；
 * 真跑前把 page 角色/选择器换成你 `amber inspect` 验证过的事实。
 */
export const meta = (kit) => ({
  id: "02-slots-and-signals",
  label: "02 · 槽位与组合信号",
  goal: "把声明的城市槽位填进搜索框，并确认登录浮层没有出现",
  hosts: ["example.com"],
  // 页面角色：flow 里用 ctx.openPage("home")，不重复硬编码 URL。
  site: { pages: { home: "https://example.com/" } },
  // 默认值；真跑可用 --slot city=北京 覆盖（--slot 的明文会进进程参数，敏感值别用它）。
  slots: { city: "上海", query: "离线示例" },
  requiredSlots: ["city"],
  invariants: [
    { id: "on-home", desc: "结束时仍在入口页", signal: kit.judge.url("example.com") },
  ],
});

export async function flow(ctx) {
  const city = ctx.slots.city;              // 只读：值来自声明 / CLI --slot，flow 不发明值

  await ctx.openPage("home");               // openPage 只做 goto；要“到达证据”用 arrive

  const filled = await ctx.step(`把城市「${city}」填进搜索框`, {
    id: "fill-city",
    // 命令闭集：目标用稳定锚点收窄，值用槽位绑定（不能凭空写字面量）。
    act: [ctx.command("fill", "#search-input", ctx.value.slot("city"))],
    // 组合信号：URL 仍在入口页（all_of），且登录浮层没有出现（not）。
    done: ctx.judge.all(
      ctx.judge.url("example.com"),
      ctx.judge.not(ctx.judge.exists("#login-form")),
    ),
  });
  if (!filled.ok) ctx.fail(filled.stopCode ?? "step_failed", filled.reason);

  await ctx.done();
}
