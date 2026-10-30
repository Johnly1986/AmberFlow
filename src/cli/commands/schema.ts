/**
 * `amber schema ctx` —— 引擎语义契约的命令面（自描述运行时 · P0-A）。
 *
 * 无源码世界（打包发布）里 Agent 的语义知识来源。数据由 `support/schema-gen.ts`
 * 从引擎真源渲染；本命令只做三件事：
 *   输出（缺省/`--topic`）、写快照（`--out`）、快照比对（`--check`，漂移 exit 2）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { CliContext } from "../context.ts";
import { emitJson, say } from "../context.ts";
import { CliError, usageError } from "../errors.ts";
import { successEnvelope } from "../json.ts";
import { REPO } from "../../support/paths.ts";
import { renderSchemaCtx, SCHEMA_TOPICS } from "../../support/schema-gen.ts";

const USAGE = `usage: schema ctx [--topic <节>] [--out <文件>] [--check] [--json]

引擎语义契约（Agent 无源码自描述面）：facts/signals/hints/commands/budget/
navigation/flow_control/dry/stopcodes 九节，事实逐条标注源码出处。
--out  把完整契约写成 JSON 快照（构建/发布物；落 package dist/schema/ctx.json）
--check 与快照比对（键序敏感的确定性输出）；漂移 exit 2，hint 指路重新生成`;

/** 快照缺省落点：包根（REPO，dev checkout 或安装目录）dist/schema/ctx.json——随包发布的发布物。 */
const DEFAULT_SNAPSHOT = path.join(REPO, "dist", "schema", "ctx.json");

function stableJson(v: unknown): string {
  return JSON.stringify(v, null, 2) + "\n";
}

export async function runSchema(args: string[], ctx: CliContext): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        topic: { type: "string" },
        out: { type: "string" },
        check: { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean" },
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw usageError(`schema 参数不对：${msg}`, { next: ["amber schema ctx --json"] });
  }
  const v = parsed.values;
  if (v.help) { say(ctx, USAGE); return 0; }
  const positional = parsed.positionals.filter((p): p is string => typeof p === "string");
  if (positional.length !== 1 || positional[0] !== "ctx") {
    throw usageError("schema 目前只有 `amber schema ctx` 一个面", {
      hint: "用法：amber schema ctx [--topic <节>] [--out <文件>] [--check]",
      next: ["amber schema ctx --json"],
    });
  }
  const payload = renderSchemaCtx();
  const topic = typeof v.topic === "string" ? v.topic : null;
  let data: unknown = payload;
  if (topic !== null) {
    const sections = payload.sections as Record<string, unknown>;
    if (!(SCHEMA_TOPICS as readonly string[]).includes(topic)) {
      throw usageError(`未知 topic '${topic}'`, {
        hint: `可用：${SCHEMA_TOPICS.join(" / ")}`,
        next: ["amber schema ctx --json"],
      });
    }
    // facts 在契约顶层（不在 sections）；其余节从 sections 取。
    data = topic === "facts"
      ? { schema: payload.schema, topic, facts: payload.facts }
      : { schema: payload.schema, topic, section: sections[topic] };
  }

  // --check：与快照比对（整契约或同 topic 切片，同一渲染器输出，键序确定）。
  if (v.check === true) {
    const snapPath = typeof v.out === "string" && v.out !== "" ? v.out : DEFAULT_SNAPSHOT;
    if (!fs.existsSync(snapPath)) {
      throw new CliError("SCHEMA_SNAPSHOT_MISSING", `快照不存在：${snapPath}`, {
        exitCode: 2,
        hint: "构建/发布前先 amber schema ctx --out <文件> 生成快照。",
      });
    }
    let snapRaw: string;
    try { snapRaw = fs.readFileSync(snapPath, "utf-8"); } catch (e) {
      throw new CliError("SCHEMA_SNAPSHOT_UNREADABLE", `快照不可读：${snapPath}（${e instanceof Error ? e.message : String(e)}）`, { exitCode: 2 });
    }
    let snap: unknown;
    try { snap = JSON.parse(snapRaw); } catch (e) {
      throw new CliError("SCHEMA_SNAPSHOT_INVALID", `快照不是合法 JSON：${snapPath}（${e instanceof Error ? e.message : String(e)}）`, { exitCode: 2 });
    }
    const same = JSON.stringify(snap) === JSON.stringify(data);
    if (ctx.globals.json) {
      emitJson(ctx, successEnvelope("schema.check", { snapshot: snapPath, match: same, drifts: same ? [] : ["payload != snapshot（语义表或注记变了）"] }));
    } else {
      say(ctx, same ? `✓ 契约与快照一致：${snapPath}` : `✗ 契约与快照漂移：${snapPath}`);
    }
    if (!same) {
      throw new CliError("SCHEMA_DRIFT", "引擎语义与随包快照不一致（SCHEMA_DRIFT）", {
        exitCode: 2,
        hint: "重新生成快照：amber schema ctx --out " + snapPath,
      });
    }
    return 0;
  }

  // --out：写快照（构建/发布用；目录自动建）。
  if (typeof v.out === "string" && v.out !== "") {
    fs.mkdirSync(path.dirname(path.resolve(v.out)), { recursive: true });
    fs.writeFileSync(v.out, stableJson(data), "utf-8");
    if (ctx.globals.json || v.json === true) {
      emitJson(ctx, successEnvelope("schema", { written: v.out, bytes: stableJson(data).length }));
    } else {
      say(ctx, `✓ 契约快照已写：${v.out}`);
    }
    return 0;
  }

  if (ctx.globals.json || v.json === true) {
    emitJson(ctx, successEnvelope("schema", data));
  } else {
    say(ctx, stableJson(data));
  }
  return 0;
}
