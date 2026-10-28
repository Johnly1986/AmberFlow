/**
 * flow/ 目录的共享基础。这个目录曾是 `transfer/flow.py` 的 TS 孪生（携程/transfer
 * 规格推导层），离线夹具与 transfer 规格删除后，推导层已死、整层移除；
 * 现在这里只剩信号归纳（`signal-induction.ts`）与仓库根路径的再导出。
 */
import { REPO } from "../support/paths.ts";

export { REPO };
