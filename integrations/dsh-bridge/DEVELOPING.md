# 开发与部署

这个包是 **DSH 的适配器**：把本仓库（AmberFlow）的冻结计划引擎接成三个模型可见的工具
（`amberflow_apps` / `_run` / `_learn`）。它住在 `integrations/dsh-bridge/`，与引擎同仓库、同版本线。

依赖方向是**单向**的：本包 → 本仓库（用 `repoPath` 起它的 CLI 子进程并读产物）；引擎对 DSH 与本包
**零引用**。除此之外它还需要 DSH 的宿主包（`@deepseek-ai/cordis` / `-dsh-tools` / `-schemastery`），
那些由 DSH 安装提供——本仓库不依赖它们。

## 目录

| 路径 | 作用 |
|---|---|
| `src/` | 四个工具与其背后的服务缝（`ctx.amberflow`，供别的插件调用） |
| `tests/` | 两层：`bridge`/`service`（离线、桩 checkout）与 `live`（真浏览器 + 真 checkout） |
| `cordis.patch.yml` | bundle 层：装进 profile 即注册四个工具；`repoPath` 指向本仓库根 |
| `scripts/setup-links.mjs` | 链入依赖：工具链取自本仓库，宿主包取自 DSH 安装 |
| `lib/` | 构建产物（git 忽略），入口 `lib/types/index.js` |

## 构建与测试

```bash
npm run setup          # 链依赖；DSH_ROOT=/path/to/deepseek-harness 指定宿主安装
npm run build          # tsc -b → lib/types/*.js + *.d.ts（不需要打包器：tsc 会把 ./x.ts 改写成 ./x.js）
npm run test:offline   # 73 条，离线，CI 可跑
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

两条通道，按"插件与引擎谁跟着谁走"选：

```bash
# ① 仓库根 bundle（dsh-bundle.yml 的 row 名是 amberflow/dsh-plugin，进程用整仓库）
dsh plugin --profile <name> add /path/to/AmberFlow

# ② 只装嵌套包（进程用这一份包，宿主包仍由 DSH 提供）
dsh plugin --profile <name> add /path/to/AmberFlow/integrations/dsh-bridge
dsh plugin --profile <name> remove @deepseek-ai/dsh-amberflow-bridge
```

`package.json` 的 `dsh.bundle.patch` 让装进来的包自动进 `dsh.profile.bundles`，所以两条通道
都不需要手写 patch；**开发机**再往 profile 的 `cordis.patch.yml` 加一条显式 `repoPath`，读起来
没有歧义：

```yaml
- id: amberflow-bridge           # 与 dsh-bundle.yml 的 row id 一致
  name: "amberflow/dsh-plugin"
  config:
    repoPath: /path/to/AmberFlow
```

### 一个实测到的坑：把"已安装的副本"换成 link 之后，**运行中的进程不会自己换代码**

`pnpm add <dir>` 装的是 `link:<dir>`（`node_modules/<pkg>` 是指向 checkout 的软链），所以
文件系统这一层立刻是新的：引擎 CLI（`repoPath` 下的 `src/*.ts`）、`apps/`、`$AMBERFLOW_HOME/apps`
都会立刻反映工作树。**但插件模块本身不会**——进程启动时那一次 `import()` 用的是当时解析出的
规范路径（Node 会 realpath），换成软链后同一个 specifier 解析到**另一个**路径，HMR 的重载候选
查找（按模块 URL 命中 loadCache）因此找不到它，`patchReload: live` 也只更新配置、不重新 import。

判据（哪个模块真的在跑，一秒就能测）：

- 工具 schema：新桥有 `tiered_hint` 参数（P1 加的）；`amberflow_run` 的参数表里没有它 = 跑的是旧模块；
- 用户作用域：`amberflow_apps` 列不列出 `$AMBERFLOW_HOME/apps` 里的包（本地桥的
  `appsDirsWith` 会列，旧版的 `listApps` 只看 checkout 的 `apps/`）。

结论：**换安装形态之后重启一次 DSH 进程**（重启的是宿主进程，不是另起一个 server）。之后每次
改本仓库的 `src/`，引擎侧照旧立刻生效（CLI 是子进程现读文件），改桥自己的 `src/` 则需要 HMR
或再重启一次。

## 热重载（可选）

DSH profile 补丁里把 HMR 的 `root` 指向本目录，重建 `lib/` 后会自动重载，不必重启：

```yaml
- id: hmr
  name: "@deepseek-ai/dsh-hmr"
  config:
    root:
      - /path/to/AmberFlow/integrations/dsh-bridge
    followSymlinks: false   # 必需：node_modules/@deepseek-ai/* 是指向 DSH 安装的软链
```
