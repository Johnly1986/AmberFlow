# Python 参考实现：已彻底移除

本仓库是 **TypeScript 单一技术栈**，也是本项目**唯一的版本**：首个提交 `07e1856`（"TypeScript 首版"）
就是 TS 实现，`git log --all --name-only` 里**从未出现过任何 `.py` 文件**。不需要 Python 环境，也不包含 Python 代码。

原先的 Python 参考实现（`layaapp/`、全部 `*.py` 驱动与测试、`requirements.txt`、fine-tune notebook）
曾整体移出仓库、位于 `/root/ML/LayaWebUse-python-reference-backup/`；在审查确认仓库对它没有任何依赖后，
**该目录已删除**；随后它的历史归档（git bundle）也**已删除**。现在磁盘上不再有任何 Python 相关文件。

## 仓库里仍与 Python 有关的东西（都不可移除，且运行时都不需要 Python）

| 东西 | 为什么留 |
|---|---|
| `tools/*-corpus.json`、`tools/*-python.json` | 六个对拍层的**冻结期望值**：Python 侧当年的输出，TS 侧回放逐项比对。删掉就无法证明等价性。 |
| 生成物文件头里的 `python3 xxx.py --write` | `ctrip/site/ctrip_data.js`、`transfer/siteN/dataN.js` 等由 Python 生成器写出；这行头**在逐字节比对范围内**。 |
| ctrip 冻结报告里的 `复现命令 python3 ctrip/live_probe.py` | 同上，属于逐字节比对文本（`CTRIP_RESULT.md`）。 |
| `src/live-probe.ts` 的 `python: null` | 有意保留：让探测记录与 Python 时代的产物 schema 兼容。 |
| 注释与文档里的"Python 语义""参考实现"等 | 说明 TS 版为何刻意与参考实现保持同一语义；属历史记录（`PORTING.md` / `CLAUDE.md`）。 |

## 后果（如实记录）

- **对拍语料不能再生成**：生成器随参考实现一起删除了。六个对拍层从此只对**已入库的冻结语料**运行；
  要新增对拍层，只能自行重建期望值。这是"期望值不随实现漂移"的代价。
- **等价性证据仍然完整**：语料在仓库里，`npm run verify` 每次都会逐项比对（rules / extraction /
  executor / datasource / ctrip / transfer，含 `dump_js` 与报告的逐字节相等）。

## 移除过程（可复核）

1. **审查无依赖**：仓库内无 `*.py` / `requirements*.txt` / `pytest.ini`；`package.json` 脚本、CI、
   `bench/smoke.sh` 都不调用 Python；对拍工具只读**已入库**语料，语料里的旧绝对路径在加载时被重映射到
   当前仓库根（见 `tools/ctrip-parity.ts`、`transfer-parity.ts`）。
2. **补齐归档**：备份工作区里还留着**未提交**的移植期回灌补丁（有 hint 时规则层只认 hint、分级 hint
   匹配、以及重新生成的 51 → 57 例语料）。先前 bundle 早于这些文件，所以先把它们提交并打标签
   `python-backports`，再 `git bundle create --all` 重建 bundle。
3. **恢复演练**：clone bundle 到临时目录，确认关键文件与 57 例语料都在。
4. **删除参考实现目录**，随后跑门禁复核：`npm run verify`（557 测试 + 六层对拍）与 `bash bench/smoke.sh` 全绿。
5. **修正可运行文档**：`ARCHITECTURE.md`、`ctrip/CTRIP_TESTCASE_REPORT.md`、`ctrip/results/README.md`、
   `transfer/*.md`、`CLAUDE.md` 里指向已删 `.py` 的命令改为 TS 入口；**只保留**逐字节比对产物里的字符串。
6. **删除历史 bundle**（本文档），再次复核门禁。

## 被测试读取的实测产物仍在仓库内

`qunar/results/`、`ctrip/results/`、`transfer/results/` 中的 `QUNAR_RESULT.md`、`live_probe.json`、
`live_capture/summary.json`、`ota_probe.json` 等是真实站点实测的**记录**：删除会让对应测试失去证据。
它们的产命令已改用 TS 入口，见 [ctrip/results/README.md](ctrip/results/README.md)。
