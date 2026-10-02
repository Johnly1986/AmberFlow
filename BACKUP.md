# 备份说明：Python 参考实现

本仓库现在是 **TypeScript 单一技术栈**。原先的 Python 实现（`layaapp/`、全部 `*.py` 驱动与测试、
`requirements.txt`、fine-tune notebook）已整体移出仓库并备份在两处：

| 备份 | 内容 |
|---|---|
| `/root/ML/LayaWebUse-python-reference-backup/` | 完整工作树 + 完整 git 历史（含 `.git`），标签 `python-final`（HEAD，含移植期的 Python 修正与回灌补丁）与 `python-original`（`0720a7b`，原作者最后提交） |
| `/root/ML/LayaWebUse-python-history.bundle` | `git bundle --all` 的可移植副本（`git bundle verify` 通过），可 `git clone` 到任意位置重建历史 |

## 为什么要留备份

1. **它是验收基准。** TS 移植的等价性不是声称的，而是机械对拍：仓库里的
   `tools/*-corpus.json` / `*-python.json` 就是 Python 侧生成的**冻结期望**，
   `tools/*-parity.ts` 在 TS 侧回放并逐项比对（rules 51 例 / extraction 6 夹具 /
   executor 4 场景 / datasource 163 项 / ctrip 10 项 / transfer 67 项，含 `dump_js` 与报告的逐字节相等）。
   这些语料由 Python 生成器（`gen_*.py` / `dump_*.py`）产出，**必须留在备份里**：
   用被测实现自己生成期望就不是独立参考了。
2. **实测结论与设计规范在其中。** `CLAUDE.md` / `ARCHITECTURE.md`（已随仓库保留）描述的
   实测规则、以及 ctrip / transfer / qunar 三个用例的原始报告都在备份中；TS 代码的注释大量引用它们。
3. **参考实现与 TS 版保持同一套实测规则。** 线上平台（`bench/cases-live.json`）暴露的分级 hint 匹配
   （`attr~v`：完全相等 → 末段路径 → 全子串；裸 token：整条 label → 整词 → 前缀 → 子串）与
   "有 hint 时规则层只认 hint、未命中落到模型"的优先级，已回灌到 `layaapp/rules.py` 与
   `layaapp/executor.py`；对拍语料随之重新生成（`ts/tools/parity-corpus.json`，51 → 57 例），
   Python 侧测试同步更新。**要再生成语料，必须回到这份备份里跑 `python3 ts/tools/gen_parity_corpus.py`。**
4. **回灌方向反过来也能用。** 移植期在 TS 侧发现的缺陷（replan 异常崩溃、when-skip 被判失败、
   裸 `elems[ref]`）已回灌进 Python 参考并加钉死测试（备份的 `python-final` 标签即含这些补丁），
   若将来需要再次对拍，这份参考是干净的。

## 如何使用

```bash
# 浏览备份（含历史）
cd /root/ML/LayaWebUse-python-reference-backup
git log --oneline | head
git checkout python-original        # 原作者最后提交的纯 Python 状态

# 从 bundle 重建
git clone /root/ML/LayaWebUse-python-history.bundle /tmp/layawebuse-python

# 重新生成对拍语料（需要备份 + Python 环境）
cd /root/ML/LayaWebUse-python-reference-backup
python3 ts/tools/gen_parity_corpus.py   # 其余 gen_*/dump_* 同理
```

## 需要知道的两件事

- **对拍语料是冻结的**：本仓库不再包含 Python，因此**不能**在仓库内重新生成 `tools/*-corpus.json`；
  要更新语料必须回到备份里跑生成器，再把 JSON 拷回来。这是刻意的——它保证期望值不会随实现漂移。
- **`qunar/results/`、`ctrip/results/`、`transfer/results/` 中被测试读取的产物仍在仓库内**
  （`QUNAR_RESULT.md`、`live_probe.json`、`live_capture/summary.json`、`ota_probe.json` 等）：
  它们是真实站点实测的**记录**，删除会让对应测试失去证据。
