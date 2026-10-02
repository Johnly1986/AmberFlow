/* FareHaven（复刻站 #6）的前端。
   关键点：**部分日期**会弹一个盖住整页的促销遮罩（`window.FAREHAVEN.promoDates`），
   关掉它 `#promo-state` 才变成 "Promotion: dismissed"；没有遮罩的日期它一直是
   "Promotion: none today" —— 所以"关遮罩"这一步在没有遮罩时永远不可能自己完成，
   只能靠计划里的前置条件（`when`）把它跳过。 */
(function () {
  const D = window.FAREHAVEN;
  const q = new URLSearchParams(location.search);
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const url = (base, params) => base + '?' + new URLSearchParams(params).toString();
  window.__FAREHAVEN_LEDGER = { page: document.body.dataset.page, flights: [], hotels: [] };

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

  // 促销遮罩：只在促销日期出现，而且**一个标签页里处理过一次就不再出现**。
  // 会话标记放 window.name：file:// 下 document.cookie 会抛 SecurityError（实测），
  // 而 window.name 跨导航存活（实测）。三种状态文案互相不可达 —— 所以"关掉遮罩"
  // 这一步在没有遮罩的日期上**不可能靠动作**满足自己的信号，只能靠 `when` 跳过。
  const HANDLED = 'fh_promo_handled';
  const handled = () => (window.name || '').indexOf(HANDLED) >= 0;

  function maybePromo(date) {
    const promoDay = (D.promoDates || []).includes(date);
    if (!promoDay) {
      $('#promo-state').textContent = 'Promotion: none today';
      return;
    }
    if (handled()) {
      $('#promo-state').textContent = 'Promotion: already handled';
      return;
    }
    $('#promo-state').textContent = 'Promotion: active — dismiss to continue';
    $('#promo-slot').innerHTML = `
      <div id="promo-modal">
        <div class="sheet">
          <h2>National Day sale</h2>
          <p>Extra ¥120 off fares to Beijing. Dismiss to see the full list.</p>
          <button id="promo-dismiss" type="button" class="primary">Dismiss</button>
        </div>
      </div>`;
    $('#promo-dismiss').onclick = () => {
      window.name = (window.name || '') + ' ' + HANDLED;
      $('#promo-slot').innerHTML = '';
      $('#promo-state').textContent = 'Promotion: dismissed';
    };
  }

  function flightsPage() {
    const date = q.get('date') || D.dates[0].date;
    const win = q.get('window') || 'all';
    const sort = q.get('sort') || 'default';
    const here = (extra) => url('flights.html', { date, ...extra });
    fill($('#window'), WINDOWS, win);
    fill($('#sort'), SORTS, sort);
    $('#window').onchange = () => { location.href = here({ window: $('#window').value, sort }); };
    $('#sort').onchange = () => { location.href = here({ window: win, sort: $('#sort').value }); };

    const w = WINDOWS.find((x) => x[0] === win) || WINDOWS[0];
    const rows = D.flights.filter((f) => f.date === date)
      .filter((f) => w[0] === 'all' || (f.dep >= w[0].split('-')[0] && f.dep <= w[0].split('-')[1]));
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

    $('#record-cheapest').onclick = () => {
      if (!rows.length) { $('#log').textContent = 'Nothing to record'; return; }
      const f = rows[0];
      $('#log').textContent = `Recorded ${f.date} ${f.no} ${f.airline} ${f.dep}-${f.arr} ¥${f.price}`;
      window.__FAREHAVEN_LEDGER.flights.push({ date: f.date, no: f.no, airline: f.airline,
        dep: f.dep, arr: f.arr, price: f.price, window: pick(WINDOWS, win) });
      $('#ledger-table').querySelector('tbody').insertAdjacentHTML('beforeend',
        `<tr><td>${f.date}</td><td>${f.no}</td><td>${f.dep}-${f.arr}</td><td class="amount">¥${f.price}</td></tr>`);
    };
    maybePromo(date);
  }

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
      rows.forEach((h) => window.__FAREHAVEN_LEDGER.hotels.push({
        id: h.id, name: h.name, star: h.star, score: h.score, area: h.area,
        room: h.room, price: h.price, checkin }));
      $('#log').textContent = `Recorded ${rows.length} stays for ${checkin}`;
      $('#ledger-table').querySelector('tbody').innerHTML = window.__FAREHAVEN_LEDGER.hotels
        .map((h, i) => `<tr><td>${i + 1}</td><td>${esc(h.name)}</td><td>${'★'.repeat(h.star)}</td>`
          + `<td>${h.score}</td><td>${h.area}</td><td class="amount">¥${h.price}</td></tr>`).join('');
    };
  }

  const page = document.body.dataset.page;
  if (page === 'flights') flightsPage();
  else if (page === 'hotels') hotelsPage();
})();
