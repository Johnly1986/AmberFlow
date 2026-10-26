# 人工步骤与运行节奏（`manual` step / `pace`）

> 2026-10-26。目标：让"登录 → 访问 → 操作"里的**人必须介入的环节**变成流程里的显式步骤，
> 并让"步/动作之间的最小等待"成为应用配置表里的数据。它不是反爬对抗：不做验证码识别、
> 指纹伪造、代理轮换；人工步骤就是**等真人**。

## 1. 运行节奏 `pace`

```jsonc
// apps/<id>/app.mjs 的 META（或 pack.json 顶层）
"pace": {
  "between_steps_ms": 800,     // 两个旅程步之间（browser / cli / manual 都算）
  "between_actions_ms": 300    // 同一浏览器子目标内，两次动作之间
}
```

- 缺省 = 0 = 与今天逐字节一致；只对声明了值的应用生效。
- 合法值：`0..60000` 的整数毫秒；未知键/负数/小数在**加载期**报错。
- 全局默认（所有应用，可被应用表覆盖）：

| 环境变量 | 含义 |
|---|---|
| `AMBERFLOW_STEP_DELAY_MS` | 步间默认等待 |
| `AMBERFLOW_ACTION_DELAY_MS` | 动作间默认等待 |

优先级：**本次参数 > `pack.pace` > 环境变量 > 0**。坏的环境值 = 配置类错误（exit 2），
不会静默当 0。`pace` 只做降载/礼貌节奏，不承诺"更像人"或绕过任何风控。

## 2. 人工步骤 `adapter: "manual"`

```jsonc
{
  "id": "login",
  "adapter": "manual",
  "desc": "登录并完成短信验证",
  "instructions": "在打开的浏览器里用你自己的账号登录；完成后回终端按 Enter",
  "start_url": "https://example.com/login",       // 可省略：人在外部完成时不碰浏览器
  "signal": { "manual": true }                    // 人自证；或写 DOM 信号，引擎会再验一遍
}
```

规则：

- 必须声明 `signal`。`{ "manual": true }` = **人自证**（报告/结果显式记 `attested`，不冒充 DOM 验证）；
  写 `url_contains` / `css_*` 等 DOM 信号时，人确认后引擎还会验一次，验不过 = 未完成。
- `start_url` 可选：给了就先导航到登录页；没给且旅程里还没有页面时，只能配 `{manual:true}`
  （DOM 信号没有页面可验 → 结构化未完成）。
- 旅程里有任何 `manual` 步时，**浏览器默认开可见窗口**（登录/验证码需要人操作）；
  也可显式 `--headful`。没有显示器时请用 `xvfb-run` + VNC，或注入 `manualHandler`（测试/嵌入方）。
- 交互方式：默认是终端提示（`Enter` 继续 / `n` 放弃）；**非 TTY 不会假装有人在**，
  会得到结构化原因 `manual_handler_error: ... needs an interactive terminal`。
- 测试/嵌入方注入 `manualHandler({desc, instructions, url})`；返回 `false` = 人放弃，
  该步记 `done:false, reason:"declined"`，整个旅程 `ok=false`。
- 批处理/自动化入口遇到 `manual` 步会如实跳过（跳过 ≠ 通过），不会挂在那里等人；
  人工步请在终端里直接用 `npm run apps -- --app <id>` 单跑。
- 人工步**不存账号/密码**、不自动识别验证码/2FA；本版本没有凭据保管。
  要做自动重登是另一个更高风险的功能，必须单独评审（OS keychain/加密库、origin 白名单、
  人工过闸、审计与删除）。

## 3. 产物

有 `manual` 步/非零 `pace` 时，`<app>-result.json` 才出现对应字段（缺省等价）：

```jsonc
{
  "manual_steps": [
    { "index": 1, "desc": "登录并完成短信验证", "done": true, "attested": true }
  ],
  "pace": { "between_steps_ms": 800, "between_actions_ms": 300 }
}
```

报告里单列"人工步骤"表，结论写"完成/未完成 + 原因"，证据写"人自证 / 引擎验过信号"。

## 4. 边界

- 只处理**使用者本人/已获授权**的账号；不做账号池、不代他人登录。
- 遇到验证码/2FA 一律等人工；不自动识别、不代过。
- 站点 ToS 禁止自动化的，不应使用本功能；线上验收需授权与频率预算。
- 不提供指纹伪装、代理池、UA 轮换等规避手段；这些既不在本功能里，也不该进仓库。

## 5. 验证

在真实站点或你自己的应用上跑一次带 `manual` 步的流程：`npm run apps -- --app <id>`；
确认浏览器可见、终端提示可交互、产物里的 `manual_steps` 与 `pace` 字段正确。
