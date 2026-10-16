#!/usr/bin/env bash
# Offline regression gate for LayaWebUse (TypeScript)。
#
#   bash bench/smoke.sh
#
# 1/3 类型检查 + 全部单元测试（含仓库不变量：单栈、公共出口、strip-only 兼容、迁移完整性）
# 2/3 六层跨实现对拍：rules / extraction / executor / datasource / ctrip / transfer
# 3/3 冻结计划跑分矩阵的离线夹具用例（真浏览器，走生产执行器循环）
#      + ctrip 用例端到端（冻结计划 → 生产循环 → 独立判分）
#      + 同一流程由 transfer/specs/skybook.json 驱动
#
# 1/3 与 2/3 完全离线、无模型、无网络，永远是无条件门禁。
# 3/3 需要 1.7GB 的 ONNX 产物（见 node-port-poc/README.md）：
#   有 → 实跑；没有 → 打印 SKIP 原因并跳过（设 SMOKE_REQUIRE_MODEL=1 则改为硬失败）。
#
# CI 直接调用本脚本（.github/workflows/checks.yml），所以它仍是"绿色"的唯一定义。
set -uo pipefail
cd "$(dirname "$0")/.."

NODE="${NODE:-node}"
STRIP="--experimental-strip-types"
OUT="${SMOKE_OUT:-${TMPDIR:-/tmp}/layawebuse-smoke}"
ARTIFACT="${LAYA_ONNX_PATH:-/tmp/laya_dec.onnx}"
fail=0

run () { # run <标题> <命令...>
  echo
  echo "### $1"
  shift
  "$@" || fail=1
}

echo "### 1/3 typecheck + 单元测试"
npm run --silent typecheck || fail=1
if [ "$fail" -eq 0 ]; then npm run --silent test || fail=1; fi

run "2/3 六层跨实现对拍" npm run --silent test:parity
# 生成的包必须与 spec 的展开一致（构造性质；改 spec 没重新生成、或手改了 journey，这里就红）
run "2b 应用包与 spec 展开一致（apps:gen --check）" npm run --silent apps:gen -- --check --quiet
# 探针基线：包里的判决必须等于已入库探测记录（站点变了/有人手改包，都会在这里变红）
run "2c 探针基线与探测记录一致（probes:baseline --check）" npm run --silent probes:baseline -- --check --quiet
# 2d 提名实验台的冻结产物（S0 证据）：语料计数 + 规则/基线/枚举三臂 + 闭集/序必须与
#    bench/instruction-nomination/nomination.json 一致——改词表或改夹具却"忘了重跑 S0"，
#    这里就红（冻结产物没有门禁就会静默漂移）。离线部分无条件跑；model 臂见 3e。
run "2d 提名实验台与冻结产物一致（nominate:measure --check --no-model）" \
  npm run --silent nominate:measure -- --check --no-model
# 2e 可选门禁：integrations/dsh-bridge 是 DSH 的适配器（把引擎的 CLI 接成三个模型可见工具）。
#    它需要一份 DSH 安装提供宿主包（cordis / dsh-tools / schemastery…），因此**不进无条件门禁**：
#    设了 DSH_ROOT 就实跑它的离线测试，没设就 SKIP 并打印原因（跳过 ≠ 通过）。
if [ -d integrations/dsh-bridge ]; then
  if [ -n "${DSH_ROOT:-}" ] && [ -d "${DSH_ROOT}/packages/core/tools" ]; then
    run "2e DSH 插件 integrations/dsh-bridge（离线测试，宿主 $DSH_ROOT）" \
      bash -c "cd integrations/dsh-bridge && node scripts/setup-links.mjs && npm run --silent build && node ../../node_modules/vitest/vitest.mjs run tests/bridge.spec.ts tests/service.spec.ts"
  else
    echo
    echo "SKIP: integrations/dsh-bridge 未跑（它是 DSH 的适配器，需要一份 DSH 安装提供宿主包）。"
    echo "      设 DSH_ROOT=/path/to/deepseek-harness 即可让它进入本次门禁；真机测试需要 chromium，"
    echo "      录制那条还需要 ONNX 产物。"
  fi
fi

echo
echo "### 3/3 模型侧用例（夹具跑分 / ctrip / transfer）"
if [ -f "$ARTIFACT" ] && [ -f "$ARTIFACT.data" ]; then
  run "3a 夹具跑分（真 ONNX，生产执行器循环）" \
    "$NODE" "$STRIP" src/bench.ts --fixtures-only --mode-tag smoke --out "$OUT/bench"
  # 与**冻结语料**对拍的命令都必须在钉住的展开日期下跑：ctrip/transfer 用例的"下周"由当天日期算出，
  # 而期望值来自提交进仓库的那一周（2026-10-05..09）。不钉住的话同一个提交周日绿、周一红
  # （本轮实测：apps:gen --check 7 个漂移、tests/transfer.test.ts 15 条、transfer-parity 41 项、
  #  smoke 3b/3c 各 0/7）。单一出处见 tools/frozen-today.ts。
  run "3b ctrip 用例端到端（19 子目标 + 独立判分 7/7）" \
    env LAYA_TODAY="${LAYA_TODAY:-2026-10-02}" "$NODE" "$STRIP" src/ctrip-task.ts --quiet --out "$OUT/ctrip"
  # transfer 用例对拍的是**冻结语料**（提交进仓库的 Python 结果，那一周是 2026-10-05..09），
  # 所以展开日期必须钉住：不然周日绿、周一红（本轮实测）。
  run "3c transfer 用例（spec 驱动，skybook）" \
    env LAYA_TODAY="${LAYA_TODAY:-2026-10-02}" "$NODE" "$STRIP" src/transfer-task.ts --site skybook --quiet --out "$OUT/transfer"
  # R1（第二次目的审查）：漂移族真模型臂——把"模型能不能兜回声明失效的红格"变成常设账。
  # --check 逐格比 done 与 bench/drift-real-arm.json（当前冻结 0/3）；某格翻绿会红，
  # 逼作者显式 --write 刷新 + 改 tests/drift-real-arm.test.ts 的期望，而不是悄悄发生。
  run "3d 漂移族真模型臂与冻结产物一致（drift-real-arm --check）" \
    "$NODE" "$STRIP" tools/drift-real-arm.ts --check
  # 3e 提名实验台的 model 臂（默认关：165 次真前向约 10 分钟；设 NOMINATE_CHECK_MODEL=1 打开）。
  #    它把 S0 报告里那个"model 4.8%"从头再算一遍——数对不上就红，不是引用一句结论。
  if [ "${NOMINATE_CHECK_MODEL:-0}" = "1" ]; then
    run "3e 提名实验台 model 臂与冻结产物一致（nominate:measure --check）" \
      npm run --silent nominate:measure -- --check
  else
    echo
    echo "SKIP: 3e 提名实验台 model 臂未比（165 次真前向 ≈10 分钟）；设 NOMINATE_CHECK_MODEL=1 让它进本次门禁。"
    echo "      离线三臂已由 2d 无条件验证；跳过 ≠ 通过。"
  fi
elif [ "${SMOKE_REQUIRE_MODEL:-0}" = "1" ]; then
  echo "FAIL: ONNX 产物缺失（$ARTIFACT / $ARTIFACT.data）但 SMOKE_REQUIRE_MODEL=1"
  echo "      补齐：npm run model:fetch -- --from <url 或本地路径>（SHA256 可钉；见 npm run doctor 的缺件点名）"
  fail=1
else
  echo "SKIP: 未找到 ONNX 产物（$ARTIFACT / $ARTIFACT.data）"
  echo "      一条命令补：npm run model:fetch -- --from <url 或本地路径>；导出方法见 node-port-poc/README.md。"
  echo "      设 SMOKE_REQUIRE_MODEL=1 可让缺失变成失败。"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "SMOKE: PASS (results in $OUT)"
else
  echo "SMOKE: FAIL"
fi
exit "$fail"
