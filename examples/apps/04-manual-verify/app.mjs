/**
 * 04-manual-verify —— 人工步：登录 / 二次验证这类“人来做、引擎只验收”的步骤。
 *
 * 规则：
 *   - 人工步不自动过：非 TTY 返回 stopCode=needs_human（脚本照实 ctx.fail，不假装有人）。
 *   - `done: { manual: true }` = 人自证（结果里记 attested）；想让人确认后引擎再复核，
 *     就把 done 写成 DOM 信号（例如 ctx.judge.url("dashboard")）。
 *   - dry 路径只校验调用序列（manual 恒 ok），不会等你按 Enter，也不会拉浏览器。
 *
 * 真跑（需要交互终端 + chromium + 可见浏览器；无显示器用 xvfb-run + VNC）：
 *   amber run 04-manual-verify --headful
 */
export const meta = (kit) => ({
  id: "04-manual-verify",
  label: "04 · 人工步（登录 / 2FA）",
  goal: "到达入口页后，由人完成登录与二次验证，再验收结束状态",
  hosts: ["example.com"],
  site: { pages: { home: "https://example.com/" } },
  slots: {},
  invariants: [
    { id: "on-example-page", desc: "结束时停在 example.com", signal: kit.judge.url("example.com") },
  ],
});

export async function flow(ctx) {
  await ctx.openPage("home");

  // instructions 是给人看的；凭据由用户自己在浏览器里输入，不进脚本、不进产物。
  const human = await ctx.manual("完成登录与二次验证", {
    id: "login-and-2fa",
    instructions: "在打开的浏览器里用你自己的账号登录并完成验证；完成后回终端按 Enter。"
      + "不要把明文凭据写进脚本或命令行参数。",
    done: { manual: true },   // 人自证；要引擎复核就改写 DOM 信号
  });
  if (!human.ok) ctx.fail(human.stopCode ?? "needs_human", human.reason);

  await ctx.done();
}
