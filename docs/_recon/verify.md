# 独立复核：docs/FLOW_AUTHORING_ALTERNATIVES.md（只读，事实核验）
基线：HEAD `0eba98a`；被复核文件为 2026-10-24 00:34 的 387 行版本（Lead 初稿 357 行，复核期间改过一轮）。只读：未改源码/配置/git 状态；唯一写入本文件。下列命令均可在仓库根复跑。
## 一、六条最强论断（主动证伪）
| 论断 | 判决 | 证据（命令/输出） |
|---|---|---|
| (a) 53 个配置 JSON / 8 套 schema / 9 有血统 / 5 运行期写 / 39 无血统 | 成立（口径内） | 21 pack + 3 flow + 8 sources + (5 authored + 5 learned) profile + 7 spec + 3 cases + 1 rc = 53；`jq` 血统 9（8 generated_from + 1 recorded_from）；8 schema 是分类口径（全仓 `*.json` 97 个，冻结语料/结果/package.json 等不在此口径） |
| (b) `policy` 0 个包在用 | 成立 | `grep -l '"policy"' apps/*/pack.json` 无输出（exit 1）；`apps:matrix` policy 列全 `-`；键有实现，不是死键（消费 `src/app/app-runner.ts:688-744`，加载校验 `src/app/app-pack.ts:1004-1034`） |
| (c) 占位符正则只认 `[A-Za-z_][A-Za-z0-9_]*` ⇒ `{rows[0].price}`/`{n+1}` 写不出 | 措辞需修正 | 正则/String 属实（`src/app/app-pack.ts:359,374`）；但实测把 `start_url` 写成含 `{rows[0].price}`、`{n+1}` 的 cold-search-next 副本，`validatePack` 返回 `problems: []`（不替换、不报错，静默留字面量）——是"写得出但不生效"，不是"写不出"；"没有算术/列表下标"全局不成立（`src/data/datasource.ts:561-562` 的 len/time，`:784-799` 的 `date±Nday`；路径语言支持 `[0]`） |
| (d) 应用路径不校验 sources schema（validateSource 只有 2 个调用点） | 实质成立；措辞需修正 | 应用路径确未跑 `validateSource`（生产调用点仅 `src/data/datasource.ts:1583`、`tools/datasource-parity.ts:114`）；但"全仓只有 2 个"不成立——`tests/datasource.test.ts`(10)+`tests/cli-transport.test.ts`(9) 共 19 处直调；"app 侧只查存在性"不准确：`src/app/app-pack.ts:609-633` 还用 `loadSource` 对账 selects/counts；且 `src/app/app-runner.ts:590-592` 注释声称 `loadSource` 会跑 `validate_source`，与 `src/data/datasource.ts:1190-1216` 实现不符（注释错） |
| (e) `inexpressibleKeys` 在 --write 前拒绝写回 | 窄义成立；C1 推论不成立 | `tools/spec-to-pack.ts:391-415`、`:538-544` 确在写该包前 `return 1`；但生成器原样搬运 invariants/notes/device/probe/hosts/sources（`:344-356`，`skipTop` 含 probe `:393`），只拒 spec 无对应物的步级键（next/commands/max_step_visits/adjudicate）与未知顶层键；§C1"只要还需要在包里写判断就永远出不了循环"不成立；多目标 `--write` 非原子（`:532-544`，后面的包被拒时前面的已写） |
| (f) flow 的 next 已支持（spec_version 3），ARCHITECTURE.md:397 仍说不在白名单 | 成立 | `STEP_KEYS` 含 next（`src/flow/semantic-flow.ts:188-192`）；v2 写 next 红并指路 v3（`:315-320`）；运行时 `createPathWalk`（`:1360-1366,1528-1554`）；`tests/semantic-next.test.ts` 13 条；ARCHITECTURE.md:397 确为过期句。注：仓库 3 个 flow.json 全为 v2，无实际 v3 用例 |
## 二、附录「证据索引」逐行核验（387 行版共 29 行）

| # | 论断（缩写） | 判决 | 证据 |
|---|---|---|---|
| 1 | 53 JSON / 8 schema / 9 血统 / 5 运行期 / 39 无血统 | 成立（口径内） | 见 §一(a)；`config-surface.md` §一/§二 复跑命令一致 |
| 2 | 3880 行声明 / 187 旅程 / 170-175 hint / when7 retries12 next1 | 措辞需修正 | 文件内数字一致，但 `generated_at 2026-10-18` 已过期；重跑 `node --experimental-strip-types tools/arch-metrics.ts --out /tmp/arch-metrics-verify.json` = **3958 行 / 190 旅程 / 171-178 hint(96.1%) / 7-15-1** |
| 3 | 61% 机械内容、7 包 0 diff、7 轮复核 | 措辞需修正 | `bench/AUTHORING_ASSESSMENT.md:13-16,52-63,97-107` 行号/内容一致；但 61%/15 包是旧基线——`tools/arch-metrics.ts:7` 自认"「61% 机械行」是 15 包时代的旧数"；当前 21 包、journey+roles 61.7% |
| 4 | 21 包键 / 21 步键 / flow 16 步键 | 成立 | `PACK_KEYS`=21（`src/app/app-pack.ts:53-58`）；步键 9+6+5+`adjudicate`=21（`src/app/app-adapters.ts:31-43`+`app-pack.ts:149`）；flow `STEP_KEYS`=16（`semantic-flow.ts:188-192`） |
| 5 | `policy` 已加但 0 包使用 | 成立 | 见 §一(b) |
| 6 | 占位符只认该正则、slot 一律 String() | 成立 | `src/app/app-pack.ts:359,374`（"写不出"的判断另见 §一(c)） |
| 7 | 步内分支不可表达 / 步间分支与回边已可表达 | 成立 | ARCHITECTURE.md:394 明说子目标内部不可表达；`app-runner.ts:881-898`、`app-pack.ts:222-225`；唯一用 next 的包 `apps/cold-search-next` |
| 8 | 应用路径不校验 sources schema | 实质成立（措辞需修正） | 见 §一(d) |
| 9 | `bench/cases*.json` 无运行期校验 | 实质成立；措辞需修正 | 全仓无 validateCase 属实；"唯一读取点 bench.ts:247"不成立：`tools/cache_measure.ts:22`、`tools/hint_measure.ts:28` 也直接 parse `bench/cases.json` |
| 10 | 站点档案两套互斥 schema | 成立 | `PROFILE_KEYS` `semantic-flow.ts:193-196` vs `LearnedSiteFile` `semantic.ts:188-193`；authored 5 + learned 5（`find` 实测） |
| 11 | 生成器承认表达不全 | 窄义成立 | 行号与拒绝逻辑属实；"写判断就出不了循环"的推论不成立，见 §一(e) |
| 12 | JSON 里已经藏 JS（ledger_js，解析点 transfer-flow.ts:21-24） | 不成立（解析部分） | 字段属实（7 个 spec 有 `ledger_js`，`flow.ts:56`）；全仓 grep 无消费代码，`transfer-flow.ts:21-24` 只是迁移注释 → "从里面解析出 window.__XXX 名字"在 TS 侧未实现（死字段） |
| 13 | 28 事实平均 2.2 处 / 21 门禁 / 52% 咬过人 | 部分成立 | 21 门禁、11/21≈52% 属实（`alignment-cost.md` §计数）；但来源表 N 列逐行和 = **61**、剔 3 个生成副本 = **58**，文中写 62/60（2.2/2.1 经四舍五入仍成立，分子不符） |
| 14 | 同一提交打红五处（含 tests/ctrip.test.ts 3 条） | 成立 | `git show --no-patch a784e75` 正文列五处（apps:gen 7 漂移 / transfer.test 15 / ctrip.test 3 / transfer-parity 41 / smoke 3b/3c 各 0/7） |
| 15 | 「单一出处」仍有第二份日期副本 | 成立 | `bench/smoke.sh:75,79` 写死 `2026-10-02`；`tools/frozen-today.ts:13` 是常量出处 |
| 16 | `--slot foo=1` 曾假绿 | 成立 | `git show --no-patch 30ecc9a`；`src/app/app-pack.ts:836-841` 现报未知槽位 |
| 17 | datasource 五类内部引用加载期放行 | 成立 | 重跑 `/tmp/align-probe/src-crossref.mts`：五类"无问题"（另 `selects.key` 未声明也放行）；`src/data/datasource.ts:990` `auditRows` 取不到字段按 `""` 比 |
| 18 | 跨面（DOM/进程）同一坏输入的差分对拍不存在 | 成立 | `tests/tool-signals.test.ts:22` 只断言组合算子都在，无两表等价/跨面对拍 |
| 19 | hint 两份实现、漂移两次 | 成立 | `rules.ts:300,310`、`extraction.ts:785`；ARCHITECTURE.md:401-405（`#id` 单侧、`=` 漏折叠） |
| 20 | signal 双写 | 成立 | `signals.ts:179-191`、`tool-signals.ts:29-41`；校验 walker 也是两份（`plan.ts:257-` vs `tool-signals.ts:57-`） |
| 21 | when 漏校验（第三轮才发现） | 行号成立；归属需修正 | `src/engine/plan.ts:252-256` 注释属实；但 CLAUDE.md:311-312 明确 "found by the AUTHOR"（第 3 轮），不是复核发现；`apps/INVENTORY.md:73` 记"已修（第 3 轮）" |
| 22 | flow 的 next 已支持 vs ARCHITECTURE.md:397 | 成立 | 见 §一(f) |
| 23 | FROZEN_TODAY 四处红 | 不成立（本文自身矛盾） | 同一文档 §C4（387 行版 :182）写"五处"；`a784e75` 列五处；CLAUDE.md:126 写四处；`tools/frozen-today.ts:6-8` 写"三处"却列四项 |
| 24 | 5 个 `--check` 调用（4 个工具） | 成立 | `bench/smoke.sh:40,42,46-47,83-84,88-89`（apps:gen/probes:baseline/nominate:measure×2/drift-real-arm）；注意 3e 默认 SKIP（`:87` 条件） |
| 25 | 判分/执行循环/库存生成器不可配置 | 成立（范围需精确） | 内容在 `ARCHITECTURE.md:431-433`；`:424-430` 是 commands/bindings，不属该三条 |
| 26 | 已存在的 TS builder 先例 | 成立 | `src/cli/ip-config.ts:139 buildAppPlan`；`bench/AUTHORING_ASSESSMENT.md:168-186` §九 |
| 27 | plan:flow 会写 flow/profile 但不留血统 | 成立 | `src/flow/plan-flow.ts:855-857`、`:896-906`；`TEMPLATE_KEYS`/`PROFILE_KEYS` 无血统键 |
| 28 | NL 清单的现状与实测边界 | 措辞需修正 | `NL_FLOW_DESIGN.md:264` 成立（S0 低于傻基线、题目无效）；`:33-38` 是设计一句话，不是"现状/边界"；§5 C 的"五阶段已落地"不成立（同文件 S2/S4 标 ◐） |
| 29 | 录制/归纳的既有能力 | 成立 | `apps/README.md:467-504`（learn 落盘门槛 `:477`、induce `:481-492`、probes `:494-504`） |
## 三、其他需修正的断言（不在附录）
| 断言 | 判决 | 证据 |
|---|---|---|
| §0.3/§2.2「约 95% 的步是线性的一步、schema 复杂度为剩下 5% 长」 | 不成立 | 按其引用的同一批数：`when7+retries12+next1=20`；20/187=**10.7%**（或 20/175=11.4%），即约 89%/89%；"5%"只在剔除 retries（8/175≈4.6%）时出现，与句内列出 retries 自相矛盾；`docs/arch-metrics.json` 的 note 明确"引用时必须写明是哪套分母"，本文未写 |
| §1 行5「transfer/specs 7 个文件……8 个包由它生成」 | 不成立 | `generated_from` 实测：7 个 spec 上游（ctrip-case + 6 transfer）+ 1 个 source 上游（ip-config）；`bench/AUTHORING_ASSESSMENT.md:181` 自己写"8 个应用是生成的（7 个 spec + 1 个 builder）" |
| §7 #1「3880 行声明里非生成部分占多数」 | 未证实（口径未定义） | 按"生成器产出行"口径：8 个生成包的 journey+roles = 1372/3958 → 非生成 ≈65%（多数，成立）；按"非生成文件里的行"口径：1469(+238+175)/3958 ≈ 47.5%（少数，不成立）；两种读法结论相反 |

## 四、方案 A（TS 作者面→IR）与仓库已实测纪律

- **冲突（防泄漏/债计数门禁）**：§6 P1 称"apps:matrix 扫 `flows/`（照旧生效）"不成立——`tools/apps_matrix.ts:31` 只 `walkTs(REPO/src)`，泄漏/债扫描只遍历 SHARED（`:272,:287-305`）；仓库根 `flows/` 不在扫描面，作者代码里的站点知识不会被门禁抓到（§7 #6 同句同错）。
- **冲突（学习环落盘门禁）**：§6 P2"机器写 `flows/<id>.ts` → 人改 → 编译"未提现行硬纪律；`tools/learn.ts:621-668` 的写盘门槛是"规则模式 0 前向回放通过"（`:643` `verified = replay.ok && replay.forwards === 0`，`:653-668` 不通过则不写），先落 TS 源即绕过"回放不过一个文件都不落盘"（CLAUDE.md / apps/README.md:477）。
- **冲突（hint DOM 侧）**：P0 刀 3"页面侧只 query+stamp、语法解析复用池侧"与 CLAUDE.md:224 的实测纪律冲突——`hint_lookup` 必须"在同一 pass 内匹配并 stamp"（匹配后再 resolve 会因 DOM 变化取到不同元素，python.org 实测；`extraction.ts:403,783`）；匹配搬出页面后无法与 stamp 同 pass。
- **不冲突（已核对）**：执行循环单实现（A 运行时零改动，编译产物仍是 `pack.json`）；判分独立第二实现（明确不配置判分）；冻结语料逐字节（P1 硬门禁 8 包 0 diff，当前 `apps:gen --check` 实测 8/8 绿）；P0 刀 4 把 `validateSource` 接进应用路径——现有 8 个 sources 实测全部通过（8/8 ok），不破坏存量。

## 五、复跑命令

```bash
find apps -name pack.json | wc -l; find . -path ./node_modules -prune -o -name flow.json -print; find . -path ./node_modules -prune -o -path '*/sources/*.json' -print | wc -l
find apps bench -name '*.profile.json' | wc -l; find sites -name '*.profile.json' | wc -l; ls transfer/specs/*.json | wc -l; ls bench/cases*.json | wc -l
jq -r 'select(has("generated_from"))|input_filename' apps/*/pack.json; jq -r 'select(has("recorded_from"))|input_filename' apps/*/pack.json
grep -l '"policy"' apps/*/pack.json; grep -rn validateSource --include=*.ts . | grep -v node_modules
node --experimental-strip-types tools/arch-metrics.ts --out /tmp/arch-metrics-verify.json   # 当前语料：3958/190/171-178/7-15-1
npm run apps:gen -- --check --quiet          # 8/8；npm run apps:matrix -- --json | jq '{leaks:(.leaks|length),debt:(.debt|length)}' → 0/0
node --experimental-strip-types /tmp/align-probe/src-crossref.mts   # 注：探针脚本在 /tmp，未入库
```
