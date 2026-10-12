/**
 * `tools/model-contribution.ts` —— 用**真决策模型**回答一个问题：
 * "如果作者不写 `target_hint`，模型能不能顶上？"
 *
 * 为什么要有这个工具：项目的主张是"决策模型的引入是为了简化流程配置、增加弹性与容错"，
 * 而语料里的实测却是 **94% 的步都点名了目标**（169/180），模型在一轮 apps:suite 里只被
 * 咨询 5 次、过关 0 次。这两件事必须放到同一张桌上：是模型顶不上，还是作者没给它机会？
 *
 * 做法（与生产执行器**同一个问题**，不是另写一个"考试"）：
 *   对每一个应用包的每一个浏览器步——
 *     1. 打开它的 `start_url`，用生产提取器 `extractElements` 拿元素池；
 *     2. 把这一步**人写的** `target_hint` 用 `hintMatch` 解成一个 ref（这是"人的答案"）；
 *     3. 用生产的 `BrowserMiddleware.pickElement(desc, pool, …)` 问模型（同一个 state 渲染、
 *        同一个 criteria 视图、同一个 shortlist k=8、同一个置信度口径）；
 *     4. 按**元素签名**比对两者（ref 是位置性的，每次重扫都重新编号）。
 *   输出：逐步明细 + 汇总（top-1 命中率、置信度分布、按文字系统分层、floor 扫描）。
 *
 * 复算：
 *   npm run model:fetch -- --from <产物目录>   # 或者用 node-port-poc/README.md 的导出配方
 *   node --experimental-strip-types tools/model-contribution.ts [--apps ctrip-case,transfer-trekly]
 *                                                                [--json] [--out /tmp/x.json]
 *
 * 诚实边界：
 *   - 只在**能解出人写 hint** 的步上比（解不出来的步没有"人的答案"，不计入命中率，但计数）；
 *   - `--limit` 可以限量；一次前向在本机 CPU 上约 0.5–1 s；
 *   - 这个工具**不执行动作**，只问"选哪个"，所以它不改变任何页面。
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import * as browserEnv from "../src/browser-env.ts";
import { BrowserMiddleware, type AnyPage, type PwLike } from "../src/executor.ts";
import { esig, extractElements, type Elem, type ElemPool } from "../src/extraction.ts";
import { createLayaOnnxRuntime } from "../src/laya-onnx.ts";
import { installLayaRuntime } from "../src/model.ts";
import { checkArtifacts, missingPieces, onnxModelPath } from "../src/model-artifacts.ts";
import { hintMatch } from "../src/rules.ts";
import { expandPack, listPacks, loadPack, type ExpandedStep } from "../src/app-pack.ts";
import { startUrl } from "../src/app-runner.ts";

const REPO = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

interface StepRow {
  app: string;
  step: number;
  desc: string;
  hint: string;
  pool: number;
  expected: string | null;          // 人写 hint 解出来的元素（渲染成一行）
  picked: string | null;            // 模型选的元素
  correct: boolean | null;          // null = 这一行没法判（hint 解不出来 / 模型没答）
  conf: number;
  shortlisted: boolean;
  /** 问法形状（§2）：full=passthrough（池 ≤ k），shortlist=重问子集，none=没提出候选。 */
  shape?: string;
  p_top1?: number | null;
  p_top2?: number | null;
  margin?: number | null;
  han: number;                      // 页面文字里汉字占比（分层用）
  secs: number;
}

/** 汉字占比：>0.05 视为 CJK 页面（与 Router 的脚本判定同量级，不做第二套 locale 结论）。 */
function hanRatio(text: string): number {
  const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, "");
  if (!letters) return 0;
  const han = (letters.match(/\p{Script=Han}/gu) ?? []).length;
  return han / letters.length;
}

const oneLine = (el: Elem): string => `${el.tag} "${el.label}"${el.id ? ` #${el.id}` : ""}${el.data_test ? ` [${el.data_test}]` : ""}`;

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      apps: { type: "string" },          // 逗号分隔；默认全部有浏览器步的包
      json: { type: "boolean", default: false },
      out: { type: "string" },
      limit: { type: "string" },
      quiet: { type: "boolean", default: false },
    },
  });

  const art = checkArtifacts();
  if (!art.ready) {
    console.error(`真模型不在（缺：${missingPieces(art).join(" / ")}）——这个工具的意义就是用真模型测，`
      + `缺产物时它不猜、也不退回脚本模型。\n  图：${onnxModelPath()}\n  补法：npm run model:fetch -- --from <url|本地目录>`);
    return 2;
  }
  installLayaRuntime(createLayaOnnxRuntime({ onnxPath: art.onnxPath, tokenizerDir: art.tokenizerDir! }));

  const want = values.apps ? new Set(String(values.apps).split(",").map((s) => s.trim())) : null;
  const limit = values.limit ? Number(values.limit) : Infinity;
  const pw: PwLike = { chromium: chromium as unknown as PwLike["chromium"] };
  const browser = await browserEnv.launch(pw);
  const mw = new BrowserMiddleware({});
  const rows: StepRow[] = [];

  try {
    for (const [, , packPath] of listPacks()) {
      const pack = loadPack(packPath);
      if (want && !want.has(pack.id)) continue;
      let expanded;
      try {
        expanded = expandPack(pack, {}, path.join("/tmp", `mc-${pack.id}.json`));
      } catch {
        continue;                                   // 坏包与探针包不参与（有别的门禁管它们）
      }
      const browserSteps = expanded.steps.filter((s): s is ExpandedStep => s.kind === "browser");
      if (!browserSteps.length) continue;
      for (const step of browserSteps) {
        if (rows.length >= limit) break;
        const sg = step.subgoal!;
        const hint = sg.target_hint ?? (sg.target_hints ?? [])[0] ?? "";
        const url = startUrl(sg.start_url ?? "");
        const ctx = (await (browser as unknown as {
          newContext(): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }>;
        }).newContext());
        const page = await ctx.newPage();
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          const elems: ElemPool = await extractElements(page as unknown as AnyPage);
          const expectedRef = hint ? hintMatch(hint, elems) : null;
          const text = await page.evaluate(() => (globalThis as { document?: { body?: { innerText?: string } } }).document?.body?.innerText ?? "");
          const t0 = Date.now();
          // §2：走 pickProposal，把"问法形状"与 p(top1)/margin 一起落进产物——
          // W4/R4 的停止条件（"两支 AUC ≥ 0.5 且 precision 高于现状"）必须能从这份 JSON 直接算出来，
          // 不能只有那个承载两种含义的 conf。
          const proposal = await mw.pickProposal(
            sg.desc, page as unknown as AnyPage, elems, new Set(), null);
          const pickedRef = proposal.choiceRef;
          const conf = proposal.entropyConf;
          const probs = proposal.probs;
          const secs = (Date.now() - t0) / 1000;
          const expectedEl = expectedRef !== null ? elems[expectedRef] : undefined;
          const pickedEl = pickedRef !== null ? elems[pickedRef] : undefined;
          const correct = expectedEl && pickedEl
            ? JSON.stringify(esig(expectedEl)) === JSON.stringify(esig(pickedEl))
            : null;
          rows.push({
            app: pack.id, step: step.index, desc: sg.desc, hint, pool: Object.keys(elems).length,
            expected: expectedEl ? oneLine(expectedEl) : null,
            picked: pickedEl ? oneLine(pickedEl) : null,
            correct, conf: Math.round(conf * 1000) / 1000,
            shortlisted: Object.keys(probs).length > 0 && Object.keys(probs).length < Object.keys(elems).length,
            shape: proposal.shape.kind,
            p_top1: proposal.pTop1 === null ? null : Math.round(proposal.pTop1 * 1000) / 1000,
            p_top2: proposal.pTop2 === null ? null : Math.round(proposal.pTop2 * 1000) / 1000,
            margin: proposal.margin === null ? null : Math.round(proposal.margin * 1000) / 1000,
            han: Math.round(hanRatio(String(text)) * 100) / 100,
            secs: Math.round(secs * 10) / 10,
          });
          if (!values.quiet) {
            const mark = correct === null ? "?" : correct ? "✓" : "✗";
            console.log(`  ${mark} ${pack.id}#${step.index} pool=${Object.keys(elems).length} conf=${conf.toFixed(2)} `
              + `han=${hanRatio(String(text)).toFixed(2)} | 人: ${expectedEl ? oneLine(expectedEl) : "(hint 未命中)"} `
              + `| 模型: ${pickedEl ? oneLine(pickedEl) : "(没答)"}`);
          }
        } catch (e) {
          if (!values.quiet) console.log(`  ! ${pack.id}#${step.index} 跳过：${e instanceof Error ? e.message : String(e)}`);
        } finally {
          await ctx.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  // ---- 汇总 ----------------------------------------------------------------
  const judged = rows.filter((r) => r.correct !== null);
  const right = judged.filter((r) => r.correct);
  const byScript = (cjk: boolean): StepRow[] => judged.filter((r) => (r.han > 0.05) === cjk);
  const acc = (rs: StepRow[]): string => rs.length ? `${right.filter((r) => rs.includes(r)).length}/${rs.length} (${Math.round(100 * right.filter((r) => rs.includes(r)).length / rs.length)}%)` : "-";
  const floors = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50];
  /**
   * `conf` 在 `pickElement` 里是**两个不可比的量**（docs/DECISION_MODEL_PURPOSE_REVIEW.md §2.3）：
   *   - passthrough（池 ≤ k=8）：`conf = 1 − 归一化熵`（在**全部**选项上算）
   *   - shortlist（池 > k）：模型被重问一次保留子集，`conf = max(子集概率)`
   * 合成一个数会得出"闸门不区分对错"的错误结论（实测：一支 AUC 0.233 **反向**、一支 0.587 弱正向）。
   * 所以摘要必须**分开报**，并且给一个 AUC（把"这一步答对了"当标签）。
   */
  const auc = (rs: StepRow[]): number | null => {
    const P = rs.filter((r) => r.correct), N = rs.filter((r) => !r.correct);
    if (!P.length || !N.length) return null;
    let hit = 0, tot = 0;
    for (const a of P) for (const b of N) { tot++; hit += a.conf > b.conf ? 1 : a.conf === b.conf ? 0.5 : 0; }
    return Math.round((hit / tot) * 1000) / 1000;
  };
  const branch = (shortlisted: boolean) => {
    const rs = judged.filter((r) => r.shortlisted === shortlisted);
    const pass = rs.filter((r) => r.conf >= 0.25);
    const ok = pass.filter((r) => r.correct);
    return {
      steps: rs.length,
      accuracy: rs.length ? Math.round((100 * rs.filter((r) => r.correct).length) / rs.length) / 100 : null,
      decided_at_floor_025: pass.length,
      right: ok.length,
      precision: pass.length ? Math.round((100 * ok.length) / pass.length) / 100 : null,
      conf_mean: rs.length ? Math.round((1000 * rs.reduce((a, r) => a + r.conf, 0)) / rs.length) / 1000 : null,
      auc_conf_vs_correct: auc(rs),
    };
  };
  const summary = {
    steps_measured: rows.length,
    judged: judged.length,
    hint_unresolved_or_no_answer: rows.length - judged.length,
    top1_accuracy: judged.length ? Math.round(100 * right.length / judged.length) / 100 : null,
    accuracy_latin_pages: acc(byScript(false)),
    accuracy_cjk_pages: acc(byScript(true)),
    conf: {
      mean: judged.length ? Math.round(1000 * judged.reduce((a, r) => a + r.conf, 0) / judged.length) / 1000 : null,
      max: judged.length ? Math.max(...judged.map((r) => r.conf)) : null,
      at_or_above_floor_025: judged.filter((r) => r.conf >= 0.25).length,
      auc_conf_vs_correct: auc(judged),
    },
    // 两把尺子分开报（见上面的注释）：这一栏才是"闸门该不该信"的依据。
    by_question_shape: {
      passthrough_pool_le_8: branch(false),
      shortlist_pool_gt_8: branch(true),
    },
    floor_sweep: floors.map((f) => {
      const pass = judged.filter((r) => r.conf >= f);
      const ok = pass.filter((r) => r.correct);
      const wrong = pass.length - ok.length;
      return {
        floor: f,
        model_decides: pass.length,                       // conf ≥ floor ⇒ 执行器会采纳
        right: ok.length,
        wrong,                                           // 采纳里错了几个（= 会点到别的元素）
        precision: pass.length ? Math.round(100 * ok.length / pass.length) / 100 : null,
        coverage: judged.length ? Math.round(100 * pass.length / judged.length) / 100 : null,
      };
    }),
  };

  if (!values.quiet) {
    console.log(`\n测得步数 ${summary.steps_measured}（可判 ${summary.judged}，`
      + `hint 未命中/模型没答 ${summary.hint_unresolved_or_no_answer}）`);
    console.log(`top-1 命中率 ${summary.top1_accuracy === null ? "-" : `${Math.round(summary.top1_accuracy * 100)}%`}`
      + ` ｜ 拉丁页 ${summary.accuracy_latin_pages} ｜ CJK 页 ${summary.accuracy_cjk_pages}`);
    console.log(`置信度 均值 ${summary.conf.mean} 最大 ${summary.conf.max} ｜ ≥0.25 的步 ${summary.conf.at_or_above_floor_025}/${summary.judged}`
      + ` ｜ AUC(conf→对) ${summary.conf.auc_conf_vs_correct}`);
    console.log("按问法形状拆开（两把不可比的尺子，别合成一个数）：");
    for (const [name, b] of Object.entries(summary.by_question_shape)) {
      console.log(`  ${name.padEnd(24)} n=${String(b.steps).padStart(3)} 命中 ${b.accuracy === null ? "-" : `${Math.round(b.accuracy * 100)}%`}`
        + ` ｜ floor 0.25 采纳 ${b.decided_at_floor_025}（对 ${b.right}，precision ${b.precision === null ? "-" : `${Math.round(b.precision * 100)}%`}）`
        + ` ｜ 均值 conf ${b.conf_mean} ｜ AUC ${b.auc_conf_vs_correct}`);
    }
    console.log("\nfloor 扫描（floor = 执行器采纳线；占位数 = 模型真正会决定的步、precision = 其中选对的比例）");
    console.log("floor  模型决定  precision  coverage");
    for (const s of summary.floor_sweep) {
      console.log(`${String(s.floor).padEnd(6)} ${String(s.model_decides).padStart(6)} ${String(s.precision ?? "-").padStart(10)} ${String(s.coverage ?? "-").padStart(9)}`);
    }
  }
  const payload = { generated_at: new Date().toISOString(), repo: REPO, summary, rows };
  if (values.out) {
    fs.mkdirSync(path.dirname(String(values.out)), { recursive: true });
    fs.writeFileSync(String(values.out), JSON.stringify(payload, null, 2), "utf-8");
    if (!values.quiet) console.log(`\n写 ${values.out}`);
  }
  if (values.json) console.log(JSON.stringify(payload, null, 2));
  return 0;
}

main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => {
  console.error(e);
  process.exit(1);
});
