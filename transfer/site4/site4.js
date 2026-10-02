/* FlyQuest（复刻站 #4）的前端：搜索是表单（填日期 → 选时段 → 提交），
   结果页只能通过提交到达。站点账本 window.__FLYQUEST_LEDGER 只由点击写入。 */
(function () {
  const D = window.FLYQUEST;
  const q = new URLSearchParams(location.search);
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const url = (base, params) => base + '?' + new URLSearchParams(params).toString();
  window.__FLYQUEST_LEDGER = { page: document.body.dataset.page, flights: [], hotels: [] };

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

  // ---------------------------------------------------------------- 搜索表单
  function searchPage() {
    fill($('#window'), WINDOWS, 'all');
    $('#date').value = q.get('date') || '';
    $('#search-state').textContent = $('#date').value
      ? `Ready: ${$('#date').value}` : 'Fill the date and press Search.';
    $('#search-form').onsubmit = (ev) => {
      ev.preventDefault();
      const date = $('#date').value;
      if (!date) { $('#search-state').textContent = 'Pick a departure date first.'; return false; }
      location.href = url('fares.html', { from: $('#from').value, to: $('#to').value,
                                         date, window: $('#window').value });
      return false;
    };
  }

  // ---------------------------------------------------------------- 机票结果
  function faresPage() {
    const date = q.get('date') || D.dates[0].date;
    const win = q.get('window') || 'all';
    const sort = q.get('sort') || 'default';
    const here = (extra) => url('fares.html', { from: 'KMG', to: 'BJS', date, window: win, sort, ...extra });

    fill($('#sort'), SORTS, sort);
    $('#sort').onchange = () => { location.href = here({ sort: $('#sort').value }); };

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
      window.__FLYQUEST_LEDGER.flights.push({ date: f.date, no: f.no, airline: f.airline,
        dep: f.dep, arr: f.arr, price: f.price, window: pick(WINDOWS, win) });
      $('#ledger-table').querySelector('tbody').insertAdjacentHTML('beforeend',
        `<tr><td>${f.date}</td><td>${f.no}</td><td>${f.dep}-${f.arr}</td><td class="amount">¥${f.price}</td></tr>`);
    };
  }

  // ---------------------------------------------------------------- 酒店（上限也是一个表单）
  function staysPage() {
    const checkin = q.get('checkin') || D.dates[0].date;
    const cap = q.get('cap') || 'all';
    const sort = q.get('sort') || 'default';
    const here = (extra) => url('stays.html', { checkin, cap, sort, ...extra });

    fill($('#cap'), CAPS, cap);
    fill($('#sort'), SORTS, sort);
    $('#sort').onchange = () => { location.href = here({ sort: $('#sort').value }); };
    $('#cap-form').onsubmit = (ev) => {
      ev.preventDefault();
      location.href = here({ cap: $('#cap').value });
      return false;
    };

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
      rows.forEach((h) => window.__FLYQUEST_LEDGER.hotels.push({
        id: h.id, name: h.name, star: h.star, score: h.score, area: h.area,
        room: h.room, price: h.price, checkin }));
      $('#log').textContent = `Recorded ${rows.length} stays for ${checkin}`;
      $('#ledger-table').querySelector('tbody').innerHTML = window.__FLYQUEST_LEDGER.hotels
        .map((h, i) => `<tr><td>${i + 1}</td><td>${esc(h.name)}</td><td>${'★'.repeat(h.star)}</td>`
          + `<td>${h.score}</td><td>${h.area}</td><td class="amount">¥${h.price}</td></tr>`).join('');
    };
  }

  const page = document.body.dataset.page;
  if (page === 'search') searchPage();
  else if (page === 'fares') faresPage();
  else if (page === 'stays') staysPage();
})();
