/**
 * app-runner 的 **CLI 入口**（从 app-runner.ts 拆出，F7）。
 *
 * 拆出的理由：`main`/`USAGE` 只做参数解析、列表与装配调用，运行本体（runApp/runScriptApp）
 * 留在 app-runner.ts；入口独立后 app-runner.ts 聚焦运行逻辑。
 * 内容与搬移前逐字节一致；`bin/amber.mjs` 与 cli/commands 的调用点不变
 * （app-runner.ts re-export `main`）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyConfiguredEnv } from "../support/apply-config-env.ts";
import { appOptions, cliBool, cliString, cliStrings, parseCliArgs } from "../support/cli-args.ts";
import { parseRunDefaults } from "../support/run-defaults.ts";
import { appsOutDir, ensureDir, userAppsDir } from "../support/amberflow-home.ts";
import { dryRunFlow, loadScriptApp, type LoadedScriptApp } from "./app-script.ts";
import { listAppDirs } from "./app-pack.ts";
import { SECRET_SLOT_NAME, maskSecretSlots, scrubSecrets, secretSlotKeys, secretValuesFromSlots } from "./redaction.ts";
import { checkArtifacts, missingPieces } from "../model/model-artifacts.ts";
import { resolveLocalCheckpoint } from "../model/checkpoint.ts";
import { activeProviderInfo, applySpecToRuntime, resolveProviderSpec, type ProviderInfo } from "../model/decision-provider.ts";
import { createHintMemory, type HintMemoryLike } from "../model/hint-memory.ts";
import { installLayaRuntime } from "../model/model.ts";
import { nextForStop, STOP_ESCALATION_TEXT } from "../engine/planning-playbook.ts";
import { appReportMarkdown, appReportHtml } from "./app-report-view.ts";
import type { AppRunResult } from "./app-runner.ts";
import { USAGE } from "./app-runner.ts";
import {
  runScriptApp, AppRunConfigError,
} from "./app-runner.ts";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // rc 文件坏 = 配置类用法错误：在任何腿出场之前逐行点名并 exit 2（src/support/rcfile.ts）。
  { const rc = applyConfiguredEnv(); if (rc.errors.length) { for (const e of rc.errors) console.error(e); return 2; } }
  // 打错的参数 → 一行点名 + usage，绝不甩 parseArgs 的堆栈（src/support/cli-args.ts 的体例）。
  const cli = parseCliArgs(argv, {
    allowPositionals: true,
    // A6 --walk 是 app-runner 专属调试旗标：在本入口并进共用旗标表（共用表文件不动）。
    options: { ...appOptions(), walk: { type: "boolean" } },
    usage: USAGE,
  });
  if (!cli.ok) return cli.code;
  const v = cli.values;
  if (cliBool(v, "help")) { console.log(USAGE); return 0; }
  // A6 防呆：walk 是真跑调试模式，dry 无浏览器、无导航可言——同给是用法错误（exit 2）。
  if (cliBool(v, "dry") && cliBool(v, "walk")) {
    console.error("--walk 与 --dry 互斥：walk 是真跑调试模式（ctx.step 同页重锚不重导航），dry 只展开调用序列、没有浏览器。");
    return 2;
  }
  // 运行参数的配置默认值（全局 < 项目 < 环境变量；CLI 旗标仍最优先）。
  const { defaults: runDefaults, errors: runDefaultErrors } = parseRunDefaults();
  if (runDefaultErrors.length) {
    for (const e of runDefaultErrors) console.error(e);
    return 2;
  }
  const quiet = cliBool(v, "quiet") || runDefaults.quiet === true;
  // headless/headful 都解析：CLI 显式 --headless 压过配置层的 runDefaults.headful（此前
  // --headless 被解析但不透传，rc 配了 headful=true 的机器上用户无法退出有头——透传修复）。
  // 两个旗标同时给 = 用法错误（与 run.ts 的互斥检查同一条纪律）。
  if (cliBool(v, "headless") && cliBool(v, "headful")) {
    console.error("--headful 与 --headless 只能选一个");
    return 2;
  }
  const headful = !cliBool(v, "headless") && (cliBool(v, "headful") || runDefaults.headful === true);
  const confirmUnsafe = cliBool(v, "confirm-unsafe");
  const confirmSafe = !confirmUnsafe && (cliBool(v, "confirm-safe") || runDefaults.confirmSafe !== false);
  const noSources = cliBool(v, "no-sources") || runDefaults.noSources === true;
  const tieredHint = cliBool(v, "tiered-hint") || runDefaults.tieredHint === true;
  const maxStepsRaw = cliString(v, "max-steps");
  let maxSteps: number | undefined;
  if (maxStepsRaw !== undefined) {
    maxSteps = Number(maxStepsRaw);
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      console.error(`--max-steps 需要正整数（收到 ${JSON.stringify(maxStepsRaw)}）`);
      return 2;
    }
  }
  if (cliBool(v, "list") || cliString(v, "app") === undefined) {
    for (const entry of listAppDirs()) console.log(`${entry.id.padEnd(22)} ${entry.script}`);
    if (cliString(v, "app") === undefined) {
      if (!cliBool(v, "list")) {
        console.log(); console.log(USAGE);
        return 2;
      }
      return 0;
    }
  }

  const slots: Record<string, unknown> = {};
  const cliSlotKeys = new Set<string>();
  for (const s of cliStrings(v, "slot")) {
    const i = s.indexOf("=");
    if (i <= 0) { console.error(`--slot needs k=v, got ${JSON.stringify(s)}`); return 2; }
    const key = s.slice(0, i);
    cliSlotKeys.add(key);
    if (Object.prototype.hasOwnProperty.call(slots, key)) {
      console.error(`--slot ${JSON.stringify(key)} 给了两次（${JSON.stringify(slots[key])} 与 `
        + `${JSON.stringify(s.slice(i + 1))}）：一个槽位只能有一个值`);
      return 2;
    }
    slots[key] = s.slice(i + 1);
  }
  const slotFileArg = cliString(v, "slot-file");
  if (slotFileArg !== undefined) {
    let raw: unknown;
    const slotFile = path.resolve(slotFileArg);
    try {
      try {
        const st = fs.statSync(slotFile);
        if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
          console.error(`[warn] --slot-file ${slotFile} 对 group/other 可读（mode ${(st.mode & 0o777).toString(8)}）；建议 chmod 600`);
        }
      } catch { /* stat 失败交给下面的 readFileSync 报清楚 */ }
      raw = JSON.parse(fs.readFileSync(slotFile, "utf-8"));
    } catch (e) {
      console.error(`--slot-file 读不了或不是 JSON：${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      console.error("--slot-file 顶层必须是对象（槽位名 → 值）");
      return 2;
    }
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const t = typeof value;
      if (t !== "string" && t !== "number" && t !== "boolean") {
        console.error(`--slot-file 的 ${JSON.stringify(key)} 必须是字符串/数字/布尔`);
        return 2;
      }
      if (Object.prototype.hasOwnProperty.call(slots, key)) {
        console.error(`--slot-file 的 ${JSON.stringify(key)} 被 --slot 覆盖`);
        continue;
      }
      slots[key] = value;
    }
  }
  for (const key of cliSlotKeys) {
    if (SECRET_SLOT_NAME.test(key)) {
      console.error(`[warn] --slot ${JSON.stringify(key)} 的明文会出现在进程参数/桥 argv；敏感值请用 --slot-file（或 meta/env）`);
    }
  }

  // --today：时钟缝（数据腿相对日期表达式 + ctx.runtime.today）。格式错是**用法错误**
  // （exit 2）；空缺 = 系统日期。2026-10-28 起不再是环境变量 LAYA_TODAY。
  let today: string | undefined;
  {
    const raw = cliString(v, "today");
    if (raw !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
        console.error(`--today 要是 YYYY-MM-DD（拿到 ${JSON.stringify(raw)}）`);
        return 2;
      }
      today = raw.trim();
    }
  }

  let loaded: LoadedScriptApp;
  try {
    loaded = await loadScriptApp(String(cliString(v, "app")));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const pack = loaded.pack;

  // 槽位名打错曾是**静默**的：不在声明里就是用法错误（exit 2），并且把已声明的列出来。
  const declaredSlots = new Set([
    ...Object.keys(pack.slots ?? {}),
    ...((pack.required_slots ?? []) as string[]),
  ]);
  const unknownSlots = Object.keys(slots).filter((k) => !declaredSlots.has(k));
  if (unknownSlots.length) {
    console.error(`--slot ${unknownSlots.map((k) => JSON.stringify(k)).join(", ")} not declared by app ${pack.id}`
      + (declaredSlots.size
        ? `（已声明：${[...declaredSlots].sort().join(", ")}）`
        : "（该应用没有声明任何槽位）"));
    return 2;
  }

  const outDir = path.resolve(cliString(v, "out") ?? appsOutDir());
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (e) {
    console.error(`--out ${JSON.stringify(outDir)} 建不出来：${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  // 模型层级在哪一层，**每个出口都要回答**（dry 也不例外——桥的 summary 靠它写
  // `model: on|off(missing)`，用户先要知道此刻跑在哪个层级，再谈结果可不可信）。
  const ablate = cliString(v, "ablate");
  if (ablate !== undefined && ablate !== "stub" && ablate !== "rules-only") {
    console.error(`--ablate 只接受 stub | rules-only（收到 ${JSON.stringify(ablate)}）`);
    return 2;
  }
  const providerWanted = cliString(v, "provider")
    ?? (ablate === "stub" ? "scripted-stub" : ablate === "rules-only" ? "none" : undefined);
  let spec;
  try {
    spec = await resolveProviderSpec(providerWanted);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const artifacts = checkArtifacts();
  const modelStatus = spec.tier;
  let localModelId: string | undefined;
  if (spec.kind === "laya" && !spec.ablation) {
    try {
      localModelId = resolveLocalCheckpoint(process.env, pack.model ?? "english");
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      return 2;
    }
  }

  if (cliBool(v, "dry")) {
    const dry = await dryRunFlow(loaded, {
      slots: slots as Record<string, string>,
      ...(today === undefined ? {} : { today }),
      ...(cliString(v, "out") === undefined ? {} : { outDir: cliString(v, "out") }),
    });
    const drySecretKeys = secretSlotKeys([...declaredSlots, ...Object.keys(slots)], pack.secret_slots);
  const drySecretValues = secretValuesFromSlots(slots, drySecretKeys);
    const planLike = {
      app: pack.id, label: pack.label, goal: pack.goal,
      mode: "flow", dry_run: true, slots: maskSecretSlots(slots, drySecretKeys), problems: dry.problems,
      events: dry.trace.events.map((e) => ({
        i: e.i, call: e.call, id: e.id, desc: e.desc, url: e.url,
        ok: e.ok ?? null,
        ...(e.stop_code === undefined ? {} : { stop_code: e.stop_code }),
      })),
      invariants: (pack.invariants ?? []).map((inv) => ({ id: inv.id, desc: inv.desc })),
      model_status: modelStatus,
    };
    console.log(JSON.stringify(scrubSecrets(planLike, drySecretValues), null, 2));
    if (dry.problems.length) {
      console.error(`flow dry-run 发现配置错误：\n  - ${dry.problems.join("\n  - ")}`);
      return 2;
    }
    return 0;
  }

  // 两层包装，各数一件事：缓存记“省下的重复提问”（零成本率），计数记“模型被咨询过几次”
  // （出场率）——计数在缓存**外面**：命中也是一次咨询，只是没花 forward。
  if (spec.kind === "laya" && !spec.ablation && !artifacts.ready) {
    console.log(`（模型产物不齐——缺 ${missingPieces(artifacts).join("/")}；需要模型兜底的步会如实 block。`
      + `补齐：npm run model:fetch -- --from <url 或本地路径>）`);
  }
  const applied = await applySpecToRuntime(spec);

  // R2：学习环的 sidecar。学到的永不进被审计的脚本（与 plan-cli 同一条纪律）。
  let hintMemory: HintMemoryLike | null = null;
  let hintMemoryPath: string | null = null;
  const hintMemoryArg = cliString(v, "hint-memory");
  if (cliBool(v, "learn-hints") || hintMemoryArg !== undefined) {
    hintMemoryPath = hintMemoryArg !== undefined && hintMemoryArg !== "on"
      ? path.resolve(hintMemoryArg)
      : path.join(path.dirname(userAppsDir()), "hint-memory", `${pack.id}.json`);
    try {
      ensureDir(path.dirname(hintMemoryPath));
    } catch (e) {
      console.error(`--hint-memory 落点建不出来：${hintMemoryPath}（${e instanceof Error ? e.message : String(e)}）`);
      return 2;
    }
    hintMemory = createHintMemory({ path: hintMemoryPath });
    if (!quiet) {
      console.log(`learned hints: ${hintMemory.stats?.().entries ?? 0} known（sidecar ${hintMemoryPath}）`);
    }
  }

  // --conf-floor：显式覆盖闸门刻度；范围错误是**用法错误**（退出码 2），不是静默忽略。
  let cliConfFloor: number | undefined;
  const confFloorFromCli = cliString(v, "conf-floor") !== undefined;
  const confFloorArg = cliString(v, "conf-floor")
    ?? (runDefaults.confFloor === undefined ? undefined : String(runDefaults.confFloor));
  if (confFloorArg !== undefined) {
    const n = Number(confFloorArg);
    if (!Number.isFinite(n) || n <= 0 || n > 1) {
      console.error(`--conf-floor 要是 (0, 1] 之间的数（拿到 ${JSON.stringify(confFloorArg)}）`);
      return 2;
    }
    cliConfFloor = n;
  }

  let result: AppRunResult;
  try {
    result = await runScriptApp(loaded, {
      slots, outDir, verbose: !quiet,
      ...(today === undefined ? {} : { today }),
      sources: !noSources, confirmSafe, captureTraces: cliBool(v, "trace"),
      maxSteps,
      manualFailFast: cliBool(v, "manual-fail-fast"),
      headful, allowDangerous: cliBool(v, "allow-dangerous"),
      tieredHint: tieredHint ? true : undefined,
      hintMemory, hintMemoryPath,
      confFloor: cliConfFloor,
      ...(cliConfFloor === undefined ? {} : { confFloorSource: confFloorFromCli ? "cli" as const : "config" as const }),
      providerFloor: activeProviderInfo()?.floor,
      modelStatus,
      ...(localModelId === undefined ? {} : { modelId: localModelId }),
      ...(cliString(v, "emit-trace") === undefined ? {} : { emitTrace: cliString(v, "emit-trace") }),
      ...(cliString(v, "replay") === undefined ? {} : { replayTrace: cliString(v, "replay") }),
      // A6：walk 调试旗标（默认关 = 不进 opts，产物逐字节不变）。
      ...(cliBool(v, "walk") ? { walk: true } : {}),
      runtimeStats: applied.stats ?? undefined,
      pickAsks: applied.asks ?? undefined,
      pickFailedAsks: applied.failedAsks ?? undefined,
    });
  } catch (e) {
    if (e instanceof AppRunConfigError) {
      console.log(e.message);
      console.log(`（未开跑：0 步、0 副作用；配置类错误不进重试循环）`);
      return 2;
    }
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  } finally {
    installLayaRuntime(null);
  }

  const jsonPath = path.join(outDir, `${pack.id}-result.json`);
  const mdPath = path.join(outDir, `${pack.id}-report.md`);
  const htmlPath = path.join(outDir, `${pack.id}-report.html`);
  // 规划引导：失败时按停因给一行「下一步建议」（flow 级 stop_code 优先，步级兜底）。
  const nextHint = runNextHint(result);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf-8");
  // 人读的 md 带 UTF-8 BOM：Windows PowerShell 5.1 的 Get-Content 对无 BOM 文件按 ANSI
  // 读 → 中文全花屏（2026-11-09 取证：无 BOM 读出「杩愯鎶ュ憡」，带 BOM 正确）。
  // JSON 产物保持无 BOM——Node 的 JSON.parse 不容 BOM（读取必须显式 UTF-8，见
  // docs/APP_SCRIPT_AUTHORING.md「运行产物」）。BOM 只在写盘面加；stdout 打印不加。
  fs.writeFileSync(mdPath, "\uFEFF" + appReportMarkdown(result, nextHint), "utf-8");
  fs.writeFileSync(htmlPath, appReportHtml(result, nextHint), "utf-8");
  if (!quiet) {
    console.log();
    console.log(appReportMarkdown(result, nextHint));
    // 停因摘要（stdout 一行，不再只藏在 result.json 深层）：失败时 Agent 第一眼可见。
    if (!result.ok && result.script?.stop_code !== undefined) {
      console.log(`停因：${result.script.stop_code}：${String(result.script.stop_reason ?? "").split("\n")[0].slice(0, 160)}`);
    }
    if (nextHint) console.log(`下一步建议：${nextHint}`);
    // 停手出口（唯一出处 planning-playbook）：失败即输出，不依赖 next 是否存在——
    // 否则停因类豁免（needs_human 等）既无回流建议也无终止条件。
    if (!result.ok) console.log(`停手规则：${STOP_ESCALATION_TEXT}`);
    if (result.hint_memory) {
      console.log(`learned hints: ${result.hint_memory.entries} known, `
        + `${result.hint_memory.used} reused this run（sidecar ${result.hint_memory.path}）`);
    }
    console.log(`写入 ${jsonPath}、${mdPath} 与 ${htmlPath}`);
  }
  // 执行预算用满 = 主动停在半路；它不是“失败”，但也不是完整验收。
  return result.ok || result.partial === true ? 0 : 1;
}

/**
 * run 失败时的一行「下一步建议」（planning-playbook.nextForStop）：flow 级停因优先
 * （`ctx.fail` 的 code / 预算），其次第一个带 stop_code 的步，再退到第一个失败步的
 * `result.stopCode`。命中不了映射表就返回 null——宁可不建议，不给泛泛而谈。
 */
export function runNextHint(r: AppRunResult): string | null {
  if (r.ok) return null;
  const code = r.script?.stop_code
    ?? (r.step_traces ?? []).find((t) => t.stop_code !== undefined)?.stop_code
    ?? (r.step_traces ?? [])
      .map((t) => (t.result as { stopCode?: unknown } | undefined)?.stopCode)
      .find((c) => typeof c === "string" && c !== "");
  return typeof code === "string" && code !== "" ? nextForStop(code) : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
