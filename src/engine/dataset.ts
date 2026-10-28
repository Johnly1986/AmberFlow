/**
 * 具名数据集（NL Flow S1）——跨步参数传递的唯一管道。
 *
 * 设计文档 §2.3 的三条硬规则，这里各有一条实现对应：
 *
 *   1. **只进数据集，不进模型上下文**：跨步传递靠名字（`read(key)`），不靠模型"记得"——
 *      模型转述等于模型可以改值，一条传话链既不可复现也不可审计（红线②的推论）。
 *   2. **溯源**（`writtenBy`）：每个值能回答"哪个步写的"（约定 `stepId#attempt` 形状）；
 *      审计与 drift 定位依赖它（验收 §11.5：每个值 `written_by` 可查）。
 *   3. **失效**（`generation` + `stale`）：一步重跑（retries/重试）⇒ 它写过的条目
 *      generation+1 且**清值置陈旧**；绑定在解析那一刻现读最新 generation——
 *      **陈旧世代不可读**（`read` 返回 null ⇒ 下游 `needs_value` 结构化停、页面零副作用），
 *      错误停在当步，绝不静默级联（验收 §11.5 的负例）。
 *
 * 两条实现决定（都钉在 历史回归）：
 *   - **generation 单调**：write 到已存在的键、或 invalidate，都恰好 +1——每次状态迁移
 *     一个世代，审计可以数（"重跑后旧 generation 引用 = 0"由 `read` 只认最新保证）。
 *   - **陈旧不可读**：`read` 只返回最新且未陈旧的条目；陈旧条目只能从 `entriesView()`
 *     （审计面）看到——数据集不假装它没发生过。
 *
 * 本模块**零依赖**（不 import 引擎其他文件）：`bindings.ts` 只取它的类型
 * （`DatasetReader`），保持"解析是纯函数、存储是可注入的读取面"这一分界。
 */

/** 数据集里的一条记录（含审计面字段）。 */
export interface DatasetEntry {
  key: string;
  /** 最新值；`stale` 为 true 时被清空（不可读，见 `read`）。 */
  value: unknown;
  /** 溯源：最后写入者（约定 `stepId#attempt`）。失效不改写它——"谁写的"是历史事实。 */
  writtenBy: string;
  /** 世代号，从 1 起单调递增：每次 write（到已存在的键）或 invalidate 恰好 +1。 */
  generation: number;
  /** true = 已被失效（重跑清场），`read` 对它返回 null，直到同键被重新写入。 */
  stale: boolean;
}

/** 绑定解析面的最小读取契约（`bindings.BindingContext.dataset` 用；store 实现它）。 */
export interface DatasetReader {
  /** 最新且未陈旧的条目；键不存在、或已被失效 ⇒ null（调用方如实当作"没有值"）。 */
  read(key: string): DatasetEntry | null;
}

export interface DatasetStats {
  /** 全部条目数（含陈旧——审计面看得见历史）。 */
  entries: number;
  /** 当前可读的条目数。 */
  live: number;
  /** 累计失效次数（invalidate 触发的条目数，含同一条目多次失效）。 */
  invalidations: number;
}

const assertNonEmpty = (v: string, what: string): string => {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t) throw new Error(`dataset: ${what} must be a non-empty string`);
  return t;
};

export class DatasetStore implements DatasetReader {
  private readonly entries = new Map<string, DatasetEntry>();
  private invalidationCount = 0;

  /**
   * 具名写入（指令输出契约的落点）。键已存在 ⇒ generation+1（重写是新的状态迁移）；
   * 同一步重写自己的键同样 +1——"第 2 次尝试的值"与"第 1 次尝试的值"是两个世代。
   */
  write(key: string, value: unknown, writtenBy: string): DatasetEntry {
    const k = assertNonEmpty(key, "key");
    const by = assertNonEmpty(writtenBy, "writtenBy");
    const prev = this.entries.get(k);
    const entry: DatasetEntry = {
      key: k,
      value,
      writtenBy: by,
      generation: prev ? prev.generation + 1 : 1,
      stale: false,
    };
    this.entries.set(k, entry);
    return entry;
  }

  /** 最新且未陈旧的条目；其余一律 null——**陈旧世代不可读**（验收负例钉在这里）。 */
  read(key: string): DatasetEntry | null {
    const e = this.entries.get(key);
    return e && !e.stale ? e : null;
  }

  /**
   * 一步重跑的清场：该步写过的所有**存活**条目 ⇒ generation+1、清值、置陈旧。
   * 已陈旧的条目不动（重复清场是幂等的——同一 attempt 只失效一次）。
   * 返回被失效的键（调用方进 trace/报告）。
   */
  invalidateStep(writtenBy: string): string[] {
    const by = assertNonEmpty(writtenBy, "writtenBy");
    const hit: string[] = [];
    for (const e of this.entries.values()) {
      if (e.writtenBy !== by || e.stale) continue;
      e.generation += 1;
      e.stale = true;
      e.value = undefined;
      hit.push(e.key);
    }
    this.invalidationCount += hit.length;
    return hit;
  }

  /** 审计面：全部条目（含陈旧）。报告与 drift 定位从这里走，不从 `read` 走。 */
  entriesView(): readonly DatasetEntry[] {
    return [...this.entries.values()];
  }

  stats(): DatasetStats {
    let live = 0;
    for (const e of this.entries.values()) if (!e.stale) live += 1;
    return { entries: this.entries.size, live, invalidations: this.invalidationCount };
  }

  toJSON(): { entries: DatasetEntry[] } {
    return { entries: [...this.entries.values()] };
  }

  /** 坏档案响亮报错（与站点档案/学习档案同一口径：证据面不许静默损坏）。 */
  static fromJSON(data: unknown): DatasetStore {
    const store = new DatasetStore();
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error(`dataset: expected {"entries":[…]}; got ${typeof data}`);
    }
    const raw = (data as { entries?: unknown }).entries;
    if (!Array.isArray(raw)) throw new Error(`dataset: "entries" must be a list`);
    for (const e of raw) {
      if (typeof e !== "object" || e === null) throw new Error(`dataset: entry must be an object`);
      const rec = e as Record<string, unknown>;
      const key = typeof rec["key"] === "string" ? rec["key"] : "";
      if (!key) throw new Error(`dataset: entry.key must be a non-empty string`);
      const generation = rec["generation"];
      if (!Number.isInteger(generation) || (generation as number) < 1) {
        throw new Error(`dataset: entry ${JSON.stringify(key)} generation must be a positive integer`);
      }
      const stale = rec["stale"] === true;
      store.entries.set(key, {
        key,
        value: stale ? undefined : rec["value"],
        writtenBy: typeof rec["writtenBy"] === "string" ? rec["writtenBy"] : "unknown",
        generation: generation as number,
        stale,
      });
    }
    return store;
  }
}
