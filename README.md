# AmberFlow

**浏览器自动化，每一步都能证明做对了。**

AmberFlow 是一个**可验证的浏览器执行内核**：流程先被冻结，执行器按页面信号逐步完成任务；模型只参与元素选择与风险评估，不生成动作、也不替你做「完成」结论。每次运行都会留下可读、可追溯、可复现的证据。

它面向真实的工作流——登录后的受控系统、内部工具、测试环境——而不是「让 AI 随便点」的演示玩具。

---

## 为什么需要 AmberFlow

| 常见问题 | AmberFlow 的做法 | 你得到的结果 |
|---|---|---|
| AI Agent「看起来点完了」，但不知道是否真的成功 | 完成只认页面信号（URL / DOM），模型没有完成裁判权 | 绿就是绿，红就是红，可复核 |
| RPA / 脚本改版即碎，失败也说不清原因 | 流程冻结 + 结构化停因 + 每次运行留痕 | 失败能定位、能复现、能交给别人看 |
| 测试回归「跳过也算过」，证据散落在各处 | 退出码区分通过/失败/阻塞；每次运行三份证据 | CI 诚实门 + 可交付的证据包 |
| 数据 / 凭据不能出域 | 私有部署、本地或自带模型；凭据本地按名读取 | 数据留在你自己的环境 |
| 自动化一旦登录后就没人敢碰 | 登录/2FA/验证码可在用户授权下处理，凭据不进日志与报告 | 可以覆盖真实的登录后流程 |

## 适合谁

- **测试 / QA 团队与测试外包商**：把「录制一遍 → 登录后回归 → 产出证据」变成可交付物。
- **受监管 / 数据不出域的组织**：私有部署，证据可带走，凭据不经第三方。
- **Agent / 工具开发者**：把「可验证的浏览器执行」接入自己的 agent 工作流（DSH 桥已可用）。

**不适合**：无人值守的生产 RPA 平台、消费者个人自动化、任何需要绕过反爬或验证码黑产的场景。AmberFlow 的边界是明确的：**不绕反爬**、不伪造指纹、不轮换代理；验证环节只做用户授权内的「代过」。

## 你会得到什么

- **一次录制，可重复回放**：演示一遍即可生成流程；规则档回放不通过就不会落盘。
- **每一步都有依据**：完成由页面信号判定，失败给出结构化原因和下一步建议。
- **三份证据**：`*-result.json`、`*-report.md`、`*-report.html`，敏感槽位自动掩码；需要时还可保留执行轨迹用于重放。
- **默认安全**：破坏性浏览器动作默认按干跑证据拒绝；需要显式放行才执行。凭据与敏感值默认不进产物。
- **可选私有部署**：本地模型或自带线上模型；Apache-2.0，可嵌进你自己的环境。

## 5 分钟上手

需要 **Node ≥ 22.6** 与 Chromium。

```bash
git clone https://github.com/Johnly1986/AmberFlow.git
cd AmberFlow
npm ci
npx playwright install chromium
npm run doctor          # 体检：Node / Chromium / 模型与配置
npm run examples-check  # 离线跑通 4 个示例（零网络、零模型）
```

从示例开始，把应用复制到你的用户目录：

```bash
mkdir -p "$HOME/.amberflow/apps"
cp -R examples/apps/01-basic-step "$HOME/.amberflow/apps/"

# 在 checkout 里用这个入口（`npx amber` 在 checkout 内会挂住，原因见命令帮助）
node --experimental-strip-types src/cli/main.ts apps check 01-basic-step
node --experimental-strip-types src/cli/main.ts run 01-basic-step --dry-run
node --experimental-strip-types src/cli/main.ts run 01-basic-step
```

> 仓库内为什么不用 `npx amber`：本包的 bin 没链进 `node_modules/.bin`，`npx` 会去解析远端同名包。就地用上面的 `node --experimental-strip-types src/cli/main.ts`，或者先 `npm link` 后直接用 `amber`。npm 包发布准备中（当前 2.0.0 未发布，建议从源码使用）。

创建自己的应用：

```bash
node --experimental-strip-types src/cli/main.ts apps new my-app \
  --goal "把商品加入购物车" --url https://shop.example.com/p/1
node --experimental-strip-types src/cli/main.ts inspect --url https://shop.example.com/p/1 --json
# 编辑 $AMBERFLOW_HOME/apps/my-app/app.mjs 后：
node --experimental-strip-types src/cli/main.ts apps check my-app
node --experimental-strip-types src/cli/main.ts run my-app --trace
```

应用就是用户目录下的 `app.mjs`（`meta` + `flow(ctx)`），不写进仓库、不依赖中央清单；仓库永远不内置应用。更多作者体验见 [examples/README.md](examples/README.md) 与 [docs/APP_SCRIPT_AUTHORING.md](docs/APP_SCRIPT_AUTHORING.md)。

## 证据与安全

- **产物默认落盘**：每次运行写 `*-result.json` / `*-report.md` / `*-report.html`；证据默认不进仓库，失败截图/DOM 按敏感数据处理。
- **敏感值默认掩码**：槽位可在 `meta.secretSlots` 声明，产物/报告/stdout 中显示 `***`；CLI 敏感值建议用 `--slot-file`（JSON）而不是 `--slot`。
- **凭据模型**：凭据由用户在本机配置 / 环境变量 / 受支持存储保存，引擎按名读取；明文不进用例、计划、报告、trace 或仓库。详见 [SECURITY.md](SECURITY.md)。
- **反爬与验证边界**：不绕反爬、不伪造指纹、不轮换代理、不规避风控/限流；验证环节（登录/2FA/验证码）可在用户授权下由人工步或注入处理器代过。站点 ToS 由使用者负责。
- **默认安全**：破坏性浏览器动作默认拒绝；确需放行时显式使用 `--confirm-unsafe`（或 `AMBERFLOW_CONFIRM_SAFE=0`），并自行承担风险。

## 当前状态

AmberFlow 2.0.0 是**未发布**版本，正在从「可运行」走向「可交付」：

- 已具备：可验证执行内核、录制→回放、证据报告、真实站点回归套件、DSH Agent 桥、离线示例与离线校验、默认安全与凭据脱敏。
- 规划/待补：认证后的回归闭环（会话复用、验证处理器、认证感知录制）、HTML 证据报告增强、npm 正式发布、私有部署交付包。
- **明确不做**：无人值守 RPA 平台、消费者个人自动化、任何绕过反爬的灰色需求。当前不承诺 SLA/驻场，只适合受控环境的小团队试点。

完整变更见 [CHANGELOG.md](CHANGELOG.md)。

## 文档

- [离线示例与用法](examples/README.md)
- [应用脚本作者指南](docs/APP_SCRIPT_AUTHORING.md)
- [Agent / DSH 接入契约](docs/AGENT_INTERFACE.md)
- [人工步骤与运行节奏](docs/MANUAL_STEPS_AND_PACE.md)
- [决策服务配置](docs/DECISION_SERVICE_CONFIG.md)
- [安全策略](SECURITY.md)
- [变更记录](CHANGELOG.md)

## 开发与贡献

```bash
npm run check              # PR 门禁：类型检查 + 配置一致性 + 提示词/信号校验 + 泄露扫描 + 示例校验 + 用例声明
npm run test -- --tier smoke   # 真实站点（需要网络；跳过 ≠ 通过）
```

仓库没有单元测试与离线夹具是**设计决定**：真实站点套件是唯一测试层；运行证据不进仓库。发现问题请通过 issue 反馈，安全问题请走 [SECURITY.md](SECURITY.md) 的报告渠道。

## License

Apache-2.0，见 [LICENSE](LICENSE)。
