/**
 * 应用运行报告的**渲染视图**（从 app-runner.ts 拆出，F7）。
 *
 * 拆出的理由：`appReportMarkdown` / `appReportHtml` / `invariantVerdictMd` 只读
 * `AppRunResult` 结构化结果并产出人读文本，不参与运行与判定；与数据源报告
 * （`data/report-view.ts`）同一分层逻辑——视图独立、口径单点。
 * 内容与搬移前逐字节一致。
 */
import type { AppRunResult } from "./app-runner.ts";
import { REFUSAL_LABELS } from "./app-runner.ts";
import { STOP_ESCALATION_TEXT } from "../engine/planning-playbook.ts";

/**
 * B3-1（P13）：这次运行**真的走到验收了吗**——报告不变量结论列的措辞判据。
 * flow 路径上 `ctx.done()` 要么全部成立（ok 保持 true），要么抛 `invariant_failed`——
 * 所以 `ok` / `stop_code=invariant_failed` 都意味着验收发生过；其余 ok=false 的停因态
 * （budget_exceeded / missing_done / 中途停）里 `held:false` 只是 invariantsFromTrace
 * 对"没有 done 事件"的缺省值，不是失败判决——结论列要说「未验收」，不冤枉不变量。
 */
function acceptanceReached(r: AppRunResult): boolean {
  return r.ok || r.script?.stop_code === "invariant_failed";
}

/** B3-1：不变量结论列（Markdown）——验收发生过才允许说「不成立」，没到验收点说「未验收」。 */
function invariantVerdictMd(r: AppRunResult, held: boolean): string {
  if (held) return "成立";
  return acceptanceReached(r) ? "**不成立**" : "**未验收（预算未到验收点）**";
}

/** 结构化结果 → 人读的 Markdown（应用级证据：数据腿 + 旅程 + 不变量）。 */
export function appReportMarkdown(r: AppRunResult, nextHint?: string | null): string {
  const L: string[] = [
    `# 应用运行报告：${r.label}（\`${r.app}\`）`,
    "",
    `- 应用脚本：\`${r.pack_path}\``,
    `- 目标：${r.goal}`,
    `- 结果：**${r.ok ? "通过" : r.partial === true ? "部分执行（预算用满）" : "未通过"}** ｜ 步骤 ${r.completed} ｜ 用时 ${r.secs}s`
      // P0-E：失败步摘要（仅 >0 才出现；受阻交付——run 绿但交付 null——从这里一眼可见）。
      + (r.steps_failed !== undefined && r.steps_failed > 0 ? ` ｜ **失败步 ${r.steps_failed}**` : "")
      // eval3 曝光面：警告一等公民（仅 >0 才出现；执行期诚实性证据，不是完成判死）。
      + ((r.warnings_count ?? (r.warnings?.length ?? 0)) > 0 ? ` ｜ **警告 ${r.warnings_count ?? r.warnings?.length}**` : ""),
    ...(r.script?.stop_code !== undefined
      ? [`- **结构化停因**：\`${r.script.stop_code}\`：${String(r.script.stop_reason ?? "").split("\n")[0].slice(0, 160)}`]
      : []),
    ...(r.model_status !== undefined
      ? [`- 模型层级：\`${r.model_status}\`（on=真 ONNX 在位；off(missing)=缺产物，走的是规则模式）`] : []),
    ...(r.decision_provider
      ? [`- 决策提供者：\`${r.decision_provider.name} ${r.decision_provider.version}\``
        + `（score=${String(r.decision_provider.capabilities.score_kind)}`
        + `${r.decision_provider.floor !== undefined ? `，闸门刻度 ${r.decision_provider.floor}` : ""}）`] : []),
    ...(r.effective_policy
      ? [`- 生效策略：${Object.entries(r.effective_policy)
          .filter(([, v]) => (v as { source: string }).source !== "default")
          .map(([k, v]) => {
            // S1：effect_readback 的 value 是对象——别让 String() 把它印成 [object Object]。
            const entry = v as unknown as { value: unknown; source: string };
            const shown = entry.value !== null && typeof entry.value === "object"
              ? JSON.stringify(entry.value) : String(entry.value);
            return `\`${k}=${shown}\`(${entry.source})`;
          }).join(" ")}`
        + `｜优先级 cli=本次命令覆盖 > app=meta 声明 > default=今天的行为`] : []),
    `- 角色：${(r.roles_used ?? []).map((x) => `\`${x}\``).join(", ") || "（未用角色模板）"}`,
    ...(r.dataset_view !== undefined && r.dataset_view.length > 0
      ? [`- 数据传递：${r.dataset_view.map((e) => `\`${e.key}=${JSON.stringify(e.value ?? null)}\``
        + `${e.stale ? "（陈旧）" : ""}（${e.writtenBy}）`).join(" ｜ ")}`]
      : []),
    `- 槽位（值只来自计划）：${JSON.stringify(r.slots)}`,
    ...(r.path_stop !== undefined
      ? [`- **走向停因**：\`${r.path_stop.code}\` ｜ 步 \`${r.path_stop.step_id}\` 被进入 ${r.path_stop.visits} 次：${r.path_stop.detail}`]
      : []),
    ...(r.path_visits !== undefined && Object.values(r.path_visits).some((n) => n > 1)
      ? ["- **走向**（`next` 边真的走回来了）："
        + Object.entries(r.path_visits).map(([k, n]) => `\`${k}\`×${n}`).join("、")]
      : []),
    ...(r.path_crossed !== undefined && r.path_crossed.length
      ? ["- **跨过的步**（声明式边跨过去，记成 skipped）：" + r.path_crossed.join("、")]
      : []),
    ...(nextHint ? ["", `> **下一步建议**：${nextHint}`] : []),
    ...(!r.ok ? ["", `> **停手规则**：${STOP_ESCALATION_TEXT}`] : []),
  ];
  if (r.env !== undefined) {
    // B2（P5）：环境与会话一行小节——数据类任务的结论受会话/日期/币种影响（R5/R6/R8），
    // 与 result JSON 的 `env` 同一份内容，紧挨「结果」；缺字段（旧声明式路径）整节省略，排版不变。
    const env = r.env;
    L.push("", "## 环境与会话", "",
      `- run_id \`${env.run_id}\` ｜ started \`${env.started_at}\` ｜ finished \`${env.finished_at}\``
      + (env.final_url !== undefined ? ` ｜ final_url \`${env.final_url}\`` : "")
      + (env.viewport !== undefined ? ` ｜ viewport ${env.viewport.width}×${env.viewport.height}` : "")
      + (env.user_agent !== undefined ? ` ｜ UA \`${env.user_agent}\`` : ""));
  }
  if (r.sources.length) {
    L.push("", "## 数据腿", "", "| 数据源 | 行数 | counts | selects | 工具版本 |", "|---|---|---|---|---|");
    for (const s of r.sources) {
      L.push(`| ${s.name} | ${s.rows} | ${JSON.stringify(s.counts)} | ${JSON.stringify(s.selects)} | ${s.tool_version ?? "-"} |`);
    }
    // preview 行：数据源声明了 `report.preview` 就把前 N 条**原始行**带进应用报告——
    // counts/selects 是结论，原始行是它的证据（"为什么是这个数"不该只能靠信）。
    for (const s of r.sources) {
      if (!s.preview || s.preview.rows.length === 0) continue;
      L.push("", `**${s.name} · ${s.preview.date} 前 ${s.preview.rows.length} 条（原始行）**`, "",
        `| ${s.preview.columns.join(" | ")} |`, `|${"---|".repeat(s.preview.columns.length)}`);
      for (const row of s.preview.rows) {
        L.push(`| ${s.preview.columns.map((c) => row[c] ?? "").join(" | ")} |`);
      }
    }
    if (r.source_slots !== undefined && Object.keys(r.source_slots).length > 0) {
      L.push("", `- 数据腿回写槽位：${Object.entries(r.source_slots)
        .map(([k, v]) => `\`${k}\`=\`${v}\``).join(" ｜ ")}（观测值压过包里的默认值；本次显式 --slot 仍最优先）`);
    }
  }
  if (r.subgoals.length) {
    L.push("", "## 动作腿：浏览器步（冻结计划）", "", "| # | 子目标 | 状态 | 尝试 | 障碍 |", "|---|---|---|---|---|");
    r.subgoals.forEach((s, i) => {
      L.push(`| ${i} | ${String(s.desc).slice(0, 80)} | ${s.status} | ${s.attempts} | ${s.obstacle ?? "-"} |`);
    });
    if (r.decisions !== undefined) {
      // 出场率一行（LAYA_VALUE_PLAN P1）：谁判的、模型救了几步、缓存省了几次——小计在表下，不散在日志里。
      if (r.risk_degraded) {
        L.push("", `- ⚠ **风险判定已退化**：${r.risk_degraded}`
          + `（本次只用关键词规则代替模型投票——这**不是**一次正常的风险闸门运行）`);
      }
      if (r.provider_degraded) {
        L.push("", `- ⚠ **决策服务已退化到规则模式**：${r.provider_degraded}`
          + `（provider 不可用/未配置——声明点名的步照跑，需要选目标的步按 rules-only 如实 block）`);
      }
      L.push("", `**决策来源**：${r.decisions.line}`
        + ` ｜ 模型出场 ${r.decisions.model_steps}/${r.decisions.total_steps} 步`
        + (r.decisions.model_steps === 0 ? "（model not needed——能规则化就别猜）" : ""));
    }
  }
  if (r.step_traces !== undefined && r.step_traces.length) {
    // task-8（评审 #12）：URL 列口径显式化——列头注明「步起」；数据取 `state.before.url`
    // （该步**开始**时刻的页面 URL）。缺步起记录的行（ctx.arrive / 无 state 的旧产物）显示
    // 步后落地 URL（`url` 字段）并在单元格内标注「（落地）」——两种口径不同格，不混读。
    L.push("", "## 执行轨迹（flow 的 ctx.step / ctx.arrive）", "",
      "| # | id | 说明 | 状态 | URL(步起) | 停因 |", "|---|---|---|---|---|---|");
    for (const t of r.step_traces) {
      const beforeUrl = typeof t.state?.before?.url === "string" && t.state.before.url !== ""
        ? t.state.before.url : null;
      const urlCell = beforeUrl !== null ? beforeUrl
        : (t.url !== undefined ? `${t.url}（落地）` : "-");
      L.push(`| ${t.index + 1} | ${t.id ?? "-"} | ${t.desc.slice(0, 80)} | ${t.status} | ${urlCell} | ${t.stop_code ?? "-"} |`);
    }
    L.push("", "- URL 列口径：**步起** = 该步开始时刻的页面 URL（`state.before.url`，S1 状态记录；"
      + "步内导航/动作前的页面）。标「（落地）」的行没有步起记录（`ctx.arrive` 不走执行器观察、"
      + "或旧产物无 state），显示的是步后落地 URL（`step_traces[i].url`）。");
  }
  // A1：动作执行证据小节——"执行了什么"与"为什么没执行"各一张表；没有证据的旧运行整节省略。
  const actionEvidence = (r.step_traces ?? []).filter((t) =>
    t.executed !== undefined || (t.executed_actions ?? []).length > 0
    || (t.skipped_actions ?? []).length > 0 || t.done_preheld !== undefined
    || (t.warnings ?? []).length > 0);
  if (actionEvidence.length) {
    L.push("", "## 动作执行证据（A1：执行了什么 / 为什么没执行）", "",
      "| # | id | executed | 执行动作（ref / how / changed） | 跳过（命令/候选 · 原因） | done_preheld | 警告 |",
      "|---|---|---|---|---|---|---|");
    for (const t of actionEvidence) {
      const acts = (t.executed_actions ?? [])
        .map((a) => `\`${a.op}\` ${a.ref} ${a.how}${a.changed ? "" : " · changed=false"}${a.target ? ` · ${a.target}` : ""}`)
        .join("<br>") || "-";
      const skips = (t.skipped_actions ?? [])
        .map((x) => `${x.command_id ?? x.ref ?? "?"}: \`${x.reason}\`${x.detail ? ` — ${String(x.detail).slice(0, 80)}` : ""}`)
        .join("<br>") || "-";
      L.push(`| ${t.index + 1} | ${t.id ?? "-"} | ${t.executed === undefined ? "-" : String(t.executed)} `
        + `| ${acts} | ${skips} | ${t.done_preheld === undefined ? "-" : String(t.done_preheld)} `
        + `| ${(t.warnings ?? []).join("；") || "-"} |`);
    }
    if (actionEvidence.some((t) => t.done_preheld === true)) {
      L.push("", "- ⚠ **done 预成立**：`done_preheld=true` = 完成信号在动作**之前**已成立——这一步的"
        + "`done` 来自信号本身，不是这次动作推进出来的（声明 `forceAct` 时仍会执行动作）。");
    }
    if (actionEvidence.some((t) => t.executed === false && (t.skipped_actions ?? []).length > 0)) {
      L.push("- 零执行步骤：`executed=false` 且有 `skipped_actions` —— 完成裁决为真但一个动作都没执行，"
        + "跳过原因见上表（不是静默 done）。");
    }
  }
  if (r.tool_steps.length) {
    L.push("", "## 动作腿：工具步（命令行）", "",
      "| # | 步骤 | 数据源 | 退出码 | 结论 | 尝试 | 干跑 |", "|---|---|---|---|---|---|---|");
    for (const t of r.tool_steps) {
      // 结论列写**结论**（"未执行 + 怎么补救"），不写内部类别（`dangerous` 仍然在 JSON 里）。
      const verdict = t.done ? "signal held"
        : t.refused ? `**${REFUSAL_LABELS[t.refused] ?? "未执行"}**` : "signal not held";
      const dry = t.dry_run ? `exit ${t.dry_run.code}${t.dry_run.ok ? "" : " (not ok)"}` : "-";
      L.push(`| ${t.index} | ${t.desc.slice(0, 60)} | ${t.source} | ${t.code ?? "-"} | ${verdict} | ${t.attempts} | ${dry} |`);
    }
    L.push("", "<details><summary>工具步的原始观察（argv / stdout 摘要）</summary>", "");
    for (const t of r.tool_steps) {
      // flow 脚本路径的投影没有 argv（声明面只有 desc/source/args），不硬造空字符串。
      if (t.argv !== undefined) L.push(`- \`${t.source}\` argv: \`${t.argv.join(" ")}\``);
      else L.push(`- \`${t.source}\`（flow 工具步；argv 未投影，原始观察见工件）`);
      if (t.dry_run) L.push(`  - dry-run argv: \`${t.dry_run.argv.join(" ")}\``);
      if (t.reason) L.push(`  - 信号诊断: ${t.reason}`);
      if (t.stdout) L.push(`  - stdout: ${JSON.stringify(t.stdout.slice(0, 200))}`);
      else if (t.stderr_tail) L.push(`  - stderr（尾行）: ${JSON.stringify(t.stderr_tail)}`);
      if (t.stderr) L.push(`  - stderr: ${JSON.stringify(t.stderr.slice(0, 200))}`);
      if (t.artifact !== undefined) L.push(`  - 工件: \`${t.artifact}\`（stdout/stderr 全文，已掩码）`);
      if (t.elapsed_ms !== undefined) L.push(`  - 耗时: ${t.elapsed_ms} ms`);
    }
    L.push("", "</details>");
  }
  if (r.manual_steps !== undefined && r.manual_steps.length) {
    L.push("", "## 人工步骤（登录/验证码/人工确认）", "",
      "| # | 步骤 | 结论 | 证据 |", "|---|---|---|---|");
    for (const m of r.manual_steps) {
      const verdict = m.done ? "完成" : `**未完成**（${m.reason ?? "unknown"}）`;
      const evidence = m.done
        ? m.attested === true ? "人自证（{manual:true}，非 DOM 验证）" : "人完成后引擎验过声明的信号"
        : `未完成：${m.reason ?? "unknown"}`;
      L.push(`| ${m.index} | ${m.desc} | ${verdict} | ${evidence} |`);
    }
  }
  if (r.step_types !== undefined) {
    L.push(`- 应用类型：${Object.entries(r.step_types).map(([k, n]) => `\`${k}\`×${n}`).join(" · ")}（旅程声明）`);
  }
  if (r.invariants.length) {
    L.push("", "## 验收（结束状态不变量：web = 浏览器结束态；其它类型 = 只读观察探针）",
      "", "| 不变量 | 类型 | 说明 | 结论 |", "|---|---|---|---|");
    for (const i of r.invariants) {
      L.push(`| ${i.id} | ${i.adapter ?? "web"} | ${i.desc} | ${invariantVerdictMd(r, i.held)} |`);
    }
  }
  return L.join("\n") + "\n";
}

/** HTML 转义：证据报告 v0 的唯一出口（页面/应用来的值都要走这里）。 */
function htmlEscape(s: unknown): string {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 结构化结果 → 人可读 HTML 证据报告（v0：结论/槽位/步骤/不变量/证据锚点）。 */
export function appReportHtml(r: AppRunResult, nextHint?: string | null): string {
  const status = r.partial === true ? "partial" : r.ok ? (r.verified === false ? "ok（未验收）" : "ok") : "failed";
  const title = `应用运行报告：${r.label}（${r.app}）`;
  const L: string[] = [];
  L.push("<!doctype html>");
  L.push('<html lang="zh-CN"><head><meta charset="utf-8">');
  L.push(`<title>${htmlEscape(title)}</title>`);
  L.push("<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:960px;margin:32px auto;padding:0 20px;line-height:1.55;color:#1f2328}h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:1.8rem;border-bottom:1px solid #d0d7de;padding-bottom:.3rem}table{border-collapse:collapse;width:100%;margin:.6rem 0}th,td{border:1px solid #d0d7de;padding:.45rem .6rem;text-align:left;vertical-align:top}th{background:#f6f8fa;width:22%}code{background:#f6f8fa;padding:.1rem .3rem;border-radius:4px}.ok{color:#1a7f37;font-weight:600}.bad{color:#cf222e;font-weight:600}.muted{color:#57606a;font-size:.9rem}</style>");
  L.push("</head><body>");
  L.push(`<h1>${htmlEscape(title)}</h1>`);
  L.push('<p class="muted">由 <code>amber run</code> 生成；原始证据见同目录的 <code>-result.json</code> / <code>-report.md</code>（如有 <code>-report.html</code> 之外的文件）。</p>');
  L.push("<table>");
  L.push(`<tr><th>目标</th><td>${htmlEscape(r.goal)}</td></tr>`);
  L.push(`<tr><th>结论</th><td><span class="${r.ok ? "ok" : "bad"}">${htmlEscape(status)}</span>（完成 ${htmlEscape(r.completed)}；${htmlEscape(r.secs)}s）</td></tr>`);
  L.push(`<tr><th>应用</th><td><code>${htmlEscape(r.app)}</code> — ${htmlEscape(r.label)}</td></tr>`);
  if (r.script !== undefined) {
    L.push(`<tr><th>脚本</th><td><code>${htmlEscape(r.script.script_sha256)}</code>；${r.script.steps} 个 ctx.step/arrive</td></tr>`);
  }
  L.push("</table>");
  const slotKeys = Object.keys(r.slots ?? {});
  L.push("<h2>槽位（敏感槽位已脱敏）</h2>");
  if (slotKeys.length === 0) {
    L.push("<p>（无槽位）</p>");
  } else {
    L.push("<table><tr><th>键</th><th>值</th></tr>");
    for (const k of slotKeys) L.push(`<tr><td><code>${htmlEscape(k)}</code></td><td>${htmlEscape(JSON.stringify(r.slots[k]))}</td></tr>`);
    L.push("</table>");
  }
  L.push("<h2>执行证据</h2>");
  if (r.step_traces !== undefined && r.step_traces.length > 0) {
    L.push("<table><tr><th>#</th><th>步骤</th><th>结论</th><th>停因 / URL</th></tr>");
    for (const s of r.step_traces) {
      L.push(`<tr><td>${htmlEscape(s.index)}</td><td>${htmlEscape(s.id ?? s.desc)}</td><td>${htmlEscape(s.status)}</td><td>${htmlEscape(s.stop_code ?? s.url ?? "")}</td></tr>`);
    }
    L.push("</table>");
  } else {
    L.push(`<p>flow 脚本执行了 ${r.script?.steps ?? 0} 个 ctx.step/arrive；${r.script?.trace_path !== undefined ? `trace：<code>${htmlEscape(r.script.trace_path)}</code>` : "未落 trace（用 --emit-trace FILE 留证）"}。</p>`);
  }
  if (r.invariants.length > 0) {
    L.push("<h2>验收（结束状态不变量）</h2><table><tr><th>不变量</th><th>结论</th><th>说明</th></tr>");
    for (const inv of r.invariants) {
      const verdict = inv.held
        ? '<span class="ok">成立</span>'
        : acceptanceReached(r) ? '<span class="bad">不成立</span>' : '<span class="bad">未验收（预算未到验收点）</span>';
      L.push(`<tr><td><code>${htmlEscape(inv.id)}</code></td><td>${verdict}</td><td>${htmlEscape(inv.desc)}</td></tr>`);
    }
    L.push("</table>");
  }
  if (r.manual_steps !== undefined && r.manual_steps.length > 0) {
    L.push("<h2>人工步骤</h2><table><tr><th>#</th><th>步骤</th><th>结论</th></tr>");
    for (const m of r.manual_steps) L.push(`<tr><td>${htmlEscape(m.index)}</td><td>${htmlEscape(m.desc)}</td><td>${m.done ? '<span class="ok">完成</span>' : `<span class="bad">未完成（${htmlEscape(m.reason ?? "unknown")}）</span>`}</td></tr>`);
    L.push("</table>");
  }
  if (r.sources.length > 0) {
    L.push("<h2>数据腿</h2><table><tr><th>源</th><th>行数</th></tr>");
    for (const s of r.sources) L.push(`<tr><td><code>${htmlEscape(s.name)}</code></td><td>${htmlEscape(s.rows)}</td></tr>`);
    L.push("</table>");
  }
  const stopCode = r.script?.stop_code;
  if (stopCode !== undefined) L.push(`<h2>结构化停因</h2><p><code>${htmlEscape(stopCode)}</code>：${htmlEscape(r.script?.stop_reason ?? "")}</p>`);
  if (nextHint) L.push(`<h2>下一步建议</h2><p>${htmlEscape(nextHint)}</p>`);
  if (!r.ok) L.push(`<h2>停手规则</h2><p>${htmlEscape(STOP_ESCALATION_TEXT)}</p>`);
  L.push('<p class="muted">本报告是 v0：只呈现结构化结果与已脱敏槽位；失败截图/DOM 可能含 PII，按证据敏感性处理。</p>');
  L.push("</body></html>");
  return L.join("\n") + "\n";
}
