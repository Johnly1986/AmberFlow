/* 复刻站的交互：所有筛选/排序状态都写在 URL 参数里（真实列表页就是这么做的，
   点筛选=一次导航），所以每个子目标只做一次点击就能落到确定的页面状态。
   页面自己维护 window.__CTRIP_RECORDS —— 只有点击「记录」才会往里写，
   ctrip_task.py 在每个子目标跑完后把它读走（站点自己的账本，不是数据源偷看）。 */
(function () {
  const D = window.CTRIP;
  const q = new URLSearchParams(location.search);
  window.__CTRIP_RECORDS = { page: document.body.dataset.page, flights: [], hotels: [] };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const $t = (name) => document.querySelector(`[data-test="${name}"]`);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const WINDOWS = [
    ['all', '不限', null],
    ['0000-0800', '00:00-08:00', ['00:00', '07:59']],
    ['0800-1800', '08:00-18:00', ['08:00', '18:00']],
    ['1800-2400', '18:00-24:00', ['18:00', '23:59']],
  ];
  const SORTS = [
    ['default', '默认排序'],
    ['price_asc', '价格从低到高'],
    ['time_asc', '时间从早到晚'],
  ];
  const CAPS = [
    ['all', '不限'],
    ['200', '¥200以下'],
    ['300', '¥300以下'],
    ['500', '¥500以下'],
  ];

  function url(base, params) {
    const u = new URLSearchParams(params);
    return base + '?' + u.toString();
  }

  // ------------------------------------------------------------------ 机票
  function flightsPage() {
    const from = q.get('from') || D.route.from_code;
    const to = q.get('to') || D.route.to_code;
    const date = q.get('date') || D.dates[0].date;
    const win = q.get('window') || 'all';
    const sort = q.get('sort') || 'default';
    const day = D.dates.find((d) => d.date === date) || D.dates[0];

    $t('route').textContent = `${D.route.from}(${from}) → ${D.route.to}(${to})`;
    $t('dep-date').textContent = `出发日期：${date} ${day.wd}`;
    $('#from-input').value = D.route.from;
    $('#to-input').value = D.route.to;
    $('#date-input').value = `${date} ${day.wd}`;

    // 日期条：保留当前筛选/排序，切日期不丢条件（携程的行为）
    $t('date-tabs').innerHTML = D.dates.map((d) => {
      const p = { from, to, date: d.date };
      if (win !== 'all') p.window = win;
      if (sort !== 'default') p.sort = sort;
      return `<a data-test="date-tab-${d.date}" class="${d.date === date ? 'active' : ''}"`
        + ` href="${url('flights.html', p)}">${d.short} ${d.wd}</a>`;
    }).join('');

    const withState = (extra) => {
      const p = { from, to, date, ...extra };
      return url('flights.html', p);
    };
    $t('filters-window').innerHTML = '<span class="filter-label">出发时段</span>' + WINDOWS.map(
      ([key, label]) => `<a data-test="window-${key}" class="${key === win ? 'selected' : ''}"`
        + ` href="${withState({ window: key, sort })}">${label}</a>`).join('');
    $t('filters-sort').innerHTML = '<span class="filter-label">排序</span>' + SORTS.map(
      ([key, label]) => `<a data-test="sort-${key}" class="${key === sort ? 'selected' : ''}"`
        + ` href="${withState({ window: win, sort: key })}">${label}</a>`).join('');

    const w = WINDOWS.find((x) => x[0] === win) || WINDOWS[0];
    const rows = D.flights.filter((f) => f.date === date)
      .filter((f) => !w[2] || (f.dep >= w[2][0] && f.dep <= w[2][1]));
    if (sort === 'price_asc') rows.sort((a, b) => a.price - b.price || a.dep.localeCompare(b.dep));
    else if (sort === 'time_asc') rows.sort((a, b) => a.dep.localeCompare(b.dep));

    $t('window-state').textContent = `出发时段：${w[1]}`;
    $t('sort-state').textContent = `排序：${(SORTS.find((s) => s[0] === sort) || SORTS[0])[1]}`;
    $t('result-count').textContent = `共 ${rows.length} 个航班`;
    $t('flight-list').innerHTML = rows.length ? rows.map((f) => `
      <li class="flight-card" data-test="flight-card" data-no="${f.no}" data-dep="${f.dep}"
          data-price="${f.price}" data-promo="${f.promo ? 1 : 0}">
        <div>
          <div class="times">${f.dep} → ${f.arr} <span class="dur">${f.dur}</span></div>
          <div class="airline">${esc(f.airline)} <span class="no">${f.no}</span> · ${f.plane}${f.promo ? '<span class="badge">特价</span>' : ''}</div>
        </div>
        <div class="flight-price">¥${f.price}<small> 起</small></div>
      </li>`).join('') : '<li class="empty">没有符合出发时段条件的航班</li>';

    $t('record-lowest').onclick = () => {
      if (!rows.length) {
        $t('last-record').textContent = '无符合条件的航班，未能记录';
        return;
      }
      const f = rows[0];
      const text = `已记录 ${f.date} ${f.no} ${f.airline} ${f.dep}-${f.arr} ¥${f.price}`;
      $t('last-record').textContent = text;
      window.__CTRIP_RECORDS.flights.push({
        date: f.date, no: f.no, airline: f.airline, dep: f.dep, arr: f.arr,
        price: f.price, window: w[1], sort: SORTS.find((s) => s[0] === sort)[1],
      });
      $t('record-table').querySelector('tbody').insertAdjacentHTML('beforeend',
        `<tr><td>${f.date}</td><td>${f.no}</td><td>${f.dep}-${f.arr}</td><td>¥${f.price}</td>`
        + `<td>${w[1]}</td></tr>`);
    };
  }

  // ------------------------------------------------------------------ 酒店
  function hotelsPage() {
    const city = q.get('city') || '北京';
    const checkin = q.get('checkin') || D.dates[0].date;
    const cap = q.get('cap') || 'all';
    const sort = q.get('sort') || 'default';

    $('#city').textContent = city;
    $('#checkin').textContent = `入住：${checkin}　离店：${addDay(checkin)}`;
    $('#city-input').value = city;
    $('#checkin-input').value = checkin;
    const withState = (extra) => url('hotels.html', { city, checkin, ...extra });
    $t('filters-cap').innerHTML = '<span class="filter-label">价格上限</span>' + CAPS.map(
      ([key, label]) => `<a data-test="cap-${key}" class="${key === cap ? 'selected' : ''}"`
        + ` href="${withState({ cap: key, sort })}">${label}</a>`).join('');
    $t('filters-sort').innerHTML = '<span class="filter-label">排序</span>' + SORTS.map(
      ([key, label]) => `<a data-test="h-sort-${key}" class="${key === sort ? 'selected' : ''}"`
        + ` href="${withState({ cap, sort: key })}">${label}</a>`).join('');

    const limit = cap === 'all' ? Infinity : Number(cap);
    const rows = D.hotels.filter((h) => h.price <= limit);
    if (sort === 'price_asc') rows.sort((a, b) => a.price - b.price || b.score - a.score);
    else if (sort === 'time_asc') rows.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

    $t('price-cap-state').textContent = `价格上限：${(CAPS.find((c) => c[0] === cap) || CAPS[0])[1]}`;
    $t('sort-state').textContent = `排序：${(SORTS.find((s) => s[0] === sort) || SORTS[0])[1]}`;
    $t('result-count').textContent = `共 ${rows.length} 家酒店`;
    $t('hotel-list').innerHTML = rows.length ? rows.map((h) => `
      <li class="hotel-card" data-test="hotel-card" data-id="${h.id}" data-price="${h.price}">
        <div>
          <div class="hotel-name">${esc(h.name)} <span class="star">${'★'.repeat(h.star)}</span></div>
          <div class="tagline">${h.area} · ${h.room} · ${h.tags.join(' / ')}</div>
          <div class="tagline"><span class="score">${h.score}</span> 分 · ${h.reviews} 条点评</div>
        </div>
        <div class="flight-price">¥${h.price}<small> /晚</small></div>
      </li>`).join('') : '<li class="empty">没有符合价格条件的酒店</li>';

    $t('record-hotels').onclick = () => {
      if (!rows.length) {
        $t('hotel-recorded').textContent = '无符合条件的酒店，未能记录';
        return;
      }
      rows.forEach((h) => window.__CTRIP_RECORDS.hotels.push({
        id: h.id, name: h.name, star: h.star, score: h.score, area: h.area,
        room: h.room, price: h.price, checkin,
      }));
      $t('hotel-recorded').textContent = `已记录 ${rows.length} 家 ${checkin} 入住、`
        + `${(CAPS.find((c) => c[0] === cap) || CAPS[0])[1]}的酒店`;
      $t('hotel-record-table').querySelector('tbody').innerHTML = rows.map((h, i) =>
        `<tr><td>${i + 1}</td><td>${esc(h.name)}</td><td>${'★'.repeat(h.star)}</td>`
        + `<td>${h.score}</td><td>${h.area}</td><td>¥${h.price}</td></tr>`).join('');
    };
  }

  function addDay(iso) {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  if (document.body.dataset.page === 'flights') flightsPage();
  else if (document.body.dataset.page === 'hotels') hotelsPage();
})();
