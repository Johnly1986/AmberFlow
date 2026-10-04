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

echo
echo "### 3/3 模型侧用例（夹具跑分 / ctrip / transfer）"
if [ -f "$ARTIFACT" ] && [ -f "$ARTIFACT.data" ]; then
  run "3a 夹具跑分（真 ONNX，生产执行器循环）" \
    "$NODE" "$STRIP" src/bench.ts --fixtures-only --mode-tag smoke --out "$OUT/bench"
  run "3b ctrip 用例端到端（19 子目标 + 独立判分 7/7）" \
    "$NODE" "$STRIP" src/ctrip-task.ts --quiet --out "$OUT/ctrip"
  run "3c transfer 用例（spec 驱动，skybook）" \
    "$NODE" "$STRIP" src/transfer-task.ts --site skybook --quiet --out "$OUT/transfer"
elif [ "${SMOKE_REQUIRE_MODEL:-0}" = "1" ]; then
  echo "FAIL: ONNX 产物缺失（$ARTIFACT / $ARTIFACT.data）但 SMOKE_REQUIRE_MODEL=1"
  fail=1
else
  echo "SKIP: 未找到 ONNX 产物（$ARTIFACT / $ARTIFACT.data）"
  echo "      导出方法见 node-port-poc/README.md；设 SMOKE_REQUIRE_MODEL=1 可让缺失变成失败。"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "SMOKE: PASS (results in $OUT)"
else
  echo "SMOKE: FAIL"
fi
exit "$fail"
