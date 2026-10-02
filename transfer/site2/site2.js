/* SkyBook（复刻站 #2）的前端：与携程复刻站同一套 URL 状态约定，
   但控件形状、属性约定、结果排布、分页都刻意不同 —— 迁移测试要打的正是这些差异。
   站点自己的账本叫 window.__SKYBOOK_LEDGER，只有点击「Record」才会写入。 */
(function () {
  const D = window.SKYBOOK;
  const q = new URLSearchParams(location.search);
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const url = (base, params) => base + '?' + new URLSearchParams(params).toString();
  window.__SKYBOOK_LEDGER = { page: document.body.dataset.page, flights: [], hotels: [] };

  const WINDOWS = [['all', 'Any time'], ['0000-0800', '00:00-08:00'],
                   ['0800-1800', '08:00-18:00'], ['1800-2400', '18:00-24:00']];
  const SORTS = [['default', 'Recommended'], ['price_asc', 'price (low to high)'],
                 ['time_asc', 'departure time']];
  const CAPS = [['all', 'Any price'], ['200', '¥200 or less'],
                ['300', '¥300 or less'], ['500', '¥500 or less']];
  const label = (pairs, key) => (pairs.find((p) => p[0] === key) || pairs[0])[1];

  function fillSelect(sel, pairs, current, onPick) {
    sel.innerHTML = pairs.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    sel.value = current;
    sel.onchange = () => onPick(sel.value);
  }

  // ---------------------------------------------------------------- 机票
  function flightsPage() {
    const from = q.get('from') || D.route.fromCode;
    const to = q.get('to') || D.route.toCode;
    const date = q.get('date') || D.dates[0].date;
    const win = q.get('window') || 'all';
    const sort = q.get('sort') || 'default';
    const here = (extra) => url('flights.html', { from, to, date, ...extra });

    fillSelect($('#window'), WINDOWS, win, (v) => { location.href = here({ window: v, sort }); });
    fillSelect($('#sort'), SORTS, sort, (v) => { location.href = here({ window: win, sort: v }); });

    const w = WINDOWS.find((x) => x[0] === win) || WINDOWS[0];
    const rows = D.flights.filter((f) => f.date === date)
      .filter((f) => w[0] === 'all' || (f.dep >= w[0].split('-')[0] && f.dep <= w[0].split('-')[1]));
    if (sort === 'price_asc') rows.sort((a, b) => a.price - b.price || a.dep.localeCompare(b.dep));
    else if (sort === 'time_asc') rows.sort((a, b) => a.dep.localeCompare(b.dep));

    $('#window-state').textContent = `Departure window: ${label(WINDOWS, win)}`;
    $('#sort-state').textContent = `Sort: ${label(SORTS, sort)}`;
    $('#result-count').textContent = `${rows.length} flights`;
    $('#results').innerHTML = rows.length ? rows.map((f) => `
      <div class="card" data-no="${f.no}" data-dep="${f.dep}" data-price="${f.price}">
        <div>
          <div class="times">${f.dep} → ${f.arr} <span class="dur">${f.dur}</span></div>
          <div class="carrier">${esc(f.airline)} <b>${f.no}</b> · ${f.plane}${f.promo ? '<span class="badge">Deal</span>' : ''}</div>
        </div>
        <div><em class="amount">¥${f.price}</em></div>
      </div>`).join('') : '<p class="empty">No flights match this departure window.</p>';

    $('#record-lowest').onclick = () => {
      if (!rows.length) { $('#last-record').textContent = 'Nothing to record'; return; }
      const f = rows[0];
      $('#last-record').textContent = `Recorded ${f.date} ${f.no} ${f.airline} ${f.dep}-${f.arr} ¥${f.price}`;
      window.__SKYBOOK_LEDGER.flights.push({ date: f.date, no: f.no, airline: f.airline,
        dep: f.dep, arr: f.arr, price: f.price, window: label(WINDOWS, win) });
      $('#record-table').querySelector('tbody').insertAdjacentHTML('beforeend',
        `<tr><td>${f.date}</td><td>${f.no}</td><td>${f.dep}-${f.arr}</td><td>¥${f.price}</td>`
        + `<td>${label(WINDOWS, win)}</td></tr>`);
    };
  }

  // ---------------------------------------------------------------- 酒店
  function hotelsPage() {
    const city = q.get('city') || 'Beijing';
    const checkin = q.get('checkin') || D.dates[0].date;
    const cap = q.get('cap') || 'all';
    const sort = q.get('sort') || 'default';
    const page = Math.max(1, parseInt(q.get('page') || '1', 10));
    const here = (extra) => url('hotels.html', { city, checkin, ...extra });

    // 选择状态也要能深链：勾选后跳一次 URL（`selected=all`），否则下一个子目标
    // 重新 goto 会把勾选状态冲掉 —— 这正是本轮迁移测试抓到的失败（记录步骤
    // 打开新页面后没有任何勾选，信号永远不触发，执行器在 max_steps 里打转）。
    const selectedAll = q.get('selected') === 'all';

    const radio = document.getElementById(`cap-${cap}`);
    if (radio) radio.checked = true;
    Array.from(document.querySelectorAll('input[name=cap]')).forEach((r) => {
      r.onchange = () => { location.href = here({ cap: r.value, sort, page: 1 }); };
    });
    fillSelect($('#sort'), SORTS, sort, (v) => { location.href = here({ cap, sort: v, page: 1 }); });

    const limit = cap === 'all' ? Infinity : Number(cap);
    const all = D.hotels.filter((h) => h.price <= limit);
    if (sort === 'price_asc') all.sort((a, b) => a.price - b.price || b.score - a.score);
    else if (sort === 'time_asc') all.sort((a, b) => a.name.localeCompare(b.name));
    const pages = Math.max(1, Math.ceil(all.length / D.perPage));
    const cur = Math.min(page, pages);
    const rows = all.slice((cur - 1) * D.perPage, cur * D.perPage);

    $('#cap-state').textContent = `Price cap: ${label(CAPS, cap)}`;
    $('#sort-state').textContent = `Sort: ${label(SORTS, sort)}`;
    $('#result-count').textContent = `${all.length} hotels`;
    $('#page-state').textContent = `Page ${cur} of ${pages}`;
    $('#results').innerHTML = rows.length ? rows.map((h) => `
      <div class="card" data-id="${h.id}" data-price="${h.price}">
        <div>
          <div><input type="checkbox" class="pick" value="${h.id}" data-price="${h.price}">
            <span class="hotel-name">${esc(h.name)}</span>
            <span class="stars">${'★'.repeat(h.star)}</span></div>
          <div class="carrier">${h.area} · ${h.room} · ${h.tags.join(' / ')}</div>
          <div class="carrier"><span class="score">${h.score}</span> · ${h.reviews} reviews</div>
        </div>
        <div><em class="amount">¥${h.price}</em></div>
      </div>`).join('') : '<p class="empty">No hotels match this price cap.</p>';

    $('#next-page').style.display = cur < pages ? '' : 'none';
    // 翻页丢掉选择状态（下一页要重新勾选），保留筛选与排序
    $('#next-page').href = here({ cap, sort, page: cur + 1 });

    const picks = () => Array.from(document.querySelectorAll('#results input.pick'));
    const refresh = () => {
      const on = picks().filter((c) => c.checked).length;
      $('#selection-count').textContent = on ? `Selected: ${on}` : 'Click a hotel to select';
      $('#select-all').checked = on > 0 && on === picks().length;
    };
    $('#select-all').onchange = () => {
      const on = $('#select-all').checked;
      picks().forEach((c) => { c.checked = on; });
      refresh();
      location.href = on ? here({ cap, sort, page: cur, selected: 'all' })
                         : here({ cap, sort, page: cur });
    };
    picks().forEach((c) => { c.onchange = refresh; });
    if (selectedAll) { picks().forEach((c) => { c.checked = true; }); refresh(); }

    $('#record-selected').onclick = () => {
      const chosen = picks().filter((c) => c.checked)
        .map((c) => D.hotels.find((h) => String(h.id) === c.value));
      if (!chosen.length) { $('#hotel-recorded').textContent = 'No hotels selected'; return; }
      chosen.forEach((h) => window.__SKYBOOK_LEDGER.hotels.push({
        id: h.id, name: h.name, star: h.star, score: h.score, area: h.area,
        room: h.room, price: h.price, checkin }));
      $('#hotel-recorded').textContent = `Recorded ${chosen.length} hotels for ${checkin}`;
      $('#record-table').querySelector('tbody').innerHTML = window.__SKYBOOK_LEDGER.hotels
        .map((h, i) => `<tr><td>${i + 1}</td><td>${esc(h.name)}</td><td>${'★'.repeat(h.star)}</td>`
          + `<td>${h.score}</td><td>${h.area}</td><td>¥${h.price}</td></tr>`).join('');
    };
  }

  if (document.body.dataset.page === 'flights') flightsPage();
  else if (document.body.dataset.page === 'hotels') hotelsPage();
})();
