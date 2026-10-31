# 人工步骤与运行节奏（`ctx.manual` / `meta.pace`）

> 目标：让“登录 → 访问 → 操作”里**人必须介入的环节**成为流程里的显式的一步，并让“步/动作之间的最小等待”成为 `meta` 里的声明。它不是反爬对抗：不做指纹伪造、代理轮换、风控/速率限制规避；验证环节（含验证码/2FA）可在用户授权下由人工步/注入处理器代过；人工步骤默认**等真人**。

这两件事都只写在应用的 `meta` / `flow(ctx)` 里——应用只有 `$AMBERFLOW_HOME/apps/<id>/app.mjs` 一种格式。

## 1. 运行节奏 `meta.pace`

```js
export const meta = (kit) => ({
  id: "my-app", label: "我的应用", goal: "…", hosts: ["example.com"], slots: {},
  pace: {
    between_steps_ms: 800,     // 两次执行步之间（ctx.step / arrive / manual / run）
    between_actions_ms: 300,   // 同一浏览器子目标内，两次动作之间
  },
  invariants: [],
});
```

- 单位毫秒，合法值 `0..60000` 的整数；未知键 / 负数 / 小数在**加载期**报错（`amber apps check` 就红）。缺省 = 0。
- 优先级：**本次显式（嵌入方运行参数） > `meta.pace` > 环境变量 > 0**。“环境变量”一层含入口引导时从 `configs/amberflowrc.json` / `amber config` 吸收进来的值——机器配置也能设出非零节奏；凡 `pace` 出现在结果里，`pace.sources` 逐字段点名来源（`explicit` / `meta` / `env` / `default`），别猜 1000ms 从哪来。
- 全局默认（所有应用，可被 `meta.pace` 覆盖）：

| 环境变量 | 含义 |
|---|---|
| `AMBERFLOW_STEP_DELAY_MS` | 步间默认等待（`between_steps_ms`） |
| `AMBERFLOW_ACTION_DELAY_MS` | 动作间默认等待（`between_actions_ms`） |

- 坏的环境值 = 配置类错误（exit 2），不会静默当 0。
- `between_steps_ms` 由 `ctx` 在每次 `step` / `arrive` / `manual` / `run` 之前等待（第一步之前不等待）；`between_actions_ms` 由执行器在子目标内的动作之间等待。
- 非零 `pace` 会出现在运行结果的 `pace` 字段里（缺省等价于没有这个字段）。
- `pace` 只做降载/礼貌节奏，不承诺“更像人”，也不绕过任何风控。

## 2. 人工步骤 `ctx.manual`

```js
const m = await ctx.manual("登录并完成短信验证", {
  id: "login",                       // 稳定标识：进 trace / step_traces / steps[]
  instructions: "在打开的浏览器里用你自己的账号登录；完成后回终端按 Enter",
  done: { manual: true },            // 人自证；或写 DOM 信号，引擎会在人确认后再验一遍
});
if (!m.ok) ctx.fail(m.stopCode ?? "needs_human", m.reason);
```

规则：

- **必须声明 `done`**。`{manual:true}` = **人自证**（报告/结果显式记 `attested`，绝不冒充 DOM 验证）；写 `url_contains` / `css_*` 等 DOM 信号时，人确认后引擎还会验一次，验不过 = 未完成（`manual_signal_not_held`），不会静默算绿。
- **未完成的人工步不能变绿**：只要某个 `manual` 事件 `ok!==true`，整次运行就是未完成（`status=needs_human`、`verified=false`、退出码 1），即使脚本吞掉了返回值、后续步骤与不变量都成立。
- **TTY**：终端提示（`Enter` 继续 / `n` 放弃）；人放弃 = `manual_declined`。浏览器默认仍是 headless——要让人在页面上操作，请加 `--headful`（没有显示器时用 `xvfb-run` + VNC）。
- **非 TTY / 批处理 / Agent 调用**：不会假装有人在，也不会为它拉一个没人能看见的有头浏览器；直接返回 `{ok:false, stopCode:"needs_human"}`。`--manual-fail-fast` 在任何人工处理器之前就返回 `needs_human`，注入的处理器也覆盖不了。嵌入方（桥 / 测试）可以注入人工处理器；注入后由处理器决定通过/拒绝。
- 人工步**不自动过**；验证码/2FA 等验证可在用户授权下代过（人工步/注入处理器）；不代他人登录；不绕反爬。凭据由用户在本机配置/环境变量/受支持的凭据存储中保存、引擎按名读取且不写入产物；本版本尚未内置凭据保险箱（待建产品能力，不是禁令）。
- 批准执行的人工步计入一次执行预算（`--max-steps`）并受 `meta.pace.between_steps_ms` 约束；直接返回 `needs_human` 时两者都不发生。
- 分类保持：`ctx.fail(m.stopCode ?? "needs_human", m.reason)` 会保留具体停因；即使脚本不 `ctx.fail`，人工步未完成也会让整次运行 `status=needs_human`、`verified=false`、退出码 1。

## 3. 产物与 Agent 视图

有人工步或非零 `pace` 时，结果 JSON 才出现对应字段（缺省等价于没有）：

```jsonc
{
  "manual_steps": [
    { "index": 0, "desc": "登录并完成短信验证", "done": false, "reason": "needs_human" }
  ],
  "pace": { "between_steps_ms": 800, "between_actions_ms": 300,
            "sources": { "between_steps_ms": "meta", "between_actions_ms": "env" } },
  "step_traces": [
    { "index": 0, "id": "login", "desc": "登录并完成短信验证", "status": "failed", "stop_code": "needs_human" }
  ]
}
```

- 人工步进 trace（`call:"manual"`）、`step_traces`、`steps[]` 与 `failure`；`status=needs_human` 时 `next` 会建议在终端里 `amber run <id> --headful` 重跑。
- 报告里单列“人工步骤”表：结论与原因以 `manual_steps` 为准（完成/未完成 + `reason`）。
- 跳过 ≠ 通过：人工步未完成 = 全局未完成（`needs_human` 不计为成功，`verified=false`，退出码 1），不管脚本是否吞掉了返回值。

## 4. 边界

- 只处理**使用者本人/已获授权**的账号；不做账号池、不代他人登录。
- 遇到验证码/2FA：走人工步或经用户授权的处理器代过，不绕反爬；风控/限流拦截仍按 blocked 停止。
- 站点 ToS 禁止自动化的，不应使用本功能；线上验收需授权与频率预算。
- 不提供指纹伪装、代理池、UA 轮换等规避手段；这些既不在本功能里，也不该进仓库。

## 5. 验证

在真实站点或你自己的应用上跑一次带人工步的流程：

```bash
amber run my-app --headful        # TTY：确认浏览器可见、终端提示可交互
amber run my-app --json           # 非 TTY：确认 status=needs_human、exit 1，且没有拉有头浏览器
```

确认产物里的 `manual_steps`、`step_traces` 与 `pace` 字段正确；跑 `amber apps check my-app` 确认 `meta.pace` 声明合法。