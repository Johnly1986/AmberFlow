/**
 * app 侧 RunScope 导入面。
 *
 * 实现（`createRunScope` 的默认值链与 `ctx.runtime` 投影）已下沉 L4 执行内核：
 * `src/engine/run-scope.ts`。这里只 re-export，既有 `from "./run-scope.ts"` 的调用点
 * 与类型导入零改动；唯一解析点仍是同一份实现。
 */
export { createRunScope, type RunScope, type RunScopeOptions } from "../engine/run-scope.ts";
