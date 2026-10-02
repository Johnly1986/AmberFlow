/* Trekly（复刻站 #3）的前端：第三种布局 —— 结果在表格里、价格上限是滑块、
   「记录」一次记下当前全部行。状态照样写在 URL 里（每个子目标一次点击落到确定状态）。 */
(function () {
  const D = window.TREKLY;
  const q = new URLSearchParams(location.search);
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const url = (base, params) => base + '?' + new URLSearchParams(params).toString();
  window.__TREKLY_LEDGER = { page: document.body.dataset.page, flights: [], hotels: [] };

  const WINDOWS = [['all', 'Any time'], ['0000-0800', '00:00-08:00'],
                   ['0800-1800', '08:00-18:00'], ['1800-2400', '18:00-24:00']];
  const SORTS = [['default', 'Recommended'], ['price_asc', 'price (low to high)'],
                 ['time_asc', 'departure time']];
  const CAP_LABEL = (v) => (v && v !== 'all' ? `Max price: ¥${v}` : 'Max price: no limit');
  const pick = (pairs, key) => (pairs.find((p) => p[0] === key) || pairs[0])[1];
  const fill = (sel, pairs, cur, onPick) => {
    sel.innerHTML = pairs.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    sel.value = cur;
    sel.onchange = () => onPick(sel.value);
  };

  function flightsPage() {
    const date = q.get('date') || D.dates[0].date;
    const win = q.get('window') || 'all';
    const sort = q.get('sort') || 'default';
    const here = (extra) => url('flights.html', { date, ...extra });

    fill($('#dep-window'), WINDOWS, win, (v) => { location.href = here({ window: v, sort }); });
    fill($('#sort-by'), SORTS, sort, (v) => { location.href = here({ window: win, sort: v }); });

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
        <td>${f.dur}</td><td>${f.plane}${f.promo ? ' <span class="tiny">deal</span>' : ''}</td>
        <td class="rate">¥${f.price}</td>
      </tr>`).join('') : '<tr><td colspan="6" class="empty">No fares in this departure window.</td></tr>';

    $('#record-cheapest').onclick = () => {
      if (!rows.length) { $('#log').textContent = 'Nothing to record'; return; }
      const f = rows[0];
      $('#log').textContent = `Recorded ${f.date} ${f.no} ${f.airline} ${f.dep}-${f.arr} ¥${f.price}`;
      window.__TREKLY_LEDGER.flights.push({ date: f.date, no: f.no, airline: f.airline,
        dep: f.dep, arr: f.arr, price: f.price, window: pick(WINDOWS, win) });
      $('#ledger-table').querySelector('tbody').insertAdjacentHTML('beforeend',
        `<tr><td>${f.date}</td><td>${f.no}</td><td>${f.dep}-${f.arr}</td><td class="rate">¥${f.price}</td></tr>`);
    };
  }

  function hotelsPage() {
    const checkin = q.get('checkin') || D.dates[0].date;
    const cap = q.get('cap') || 'all';
    const sort = q.get('sort') || 'default';
    const here = (extra) => url('hotels.html', { checkin, ...extra });

    const slider = $('#max-price');
    slider.value = cap === 'all' ? '1500' : cap;
    slider.oninput = () => {
      const v = Number(slider.value) >= 1500 ? 'all' : slider.value;
      location.href = here({ cap: v, sort });
    };
    fill($('#sort-by'), SORTS, sort, (v) => { location.href = here({ cap, sort: v }); });

    const limit = cap === 'all' ? Infinity : Number(cap);
    const rows = D.hotels.filter((h) => h.price <= limit);
    if (sort === 'price_asc') rows.sort((a, b) => a.price - b.price || b.score - a.score);
    else if (sort === 'time_asc') rows.sort((a, b) => a.name.localeCompare(b.name));

    $('#cap-state').textContent = CAP_LABEL(cap);
    $('#sort-state').textContent = `Sort: ${pick(SORTS, sort)}`;
    $('#row-count').textContent = `${rows.length} stays`;
    $('#stays').querySelector('tbody').innerHTML = rows.length ? rows.map((h) => `
      <tr class="stay-row" data-id="${h.id}" data-price="${h.price}">
        <td>${esc(h.name)}</td><td>${'★'.repeat(h.star)}</td><td>${h.score}</td>
        <td>${h.area}</td><td>${h.room} · ${h.tags.join(' / ') || '—'}</td>
        <td class="rate">¥${h.price}</td>
      </tr>`).join('') : '<tr><td colspan="6" class="empty">No stays under this price.</td></tr>';

    $('#record-shown').onclick = () => {
      if (!rows.length) { $('#log').textContent = 'Nothing to record'; return; }
      rows.forEach((h) => window.__TREKLY_LEDGER.hotels.push({
        id: h.id, name: h.name, star: h.star, score: h.score, area: h.area,
        room: h.room, price: h.price, checkin }));
      $('#log').textContent = `Recorded ${rows.length} stays for ${checkin}`;
      $('#ledger-table').querySelector('tbody').innerHTML = window.__TREKLY_LEDGER.hotels
        .map((h, i) => `<tr><td>${i + 1}</td><td>${esc(h.name)}</td><td>${'★'.repeat(h.star)}</td>`
          + `<td>${h.score}</td><td>${h.area}</td><td class="rate">¥${h.price}</td></tr>`).join('');
    };
  }

  if (document.body.dataset.page === 'flights') flightsPage();
  else if (document.body.dataset.page === 'hotels') hotelsPage();
})();
