# 开发与部署

这个包是 **DSH 的适配器**：把本仓库（AmberFlow）的冻结计划引擎接成三个模型可见的工具
（`amberflow_apps` / `_run` / `_learn`）。它住在 `integrations/dsh-bridge/`，与引擎同仓库、同版本线。

依赖方向是**单向**的：本包 → 本仓库（用 `repoPath` 起它的 CLI 子进程并读产物）；引擎对 DSH 与本包
**零引用**。除此之外它还需要 DSH 的宿主包（`@deepseek-ai/cordis` / `-dsh-tools` / `-schemastery`），
那些由 DSH 安装提供——本仓库不依赖它们。

## 目录

| 路径 | 作用 |
|---|---|
| `src/` | 三个工具与其背后的服务缝（`ctx.amberflow`，供别的插件调用） |
| `tests/` | 两层：`bridge`/`service`（离线、桩 checkout）与 `live`（真浏览器 + 真 checkout） |
| `cordis.patch.yml` | bundle 层：装进 profile 即注册三个工具；`repoPath` 指向本仓库根 |
| `scripts/setup-links.mjs` | 链入依赖：工具链取自本仓库，宿主包取自 DSH 安装 |
| `lib/` | 构建产物（git 忽略），入口 `lib/types/index.js` |

## 构建与测试

```bash
npm run setup          # 链依赖；DSH_ROOT=/path/to/deepseek-harness 指定宿主安装
npm run build          # tsc -b → lib/types/*.js + *.d.ts（不需要打包器：tsc 会把 ./x.ts 改写成 ./x.js）
npm run test:offline   # 47 条，离线，CI 可跑
npm run test:live      # 真机；需要 chromium + 本仓库，录制那条还需要 ONNX 产物
npm test               # build + 全部
```

本仓库的门禁（`bash bench/smoke.sh`）里有一步 **2d** 会跑它的离线测试——**只有**设了 `DSH_ROOT`
且那确实是一份 DSH 安装时才跑，否则打印 SKIP 原因跳过。跳过不等于通过。

`npm run setup` 建立的链接**只服务于编译期**。运行时不需要它们：DSH 进程自己提供宿主包，并按它
checkout 的 tsconfig paths 解析到这些包的**源码**——插件因此与宿主共用同一个模块实例。
本仓库自己的 `vitest.config.ts` 把 `integrations/**` 排除在外，所以本包的 `*.spec.ts` 不会混进
引擎的 873 条测试。

> 双语文档：`README.md` / `README.zh.md` 两边同步维护。原来那份 `README.i18n.yaml`（DSH 仓库的
> "中英段落哈希配对记录"）已删除——校验它的门禁脚本住在 DSH 仓库里、只认自己仓库内的路径，
> 搬过来之后既校验不了也重录不了，留着只会变成一份会骗人的记录。

## 装进 / 移出 DSH profile

```bash
dsh plugin --profile <name> add /root/ML/AmberFlow/integrations/dsh-bridge
dsh plugin --profile <name> remove @deepseek-ai/dsh-amberflow-bridge
```

`cordis.patch.yml` 的 `repoPath` 默认 `/root/ML/AmberFlow`；换 checkout 用环境变量 `AMBERFLOW_REPO`
覆盖。它**没有**改成"相对本包位置"是有意的：插件既可能从 `src/`（tsx）也可能从 `lib/`（node）加载，
两者的相对深度不同，显式路径更安全。

## 热重载（可选）

DSH profile 补丁里把 HMR 的 `root` 指向本目录，重建 `lib/` 后会自动重载，不必重启：

```yaml
- id: hmr
  name: "@deepseek-ai/dsh-hmr"
  config:
    root:
      - /root/ML/AmberFlow/integrations/dsh-bridge
    followSymlinks: false   # 必需：node_modules/@deepseek-ai/* 是指向 DSH 安装的软链
```
