# Security Policy

> 适用范围：AmberFlow（`amber` CLI / flow 应用 / `online/` 真实站点套件 / DSH 桥）。本文件是 **M0 信任前置门**的一部分；未完成前不做"可审计/可认证"对外承诺。

## 1. 凭据模型

- **允许保存**：凭据可由用户在本机配置（`configs/amberflowrc.json`，已被 `.gitignore` 排除）、环境变量或后续受支持的凭据存储中保存；引擎按名读取。
- **禁止落产物**：明文凭据不得进入用例、计划、报告、trace、证据、stdout 或仓库。`meta.secretSlots` 声明的槽位在结果/报告中自动掩码（`***`）；名称像凭据的槽位（password/token/api_key/...）也会被启发式掩码。
- **CLI 注意**：`--slot k=v` 的明文会出现在进程参数与桥 argv 中；敏感值请用 `--slot-file FILE`（JSON 对象，建议 `chmod 600`）或环境/本机配置。
- **本机配置**：写入后权限收紧到 `0600`（Windows 无 POSIX 模式，忽略失败）；`doctor`/`config show` 只显示掩码。
- **待建**：应用级加密凭据保险箱、会话持久化、验证处理器（规划在 M0/M1，见 `docs/direction/2026-10-31-final-direction-v3.md`）。

## 2. 证据与产物

- 输入值脱敏覆盖 `password`/`file`/`hidden` 类型；`meta.secretSlots` 覆盖槽位级。
- 失败截图 / DOM dump（`failure.html` 等）可能包含页面上的 PII 或已填值：按敏感数据处理，不提交、不外发，按客户约定保留期限清理。
- `secret-scan` 门（`tools/secret-scan.ts`）用一次性 canary 断言 result JSON / report.md / dry JSON 零命中；接入 `npm run check`。

## 3. 信任边界（当前）

- **脚本 = 进程内任意代码**：`app.mjs` 与应用包是用户作用域代码，能访问运行进程能力；**沙箱未做**。只运行可信应用；私有部署使用专用 OS 用户/容器，并明确这一信任模型。
- 危险工具步：默认拒绝；`--allow-dangerous` 才执行。应用批量运行 M0 起默认按干跑证据拒绝破坏性浏览器动作；`--confirm-unsafe` 或 `AMBERFLOW_CONFIRM_SAFE=0` 才显式恢复旧的「风险只记录不阻断」。
- 人工步：非 TTY 不假装有人；验证环节（登录/2FA/验证码）可在用户授权下由人工步/注入处理器代过——产品不做自动打码/接码平台，不代他人登录。

## 4. 反爬与验证边界

- **不绕反爬**：不伪造指纹、不轮换代理、不规避风控/速率限制；WAF/限流/挑战页按 `blocked` 停止。
- **验证可代过**：登录/2FA/短信/邮箱验证码等可由用户授权/配合完成；站点 ToS 由使用者负责；两者叠加时按"反爬"处理。
- 不提供 stealth、账号池、自动修复验证码等能力。

## 5. 报告漏洞

- 请通过 GitHub Security Advisory（仓库 `Johnly1986/AmberFlow`）或标有 `security` 的 issue 报告；**不要在报告里粘贴真实凭据/PII**，用一次性 canary 复现。
- 我们会在确认后修复并在 CHANGELOG 记录；不支持版本：尚无正式发布版本（2.0.0 为未发布版本字段）。

## 6. 已知缺口（诚实声明）

- 无应用级加密凭据保险箱；无会话持久化；无 OTP/2FA 处理器；无沙箱；无调度/告警/RBAC/计费。
- `--slot` 明文进 argv 的风险只能靠 `--slot-file`/环境缓解，无法在 CLI 层完全消除。
- `--emit-trace` / `--replay` 只记录 `inputs_sha256` 与调用锚点，不记录槽位值；但工具步输出/页面证据仍可能包含业务数据，需按证据敏感性处理。
