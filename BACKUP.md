# 备份说明：Python 参考实现（已删除，历史存于 bundle）

本仓库是 **TypeScript 单一技术栈**，不包含也不需要 Python 环境。原先的 Python 实现
（`layaapp/`、全部 `*.py` 驱动与测试、`requirements.txt`、fine-tune notebook）**曾**整体移出仓库，
位于 `/root/ML/LayaWebUse-python-reference-backup/`；经审查确认仓库对其没有任何依赖后，**该目录已删除**，
它的完整 git 历史保留在 bundle 里。

| 归档 | 位置 | 内容 |
|---|---|---|
| 历史 bundle | `/root/ML/LayaWebUse-python-history.bundle`（1.3 MB） | 完整 git 历史；标签 `python-original`（`0720a7b`，原作者最后提交）、`python-final`（`e1dbcc7`，TS 移植完成点）、`python-backports`（`155761b`，见下） |
| 冻结对拍语料 | 本仓库 `tools/*-corpus.json`、`tools/*-python.json` | 六个对拍层比较的 **Python 侧期望输出**，已入库；运行对拍不需要 Python |

```bash
git clone /root/ML/LayaWebUse-python-history.bundle /tmp/layawebuse-python   # 重建完整历史与工作树
git bundle verify /root/ML/LayaWebUse-python-history.bundle                  # "records a complete history"
```

## 删除前做了什么（可复核）

1. **审查无依赖**：仓库内没有 `*.py` / `requirements*.txt` / `pytest.ini` / `pyproject.toml`；
   `package.json` 脚本、CI、`bench/smoke.sh` 都不调用 Python；六个对拍工具只读**已入库**语料，
   语料里记录的绝对路径在加载时被重映射到当前仓库根（见 `tools/ctrip-parity.ts`、`transfer-parity.ts`），
   所以语料里的旧路径只是字符串，不要求备份存在。
2. **补齐归档**：备份工作区里还留着**未提交**的移植期回灌补丁——`layaapp/executor.py`（有 hint 时
   规则层只认 hint，不被 nav/affordance 抢答）、`layaapp/rules.py`（分级 hint 匹配）、
   `test_middleware.py`，以及重新生成的语料 `ts/tools/parity-corpus.json`（51 → 57 例）。
   先前的 `git bundle` 早于这些文件，因此它们此前只存在于一个未提交的工作区里。已先把它们提交并打标签
   `python-backports`，再 `git bundle create --all` 重建 bundle。
3. **恢复演练**：把 bundle clone 到临时目录，确认 `layaapp/executor.py`、`layaapp/rules.py`、
   `datasource.py`、`ctrip/ctrip_task.py`、`ts/tools/gen_parity_corpus.py` 与 **57 例语料**都在；
   演练目录随后删除。
4. **删除目录**，然后跑门禁复核：`npm run verify`（557 测试 + 六层对拍）与 `bash bench/smoke.sh` 全绿。

## 为什么当初要留、以及现在为什么能删

- **它是验收基准**：TS 移植的等价性不是声称的，而是机械对拍——`tools/*-corpus.json` 是 Python 侧生成的
  冻结期望，`tools/*-parity.ts` 在 TS 侧回放逐项比对（rules 57 例 / extraction 6 夹具 / executor 4 场景 /
  datasource 163 项 / ctrip 10 项 / transfer 67 项，含 `dump_js` 与报告的逐字节相等）。
  这些语料**已入库且不随实现漂移**，所以删掉生成它的实现不影响日常门禁。
- **实测结论与设计规范**保留在随仓库的文件里（`CLAUDE.md`、`ARCHITECTURE.md`、`PORTING.md`、`docs/`）。
- **参考实现与 TS 版曾保持同一套实测规则**（回灌补丁，见上），这些补丁现在都在 bundle 的
  `python-backports` 标签里。

## 需要知道的三件事

- **语料不能再生成**：生成器（`gen_*.py` / `dump_*.py`）如今只存在于 bundle 里。要更新语料必须先
  `git clone` bundle、准备 Python 环境、跑生成器，再把 JSON 拷回来。这是刻意的——冻结期望不应随实现漂移，
  但也意味着**没有 Python 就无法新增对拍层**。
- **ctrip 报告里那句 `python3 ctrip/live_probe.py` 是有意保留的**：它属于冻结语料逐字节比对的一部分
  （`CTRIP_RESULT.md` 逐字节相等），改成 TS 命令会让对拍失败且无法再生成语料。
  TS 侧对应入口是 `node --experimental-strip-types src/live-probe.ts`。
- **`qunar/results/`、`ctrip/results/`、`transfer/results/` 中被测试读取的产物仍在仓库内**
  （`QUNAR_RESULT.md`、`live_probe.json`、`live_capture/summary.json`、`ota_probe.json` 等）：
  它们是真实站点实测的**记录**，删除会让对应测试失去证据。
