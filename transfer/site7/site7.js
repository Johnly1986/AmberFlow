/* SlowJet（复刻站 #7）的前端。
   要证的是**重试**：出票摘要页 `summary.html` 在标签页里**第一次访问是冷的**
   （只显示 "Preparing fares…"，连记录按钮都没有），第二次才渲染完整。
   会话标记仍放 `window.name`（file:// 下 cookie 会抛 SecurityError，实测），
   而且是**按日期**记的 —— 所以五个日期各需要重试一次。 */
(function () {
  const D = window.SLOWJET;
  const q = new URLSearchParams(location.search);
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const url = (base, params) => base + '?' + new URLSearchParams(params).toString();
  window.__SLOWJET_LEDGER = { page: document.body.dataset.page, flights: [], hotels: [] };

  const WINDOWS = [['all', 'Any time'], ['0000-0800', '00:00-08:00'],
                   ['0800-1800', '08:00-18:00'], ['1800-2400', '18:00-24:00']];
  const SORTS = [['default', 'Recommended'], ['price_asc', 'price (low to high)'],
                 ['time_asc', 'departure time']];
  const CAPS = [['all', 'No limit'], ['200', '¥200 or less'], ['300', '¥300 or less'],
                ['500', '¥500 or less']];
  const pick = (pairs, key) => (pairs.find((p) => p[0] === key) || pairs[0])[1];
  const fill = (sel, pairs, cur) => {
    sel.innerHTML = pairs.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    sel.value = cur;
  };
  const inWindow = (dep, key) => key === 'all' ||
    (dep >= key.split('-')[0] && dep <= key.split('-')[1]);

  // 每个日期预热一次：第一次访问摘要页是冷的
  const warmKey = (date) => `sj_warm_${date}`;
  const isWarm = (date) => (window.name || '').indexOf(warmKey(date)) >= 0;
  const markWarm = (date) => { window.name = (window.name || '') + ' ' + warmKey(date); };

  // ---------------------------------------------------------------- 航班列表
  function flightsPage() {
    const date = q.get('date') || D.dates[0].date;
    const win = q.get('window') || 'all';
    const sort = q.get('sort') || 'default';
    const here = (extra) => url('flights.html', { date, window: win, sort, ...extra });

    fill($('#window'), WINDOWS, win);
    fill($('#sort'), SORTS, sort);
    $('#window').onchange = () => { location.href = here({ window: $('#window').value }); };
    $('#sort').onchange = () => { location.href = here({ sort: $('#sort').value }); };
    $('#summary-link').href = url('summary.html', { date, window: win, sort });

    const rows = D.flights.filter((f) => f.date === date && inWindow(f.dep, win));
    if (sort === 'price_asc') rows.sort((a, b) => a.price - b.price || a.dep.localeCompare(b.dep));
    else if (sort === 'time_asc') rows.sort((a, b) => a.dep.localeCompare(b.dep));

    $('#window-state').textContent = `Departure window: ${pick(WINDOWS, win)}`;
    $('#sort-state').textContent = `Sort: ${pick(SORTS, sort)}`;
    $('#row-count').textContent = `${rows.length} fares`;
    $('#fares').querySelector('tbody').innerHTML = rows.length ? rows.map((f) => `
      <tr class="fare-row" data-no="${f.no}" data-dep="${f.dep}" data-price="${f.price}">
        <td>${f.dep}</td><td>${f.arr}</td><td>${esc(f.airline)} <b>${f.no}</b></td>
        <td>${f.dur}${f.promo ? ' <span class="tiny">deal</span>' : ''}</td>
        <td class="amount">¥${f.price}</td>
      </tr>`).join('') : '<tr><td colspan="5" class="empty">No fares in this window.</td></tr>';
  }

  // ---------------------------------------------------------------- 出票摘要（首次是冷的）
  function summaryPage() {
    const date = q.get('date') || D.dates[0].date;
    const win = q.get('window') || 'all';
    const sort = q.get('sort') || 'price_asc';
    if (!isWarm(date)) {
      markWarm(date);
      $('#summary-body').innerHTML = '<p class="state" id="cold">Preparing fares… please visit again.</p>';
      $('#log').textContent = 'Summary not ready';
      return;
    }
    const rows = D.flights.filter((f) => f.date === date && inWindow(f.dep, win));
    if (sort === 'price_asc') rows.sort((a, b) => a.price - b.price || a.dep.localeCompare(b.dep));
    const f = rows[0];
    if (!f) {
      $('#summary-body').innerHTML = '<p class="state">No fares in this window.</p>';
      return;
    }
    $('#summary-body').innerHTML = `
      <div class="row">
        <div>
          <div><b>${esc(f.airline)} ${f.no}</b> · ${f.dep}-${f.arr} · ${f.dur}</div>
          <div class="state">${date} · ${pick(WINDOWS, win)} · cheapest in window</div>
        </div>
        <div><em class="amount">¥${f.price}</em></div>
        <button id="record-fare" type="button" class="primary">Record this fare</button>
      </div>`;
    $('#record-fare').onclick = () => {
      $('#log').textContent = `Recorded ${date} ${f.no} ${f.airline} ${f.dep}-${f.arr} ¥${f.price}`;
      window.__SLOWJET_LEDGER.flights.push({ date, no: f.no, airline: f.airline,
        dep: f.dep, arr: f.arr, price: f.price, window: pick(WINDOWS, win) });
      $('#ledger-table').querySelector('tbody').insertAdjacentHTML('beforeend',
        `<tr><td>${date}</td><td>${f.no}</td><td>${f.dep}-${f.arr}</td><td class="amount">¥${f.price}</td></tr>`);
    };
  }

  // ---------------------------------------------------------------- 酒店
  function hotelsPage() {
    const checkin = q.get('checkin') || D.dates[0].date;
    const cap = q.get('cap') || 'all';
    const sort = q.get('sort') || 'default';
    const here = (extra) => url('hotels.html', { checkin, cap, sort, ...extra });
    fill($('#cap'), CAPS, cap);
    fill($('#sort'), SORTS, sort);
    $('#cap').onchange = () => { location.href = here({ cap: $('#cap').value }); };
    $('#sort').onchange = () => { location.href = here({ sort: $('#sort').value }); };

    const limit = cap === 'all' ? Infinity : Number(cap);
    const rows = D.hotels.filter((h) => h.price <= limit);
    if (sort === 'price_asc') rows.sort((a, b) => a.price - b.price || b.score - a.score);
    else if (sort === 'time_asc') rows.sort((a, b) => a.name.localeCompare(b.name));

    $('#cap-state').textContent = cap === 'all' ? 'Max price: no limit' : `Max price: ¥${cap}`;
    $('#sort-state').textContent = `Sort: ${pick(SORTS, sort)}`;
    $('#row-count').textContent = `${rows.length} stays`;
    $('#stays').querySelector('tbody').innerHTML = rows.length ? rows.map((h) => `
      <tr class="stay-row" data-id="${h.id}" data-price="${h.price}">
        <td>${esc(h.name)}</td><td>${'★'.repeat(h.star)}</td><td>${h.score}</td>
        <td>${h.area}</td><td>${h.room} · ${h.tags.join(' / ') || '—'}</td>
        <td class="amount">¥${h.price}</td>
      </tr>`).join('') : '<tr><td colspan="6" class="empty">No stays under this price.</td></tr>';

    $('#record-all').onclick = () => {
      if (!rows.length) { $('#log').textContent = 'Nothing to record'; return; }
      rows.forEach((h) => window.__SLOWJET_LEDGER.hotels.push({
        id: h.id, name: h.name, star: h.star, score: h.score, area: h.area,
        room: h.room, price: h.price, checkin }));
      $('#log').textContent = `Recorded ${rows.length} stays for ${checkin}`;
      $('#ledger-table').querySelector('tbody').innerHTML = window.__SLOWJET_LEDGER.hotels
        .map((h, i) => `<tr><td>${i + 1}</td><td>${esc(h.name)}</td><td>${'★'.repeat(h.star)}</td>`
          + `<td>${h.score}</td><td>${h.area}</td><td class="amount">¥${h.price}</td></tr>`).join('');
    };
  }

  const page = document.body.dataset.page;
  if (page === 'flights') flightsPage();
  else if (page === 'summary') summaryPage();
  else if (page === 'hotels') hotelsPage();
})();
