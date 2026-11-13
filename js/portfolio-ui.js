/*
 * portfolio-ui.js — menggambar tab Portofolio dari hasil Portfolio.simulate().
 * Semua aksi (setuju, lewati, edit lot) dikirim ke app.js lewat objek `h` (handler).
 */
(function (global) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const rp = (x) => (Number.isFinite(x) ? Math.round(x).toLocaleString('id-ID') : '-');
  const num = (x, d = 0) => (Number.isFinite(x) ? x.toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d }) : '-');
  const pct = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${num(x, 1)}%` : '-');
  const cls = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : '');
  const tgl = (d) => `${String(d % 100).padStart(2, '0')}/${String(Math.floor(d / 100) % 100).padStart(2, '0')}/${Math.floor(d / 10000)}`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function render(r, h) {
    const lastS = r.positions.some((p) => p.provisional) || r.candidates.some((c) => c.provisional);
    // ringkasan
    const total = r.unrealized + r.realized;
    $('po-summary').innerHTML = [
      ['Data', `${tgl(r.lastDate)}${lastS ? ' <span class="badge">S</span>' : ''}`, ''],
      ['Modal', rp(r.modal), ''],
      ['Terpakai', rp(r.invested), ''],
      ['Sisa kas', rp(r.available), r.available < 0 ? 'down' : ''],
      ['Slot sistem', `${r.systemCount} / ${r.cfg.slots}`, r.systemCount >= r.cfg.slots ? 'warn' : ''],
      ['P/L berjalan', rp(r.unrealized), cls(r.unrealized)],
      ['P/L terealisasi', rp(r.realized), cls(r.realized)],
      ['Total P/L tahun ini', `${rp(total)}`, cls(total)],
    ].map(([k, v, c]) => `<div class="stat ${c}"><span>${k}</span><b>${v}</b></div>`).join('');

    // jual hari ini
    $('po-sold').innerHTML = r.soldToday.length
      ? `<div class="card alert-sell"><h3>⚠ SELL hari ini (${tgl(r.lastDate)})</h3>${r.soldToday.map((s) =>
        `<div class="sold-row"><a href="#" data-chart="${s.sym}">${s.sym}</a> · ${num(s.lots)} lot @ ${num(s.price)} · <span class="${cls(s.pl)}">${rp(s.pl)} (${pct(s.plPct)})</span></div>`).join('')}</div>`
      : '';

    // posisi
    const ev = r.events;
    const posRows = r.positions.map((p) => {
      const add = p.addPending;
      let action = `<button class="small" data-edit="${p.sym}">Edit lot</button>`;
      if (add) {
        action = `<div class="act"><span class="hint">Buy ke-${add.buyNo} → porsi ${add.porsiNext}%</span>
          <input class="lot" type="number" inputmode="numeric" value="${add.lots}" data-lots="${add.key}">
          <button class="ok small" data-approve="${add.key}" data-price="${add.price}">Setuju</button>
          <button class="no small" data-skip="${add.key}">Lewati</button></div>`;
      }
      const buys = ev.filter((e) => e.sym === p.sym && e.lots > 0 && e.d >= p.entry && /BELI|TAMBAH/.test(e.type)).reverse();
      const editor = `<tr class="editor" data-editor="${p.sym}" hidden><td colspan="10">
        ${buys.map((e) => {
          const key = e.type === 'BELI MANUAL' ? `manual:${e.id}` : `${e.d}|${e.sym}|${e.type === 'BELI' ? 'NEW' : 'ADD'}`;
          return `<div class="edit-row"><span>${tgl(e.d)} ${e.type} (saran ${e.suggested ?? e.lots} lot)</span>
            Lot <input class="lot" type="number" value="${e.lots}" data-elots="${esc(key)}">
            Harga <input class="lot" type="number" value="${e.price}" data-eprice="${esc(key)}">
            <button class="small ok" data-esave="${esc(key)}">Simpan</button></div>`;
        }).join('')}
        <p class="muted">Isi 0 lot kalau ternyata tidak jadi beli.</p></td></tr>`;
      return `<tr class="${add ? 'hl-add' : ''}">
        <td><a href="#" data-chart="${p.sym}">${p.sym}</a>${p.source === 'manual' ? '<span class="tag">manual</span>' : ''}${p.provisional ? '<span class="badge">S</span>' : ''}</td>
        <td>${tgl(p.entry)}</td><td>${num(p.lots)}</td><td>${num(p.avg, 0)}</td><td>${num(p.close)}</td>
        <td class="${cls(p.chg)}">${pct(p.chg)}</td><td class="${cls(p.pl)}">${pct(p.plPct)}</td><td class="${cls(p.pl)}">${rp(p.pl)}</td>
        <td>${p.source === 'manual' ? '-' : `${p.porsi}%`}</td><td class="txt">${action}</td></tr>${editor}`;
    }).join('');
    $('po-positions').innerHTML = `<thead><tr><th>Saham</th><th>Masuk</th><th>Lot</th><th>Avg</th><th>Harga</th><th>Hari ini</th><th>P/L %</th><th>P/L Rp</th><th>Porsi</th><th>Aksi</th></tr></thead>
      <tbody>${posRows || '<tr><td colspan="10" class="txt muted">Belum ada posisi.</td></tr>'}</tbody>`;

    // kandidat
    const free = r.cfg.slots - r.systemCount;
    $('po-cand-info').textContent = `${tgl(r.lastDate)} · slot kosong ${Math.max(free, 0)} · urut Power tertinggi`;
    const candRows = r.candidates.map((c) => {
      const lots = c.lots ?? Portfolio.lotsFor(r.perStock * r.cfg.firstPct / 100, c.price, r.cfg.feeBuy);
      const decided = h.decision(c.key);
      let action;
      if (decided) {
        action = `<span class="hint">${decided.act === 'skip' ? 'Dilewati' : `Dibeli ${decided.lots ?? lots} lot`}</span> <button class="small" data-undo="${c.key}">Batal</button>`;
      } else if (c.status === 'disarankan' || c.status === 'slot penuh') {
        action = `<div class="act"><input class="lot" type="number" inputmode="numeric" value="${lots}" data-lots="${c.key}">
          <button class="ok small" data-approve="${c.key}" data-price="${c.price}">Setuju</button>
          <button class="no small" data-skip="${c.key}">Lewati</button></div>`;
      } else {
        action = `<span class="hint">${c.status}</span>`;
      }
      const rowCls = c.status === 'disarankan' ? 'hl-new' : c.status === 'slot penuh' ? 'dim' : c.status === 'lewati' ? 'skipped' : '';
      const label = { disarankan: 'Masuk porto', 'slot penuh': 'Slot penuh', dibeli: 'Dibeli', lewati: 'Dilewati' }[c.status] || c.status;
      return `<tr class="${rowCls}"><td><a href="#" data-chart="${c.sym}">${c.sym}</a>${c.provisional ? '<span class="badge">S</span>' : ''}</td>
        <td>${num(c.power, 2)}</td><td>${num(c.price)}</td><td>${num(lots)}</td><td class="txt">${label}</td><td class="txt">${action}</td></tr>`;
    }).join('');
    $('po-cands').innerHTML = `<thead><tr><th>Saham</th><th>Power</th><th>Harga</th><th>Saran lot</th><th>Status</th><th>Aksi</th></tr></thead>
      <tbody>${candRows || '<tr><td colspan="6" class="txt muted">Tidak ada sinyal Buy baru hari ini.</td></tr>'}</tbody>`;

    renderHistory(r, h.histFilter);

    // badge di tab
    const n = r.pending.length + r.soldToday.length;
    const badge = $('porto-badge');
    badge.hidden = !n;
    badge.textContent = n;
    badge.classList.toggle('sell', r.soldToday.length > 0);
  }

  function renderHistory(r, filter) {
    const t = $('po-history');
    if (filter === 'profit') {
      t.innerHTML = `<thead><tr><th>Saham</th><th>Terealisasi</th><th>Berjalan</th><th>Total</th><th>%</th></tr></thead><tbody>${r.perSymbol.map((x) =>
        `<tr><td><a href="#" data-chart="${x.sym}">${x.sym}</a></td><td class="${cls(x.realized)}">${rp(x.realized)}</td><td class="${cls(x.open)}">${rp(x.open)}</td>
        <td class="${cls(x.total)}">${rp(x.total)}</td><td class="${cls(x.pct)}">${pct(x.pct)}</td></tr>`).join('')}</tbody>`;
      return;
    }
    const rows = r.events.filter((e) => filter === 'all' || e.lots > 0);
    t.innerHTML = `<thead><tr><th>Tanggal</th><th>Saham</th><th>Aksi</th><th>Lot</th><th>Harga</th><th>Nilai</th><th>Porsi</th><th>P/L</th><th>Status</th></tr></thead><tbody>${rows.map((e) =>
      `<tr class="${e.lots ? '' : 'skipped'}"><td>${tgl(e.d)}</td><td><a href="#" data-chart="${e.sym}">${e.sym}</a></td><td class="txt ${/SELL|JUAL/.test(e.type) ? 'down' : 'up'}">${e.type}</td>
      <td>${num(e.lots)}</td><td>${num(e.price)}</td><td>${rp(e.value)}</td><td>${e.porsi ? e.porsi + '%' : ''}</td>
      <td class="${cls(e.pl)}">${e.pl !== undefined ? `${rp(e.pl)} (${pct(e.plPct)})` : ''}</td><td class="txt">${e.status}</td></tr>`).join('')
      || '<tr><td colspan="9" class="txt muted">Belum ada transaksi.</td></tr>'}</tbody>`;
  }

  global.PortfolioUI = { render, renderHistory };
})(typeof window !== 'undefined' ? window : globalThis);
