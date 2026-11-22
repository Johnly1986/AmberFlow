/**
 * 模型面字段白名单断言（S3 前半；非门禁）：`modelProjectionOf` 的**泄漏/过剥双检**。
 *
 * 为什么需要它：模型面剥离靠 `modelProjectionOf` 里**手写的 guard + 解构两处名单**——
 * 新增一个采集期事实字段时，只改一处或漏改都会让"诊断事实"静默进模型题面（或把核心字段
 * 静默剥掉）。本工具用一个携带全部采集期字段的合成池断言：
 *   ① 13 个采集期事实字段一个都不出现在模型面；
 *   ② 核心字段一个都不少、值不变；
 *   ③ 输入池不被改写（纯函数）；
 *   ④ 无诊断字段的行走快路径且语义不变；
 *   ⑤ 已知签名（`esig`）不受剥离影响。
 *
 * 用法：node --experimental-strip-types tools/verify-model-face.ts
 * 退出码：0 全过 / 1 断言失败。
 */
import assert from "node:assert/strict";
import { modelProjectionOf } from "../src/engine/executor-pure.ts";
import { esig, type Elem, type ElemPool } from "../src/engine/elem-model.ts";

/** 采集期事实字段（`modelProjectionOf` 必须剥离；新增同类字段先加进这里 + 剥离名单）。 */
export const DIAGNOSTIC_FIELDS = [
  "surface", "href_full", "identity", "declared", "frame_origin", "frame_path",
  "structure_path", "structure_unstable", "row_texts", "row_index",
  "contains_candidate", "kind", "prominence",
] as const;

/** 核心字段（模型面必须保留；与本工具的合成池一致）。 */
const CORE: Record<string, unknown> = {
  tag: "button", label: "确认", role: "button", id: "b1", data_test: "go",
  href: "/next", input_type: "text", scan: 7, near: "结果卡",
};

/** 一行"脏"元素：核心字段 + 全部 13 个采集期字段。 */
function dirtyElem(): Elem {
  return {
    ...CORE,
    surface: "native-control",
    href_full: "/next?full=1",
    identity: { id: "b1" },
    declared: { mode: "id", value: "b1" },
    frame_origin: "https://example.test",
    frame_path: ["https://example.test"],
    structure_path: [{ tag: "main" }, { tag: "button" }],
    structure_unstable: true,
    row_texts: ["第一行", "第二行"],
    row_index: 1,
    contains_candidate: true,
    kind: "container",
    prominence: 1234,
  } as unknown as Elem;
}

/** 一行"干净"元素（无任何采集期字段 → 走快路径）。 */
function cleanElem(): Elem {
  return { ...CORE } as unknown as Elem;
}

function main(): number {
  const raw: ElemPool = { e0: dirtyElem(), e1: cleanElem() };
  const projected = modelProjectionOf(raw);

  // ① 采集期字段一个都不出现
  for (const field of DIAGNOSTIC_FIELDS) {
    assert.equal(Object.prototype.hasOwnProperty.call(projected["e0"]!, field), false,
      `模型面泄漏了采集期字段 ${field}`);
  }

  // ② 核心字段一个不少、值不变
  for (const [k, v] of Object.entries(CORE)) {
    assert.deepEqual((projected["e0"] as Record<string, unknown>)[k], v, `模型面丢了核心字段 ${k}`);
  }

  // ③ 纯函数：输入不被改写
  assert.equal(Object.prototype.hasOwnProperty.call(raw["e0"]!, "surface"), true, "输入池被改写（surface 丢失）");
  assert.equal(raw["e0"]!["prominence"], 1234, "输入池被改写（prominence 变化）");

  // ④ 干净行快路径：原样透传（字段与值一致）
  assert.deepEqual(projected["e1"], raw["e1"], "干净行不得被改写");

  // ⑤ 签名不受剥离影响（诊断字段不进 esig）
  assert.deepEqual(esig(projected["e0"]!), esig(raw["e0"]!), "esig 不得受模型面剥离影响");

  // 泄漏反向检查：模型面的键集合必须等于核心字段集合（过剥也会在这里暴露）
  const projectedKeys = Object.keys(projected["e0"] as Record<string, unknown>).sort();
  const coreKeys = Object.keys(CORE).sort();
  assert.deepEqual(projectedKeys, coreKeys, `模型面键集合与白名单不一致：${projectedKeys.join(",")}`);

  console.log(`verify-model-face: OK — ${DIAGNOSTIC_FIELDS.length} 个采集期字段全部剥离、${coreKeys.length} 个核心字段保留、输入未被改写`);
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(`verify-model-face: FAIL — ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
