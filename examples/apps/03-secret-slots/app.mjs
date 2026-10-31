/**
 * 03-secret-slots —— 敏感槽位：声明 secretSlots，产物 / report / stdout / dry 输出一律掩码成 ***。
 *
 * 纪律（抄这个示例时照做）：
 *   - 明文凭据永远不写进 app.mjs / 仓库；真值用 `--slot-file`（JSON 对象，chmod 600）、
 *     环境变量或本机配置注入，引擎按名读取。
 *   - `meta.secretSlots` 里的名字必须是已声明槽位（slots 或 requiredSlots 里有）。
 *   - 值仍只来自声明：flow 里用 ctx.value.slot("password") 绑定；不打印、不拼进 desc、不写日志。
 *
 * 离线校验（tools/examples-check.ts）会给这个示例写一次性 canary 走 `--slot-file` 再 dry，
 * 断言 stdout 里 password 是 `***`、且 canary 在输出里零命中。
 *
 * 页面形状是占位示例：dry 校验声明面；真跑前换成你自己的登录页与 inspect 验证过的锚点。
 */
export const meta = (kit) => ({
  id: "03-secret-slots",
  label: "03 · 敏感槽位与掩码",
  goal: "用声明的凭据槽位提交登录表单（dry 输出中 password 一律 ***）",
  hosts: ["example.com"],
  site: { pages: { login: "https://example.com/login" } },
  slots: {
    username: "demo-user",     // 非敏感，可以给默认值
    password: "",              // 敏感：空串只是加载期占位；真值走 --slot-file / 本机配置，绝不写这里
  },
  requiredSlots: ["password"],
  secretSlots: ["password"],   // 输出面掩码：***；名字必须已在上面声明
  invariants: [
    { id: "on-login", desc: "结束时仍在登录页", signal: kit.judge.url("example.com") },
  ],
});

export async function flow(ctx) {
  await ctx.openPage("login");

  const filled = await ctx.step("填入账号与密码", {
    id: "fill-credentials",
    act: [
      ctx.command("fill", "#username-input", ctx.value.slot("username")),
      ctx.command("fill", "#password-input", ctx.value.slot("password")),
    ],
    // 组合信号：表单在（all_of），且没有登录错误提示（not）。
    done: ctx.judge.all(
      ctx.judge.exists("#login-form"),
      ctx.judge.not(ctx.judge.exists("#login-error")),
    ),
  });
  if (!filled.ok) ctx.fail(filled.stopCode ?? "step_failed", filled.reason);

  await ctx.done();
}
