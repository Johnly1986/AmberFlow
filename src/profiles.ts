/**
 * 站点清单：现在只是"加载哪个 spec"。
 *
 * 流程本身（角色序列、描述模板、三件套）在 `transfer/specs/*.json` 里 —— 这个文件
 * 不再装任何站点知识，只剩两个名字；新增站点时连这里都不用改，因为
 * `transfer-task.ts --site <name>` 会直接去 `specs/<name>.json` 找。
 *
 * 边界（仍然留在代码里的东西，且是有意留的）：
 *   * **库存**：每个站点的数据生成器（`ctrip-data.ts`、`transfer-data2.ts`）——它是站点
 *     内容，不是流程；
 *   * **判分**：独立口径（`verifyWith`）与数据模块的对接 —— 判分必须是与执行器无关的
 *     第二实现，写进配置就失去意义了。
 */
import { loadSpec, type FlowSpec } from "./flow.ts";

export const CTRIP: FlowSpec = loadSpec("ctrip");
export const SKYBOOK: FlowSpec = loadSpec("skybook");

export const PROFILES: Readonly<Record<string, FlowSpec>> = { ctrip: CTRIP, skybook: SKYBOOK };
