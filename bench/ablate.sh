#!/usr/bin/env bash
# 消融矩阵：english|multilingual × rules on|off。
# 每个模式跑同一个 bench/cases.json（真实 ONNX 模型），产物落 bench/results/<tag>-<stamp>.json。
#
#   ./bench/ablate.sh [tag-prefix]
#
# 需要 ONNX 产物（见 node-port-poc/README.md）；缺产物时 bench 会报错而不是假装通过。
set -uo pipefail
cd "$(dirname "$0")/.."

NODE="${NODE:-node}"
STRIP="--experimental-strip-types"
PREFIX="${1:-ablate}"

run () { # run <tag> <bench 参数...>
  local tag="$1"; shift
  echo "### $PREFIX-$tag"
  if "$NODE" "$STRIP" src/bench.ts --mode-tag "$PREFIX-$tag" "$@" > "/tmp/$PREFIX-$tag.log" 2>&1; then
    grep -E '"cases_passed"|"subgoals_passed"|"total_secs"' "/tmp/$PREFIX-$tag.log" | tr -d ' '
  else
    echo "  FAILED (see /tmp/$PREFIX-$tag.log)"; tail -3 "/tmp/$PREFIX-$tag.log"
  fi
}

run en-rules-on  --force-model english
run en-rules-off --force-model english --force-rules off
run ml-rules-on  --force-model multilingual
run ml-rules-off --force-model multilingual --force-rules off

echo
echo "结果目录：bench/results/（已 gitignore）"
