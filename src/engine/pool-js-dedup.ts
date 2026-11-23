/**
 * 池抽取的**池构成规则**共享 JS 片段（一区域一候选去重 + 桶内类目/醒目度排序 + 组级保底）。
 *
 * 为什么独立成模块：去重/排序/保底都是"谁进池、按什么序"的构成规则（EXTRACT_JS 与
 * WINDOW_AUDIT_JS 经模板内插共用同一份），放在 pool-js.ts 会把它埋进既有 pass 串里；
 * 单独成模块后"公理 0 的裁决规则写在哪、证据面读哪个章"有单一出处。片段是**纯 JS**
 * （写给浏览器执行的 String.raw 模板），不含任何 TS 专属语法（strip-types 会擦掉类型注释，
 * 页内模板必须可直接执行）。
 *
 * 公理 0（去重与裁决的唯一判准）：候选的语义 = 模拟正常操作——一个真人点这块区域时，
 * 浏览器命中谁、事件冒泡给谁、布局意图上谁承载可点区域，就留谁。正常操作命中的是整块
 * 区域、事件沿 DOM 向上冒泡到父的 handler、父承载命中面积与 label；子（图标/span）多为
 * 装饰。因此同区域重复默认**留父、子让位**；唯一例外是监听探针章（candidate-scan 盖的
 * `data-js-ref`）证明 handler 实际挂在子而父没有 → 留子。被剔节点只是**出池**，DOM 原样
 * 保留：作者显式点名（#id / [data-test=…] 等）仍可 DRF/ADMIT 回捞命中——能力不丢。
 */

/** EXTRACT_JS 盖在被剔元素身上的章名（windowAudit 的 dedup_dropped.why 词表，additive）。 */
export const DEDUP_DROP_ATTR = "data-dshdrop";

/**
 * 被剔原因闭集：等 label 同区域重复（子让位）/ 空名子（装饰、纯噪声；可编辑原生控件除外）/
 * 监听证据在子（父让位）/ 同卡兄弟单元折叠（非原生兄弟让位）。
 */
export const DEDUP_WHY_CODES = ["label-dup", "empty-child", "listener-child", "unit-sibling"] as const;

/**
 * 页内去重片段。内插进 EXTRACT_JS（顶层一次定义，配额/填序前调用一次）：
 *
 *   rows = __dedupPoolRows(rows, all);
 *
 * 输入：`rows`（采集期行，含 full_label/i 索引）、`all`（__collectAll 的元素数组）。
 * 行为：
 *   1. `contains_candidate` 打标——每个候选沿 parentElement 上溯 ≤32 层，命中最近的候选
 *      祖先即互记一对（祖先标 contains_candidate，子记最近宿主）；影子根边界天然截断
 *      （parentElement 在 ShadowRoot 处为 null，两棵树不算同区域）。
 *   2. `kind` 计算（只在本片段内用作事实字段）——container = 含候选后代 且（自身无文案 或
 *      与内层候选同 label）；否则 atomic。行上只在 container 出键（atomic = 缺省）。
 *   3. 同区域重复裁决——前提 = 候选祖先包含 且（父子 label 归一后相等 或 子为空名）：
 *        - 子空名 → 剔子（无 label 即无独立身份；有监听章也一样——空名候选模型无法按
 *          label 寻址，纯占配额的噪声；显式点名可 DRF 回捞）。**例外 = 可编辑原生控件**
 *          （input/select/textarea）：空 label 只失去"按名寻址"，fill/type/select 仍是
 *          这块区域上唯一的写入口，按装饰剔掉会让模型被迫走池外回退（连值都写不进）；
 *          空名 a/button 不豁免——没有可写语义，且采集期按 `!fullLabel` 已跳过（见
 *          EXTRACT_JS），裁决面本就没有它们的行；
 *        - 等label → 保留父，子让位；例外 = 子带监听章（data-js-ref）而父无章且父非原生
 *          控件 → 父让位（handler 在子、父只是 ARIA 声明——按公理 0 应留实际承载 handler
 *          的一方）；
 *        - label 不同且子非空名 → 各有语义/动作（卡内独立按钮），**都不剔**。
 *        被剔元素盖 `data-dshdrop="<why>"` 章（WINDOW_AUDIT_JS 读它出 dedup_dropped，
 *        EXTRACT_JS 每趟开头清旧章——章是批次的，残留会谎报）。
 * 返回：过滤后的 rows（被剔的不参与几何/分桶/配额，windowAudit 的 out_of_window 也不再计）。
 *
 * 注意：所有池候选都已通过准入面（native/ARIA/监听章），"父不可动作 → 父剔"在池面不成立
 * （能进池即有可动作事实）；裁决只在"留父 / 留子 / 都留"三者之间。label 比较 = `full_label`
 * 的 norm 后精确相等（不折叠大小写：少合并 = 保守，误合并才会丢能力）。
 */
export const DEDUP_HELPERS_JS = String.raw`
  const __DEDUP_NATIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'label']);
  // "空名 = 装饰"的例外面：可编辑原生控件有独立写语义，空 label 不构成装饰证据。
  const __DEDUP_EDITABLE_TAGS = new Set(['input', 'select', 'textarea']);
  const __dedupPoolRows = (rows, all) => {
    const byEl = new Map();
    for (let k = 0; k < rows.length; k++) byEl.set(all[rows[k].i], rows[k]);
    // 一趟祖先打标：contains_candidate + 最近候选宿主（O(n×depth)，零额外查询）。
    const nearestHost = new Map();
    for (const r of rows) {
      const el = all[r.i];
      let p = el ? el.parentElement : null;
      for (let g = 0; p && g < 32; g++, p = p.parentElement) {
        const host = byEl.get(p);
        if (host !== undefined) {
          host.contains_candidate = true;
          nearestHost.set(r, host);
          break;
        }
      }
    }
    for (const [child, host] of nearestHost.entries()) {
      const hostLabel = String(host.full_label || '');
      if (hostLabel === ''
        || (String(child.full_label || '') !== '' && child.full_label === host.full_label)) {
        host.kind = 'container';
      }
    }
    // 先收集被剔集合再一次过滤：链式嵌套（A⊃B⊃C）的裁决互相独立，避免迭代中改数组。
    const dropped = new Set();
    for (const [child, host] of nearestHost.entries()) {
      const childEl = all[child.i];
      const hostEl = all[host.i];
      if (!childEl || !hostEl) continue;
      const childLabel = String(child.full_label || '');
      if (childLabel === '') {
        // 可编辑原生控件不因空名剔（理由见片段头注释的例外条）：直接留行，不再进 label
        // 比较——空 label 与空 host label 相等时 label-dup 会把它二次剔掉，等于没豁免。
        if (__DEDUP_EDITABLE_TAGS.has(String(child.tag || '').toLowerCase())) continue;
        dropped.add(child);
        try { childEl.setAttribute('data-dshdrop', 'empty-child'); } catch (err) { /* 盖章失败只丢证据，不丢裁决 */ }
        continue;
      }
      if (childLabel !== String(host.full_label || '')) continue;   // 不同 label = 不同操作，都留
      const childStamped = !!childEl.getAttribute('data-js-ref');
      const hostStamped = !!hostEl.getAttribute('data-js-ref');
      if (childStamped && !hostStamped && !__DEDUP_NATIVE_TAGS.has(host.tag)) {
        // 例外：监听探针证明 handler 在子、父仅声明 → 父让位。
        dropped.add(host);
        try { hostEl.setAttribute('data-dshdrop', 'listener-child'); } catch (err) { /* 同上 */ }
      } else {
        dropped.add(child);
        try { childEl.setAttribute('data-dshdrop', 'label-dup'); } catch (err) { /* 同上 */ }
      }
    }
    if (dropped.size !== 0) rows = rows.filter((r) => !dropped.has(r));
    return __dedupUnitSiblings(rows, all, dropped);
  };
  // ── 同卡兄弟单元折叠（公理 0 缺的形态）：互不包含的同 label 候选若共享**交互祖先**
  //（卡片/行：role article/menuitem 族/option/button/link/tab 或 jsaction click/auxclick 或
  // onclick 或 cursor:pointer，且非 body/html/main 泛容器），且组内**恰一个 native 控件**、
  // 该控件的中心点命中自己或其后代（真接收点击）——它就是这一单元的执行者，其余同 label
  // 兄弟（覆盖链接旁的可读标题/装饰文本，如 Maps 结果卡的 aria-label 链接 + 标题 div）出池。
  // 被剔只出池、DOM 原样保留（同 label 的 hint 仍命中执行者；异形身份 #id/[data-test] 声明
  // 由调用方 DRF/ADMIT 回捞）。真歧义（跨卡/同容器多 native/无交互祖先）一律不折叠。
  const __UNIT_NATIVE = new Set(['a', 'button', 'input', 'select', 'textarea', 'label']);
  const __UNIT_CAP = 8;
  const __unitInteractive = (x) => {
    const role = String(x.getAttribute('role') || '').toLowerCase();
    const js = String(x.getAttribute('jsaction') || '');
    if (['article', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'button', 'link', 'option', 'tab'].indexOf(role) >= 0) return true;
    if (js.indexOf('click') >= 0 || js.indexOf('auxclick') >= 0 || x.hasAttribute('onclick')) return true;
    try { return getComputedStyle(x).cursor === 'pointer' } catch (e) { return false }
  };
  const __dedupUnitSiblings = (rows, all, dropped) => {
    if (rows.length < 2) return rows;
    const byLabel = new Map();
    for (const r of rows) {
      if (!all[r.i]) continue;
      const lab = String(r.full_label == null ? '' : r.full_label).trim();
      if (lab === '') continue;
      const list = byLabel.get(lab);
      if (list === undefined) byLabel.set(lab, [r]); else list.push(r);
    }
    let budget = __UNIT_CAP;
    for (const group of byLabel.values()) {
      if (budget <= 0) break;
      if (group.length < 2 || group.length > 4) continue;
      let nested = false;
      for (let a = 0; a < group.length && !nested; a++) {
        for (let b = a + 1; b < group.length; b++) {
          const ea = all[group[a].i], eb = all[group[b].i];
          if (ea && eb && (ea.contains(eb) || eb.contains(ea))) { nested = true; break }
        }
      }
      if (nested) continue;                      // 包含关系已归既有裁决；这里只处理兄弟
      const chains = group.map((r) => {
        const out = [];
        let p = all[r.i].parentElement;
        for (let g = 0; p && g < 12; g++, p = p.parentElement) out.push(p);
        return out;
      });
      let lca = null;
      for (const cand of chains[0]) {
        if (cand && chains.every((ch) => ch.indexOf(cand) >= 0)) { lca = cand; break }
      }
      if (!lca) continue;
      const ltag = String(lca.tagName || '').toUpperCase();
      if (ltag === 'BODY' || ltag === 'HTML' || ltag === 'MAIN') continue;   // 泛容器 = 跨单元
      if (!__unitInteractive(lca)) continue;
      let native = null, natives = 0;
      for (const r of group) {
        const t = String(all[r.i].tagName || '').toLowerCase();
        if (!__UNIT_NATIVE.has(t)) continue;
        natives += 1; native = r;
      }
      if (natives !== 1 || native === null) continue;   // 一卡双 native = 语义不可分
      const rep = all[native.i];
      const rr = rep.getBoundingClientRect();
      if (!rr.width || !rr.height) continue;
      const cx = rr.x + rr.width / 2, cy = rr.y + rr.height / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
      let top = null;
      try { top = document.elementFromPoint(cx, cy) } catch (e) { top = null }
      if (!top || (top !== rep && !rep.contains(top))) continue;   // 执行者必须真接收点击
      let addressable = false;
      for (const r of group) {
        if (r === native) continue;
        const el = all[r.i];
        if (el && (el.id || el.getAttribute('data-test'))) { addressable = true; break }
      }
      if (addressable) continue;                 // 异形身份声明可达性优先，不折叠
      for (const r of group) {
        if (r === native) continue;
        const el = all[r.i];
        if (el) el.setAttribute(${JSON.stringify(DEDUP_DROP_ATTR)}, 'unit-sibling');
        dropped.add(r);
      }
      budget -= 1;
    }
    return rows.filter((r) => !dropped.has(r));
  };
  // 桶内排序（类目维 + 醒目度，两分支同用）：atomic 先、container 后（container 只降权
  // 不除名——"点卡片进详情"与"点按钮加购"是两种操作，容器排后仍可被显式点名或模型选中）；
  // 同类目内 prominence 降序（viewport 桶 = 可见交集面积 = 真人此刻看到多少；视口外桶 =
  // 原始 rect 面积 = 看不到但体积大仍可能是主控件——用可见交集量视口外元素会恒 0，退化成
  // scan 序）；平局 scan 升序（确定性，绝不掷骰子）。跨桶次序仍由 BUCKET_ORDER 决定。
  const __poolRowOrder = (a, b) => {
    const ka = a.kind === 'container' ? 1 : 0;
    const kb = b.kind === 'container' ? 1 : 0;
    if (ka !== kb) return ka - kb;
    const p = ((b.prominence || 0) - (a.prominence || 0)) || 0;
    if (p !== 0) return p;
    return ((a.scan || 0) - (b.scan || 0));
  };
  // 组级保底（GROUP_PIN_CAP 限幅）：去重后仍存在的同 (tag,label) 组，每组保 scan-min 一员——
  // 排序/配额不应让"同文案行组"整组消失：组的首个成员是该组的 DOM 锚，row-index:N /
  // in-row 声明与"点第 N 行"类任务都以组在池为前提。键口径与宿主 addNearContext 一致
  // （tag+\u0000+label40），跨面组号不错位。限幅防"全页都是重复控件"的病态面把顺延填充
  // 挤成全保底。
  const __GROUP_PIN_CAP = 8;
  const __dupGroupMinsOf = (rows) => {
    const cnt = {};
    for (const r of rows) {
      const k = String(r.tag || '') + '\u0000' + String(r.label || '');
      cnt[k] = (cnt[k] || 0) + 1;
    }
    const mins = new Map();
    for (const r of rows) {
      const k = String(r.tag || '') + '\u0000' + String(r.label || '');
      if (cnt[k] > 1) {
        const cur = mins.get(k);
        if (cur === undefined || ((r.scan || 0) < (cur.scan || 0))) mins.set(k, r);
      }
    }
    return mins;
  };
`;
