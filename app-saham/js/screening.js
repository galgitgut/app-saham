/*
 * screening.js — menjalankan formula (dari repo privat) ke semua saham, seperti "Explore" di AmiBroker.
 * File ini tidak berisi rumus apa pun; rumus datang dari objek `engine`.
 */
(function (global) {
  'use strict';

  /**
   * Hitung formula untuk satu simbol (hasil disimpan di cache sampai data berubah).
   * @returns {{s, r}} s = seri harga, r = hasil formula
   */
  function compute(ctx, engineKey, sym) {
    const key = `${engineKey}|${sym}`;
    if (ctx.cache.has(key)) return ctx.cache.get(key);
    const s = ctx.db.series(sym, ctx.fromDate);
    let out = null;
    if (s && s.C.length >= (ctx.engines[engineKey].minBars || 1)) {
      out = { s, r: ctx.engines[engineKey].run(s, { base: ctx.base }) };
    }
    ctx.cache.set(key, out);
    return out;
  }

  /**
   * Jalankan screening.
   * @param ctx {db, engines, base, exclude:Set, cache:Map, fromDate}
   * @param engineKey nama formula
   * @param date tanggal yyyymmdd
   * @returns {{rows, universe}}
   */
  function run(ctx, engineKey, date) {
    const engine = ctx.engines[engineKey];
    const rows = [];
    let universe = 0;
    for (const sym of ctx.db.symbols()) {
      if (ctx.exclude.has(sym) || !Data.isIdxStock(ctx.db, sym)) continue;
      const res = compute(ctx, engineKey, sym);
      if (!res) continue;
      const i = res.s.date.indexOf(date);
      if (i < 0) continue; // tidak ada bar di tanggal ini (suspend / basi)
      universe++;
      if (!res.r.filter[i]) continue;
      const values = {};
      const colors = {};
      for (const c of engine.columns) {
        values[c.key] = res.r.cols[c.key][i];
        const fn = res.r.colors && res.r.colors[c.key];
        if (fn && i > 1) colors[c.key] = fn(i);
      }
      rows.push({ sym, date, provisional: res.s.P[i] === 1, values, colors });
    }
    sortRows(rows, engine.sort || []);
    return { rows, universe };
  }

  function cmp(a, b) {
    const na = typeof a === 'number' && !Number.isNaN(a);
    const nb = typeof b === 'number' && !Number.isNaN(b);
    if (typeof a === 'string' || typeof b === 'string') return String(a ?? '').localeCompare(String(b ?? ''));
    if (!na && !nb) return 0;
    if (!na) return 1;
    if (!nb) return -1;
    return a - b;
  }

  function sortRows(rows, spec) {
    rows.sort((x, y) => {
      for (const { key, dir } of spec) {
        const c = (key === '__sym' ? x.sym.localeCompare(y.sym) : cmp(x.values[key], y.values[key])) * dir;
        if (c) return c;
      }
      return x.sym.localeCompare(y.sym);
    });
  }

  function fmt(v, dec) {
    if (v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v))) return '';
    if (typeof v === 'string') return v;
    return v.toLocaleString('id-ID', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  const fmtDate = (d) => `${String(d % 100).padStart(2, '0')}/${String(Math.floor(d / 100) % 100).padStart(2, '0')}/${Math.floor(d / 10000)}`;

  /** Gambar tabel hasil. onPick(sym) dipanggil saat kode saham diklik. */
  function render(table, engine, result, onPick) {
    let sortSpec = engine.sort || [];
    const draw = () => {
      const head = ['<tr><th data-k="__sym">Ticker</th><th>Tanggal</th>',
        ...engine.columns.map((c) => `<th data-k="${c.key}">${c.label}</th>`), '</tr>'].join('');
      const body = result.rows.map((r) => {
        const cells = engine.columns.map((c) => {
          const v = r.values[c.key];
          const col = r.colors[c.key];
          const cls = [c.type === 'text' ? 'txt' : '', col === 1 ? 'up' : col === -1 ? 'down' : '',
            c.key === 'BuyStatus' && v && v !== 'Report' && v !== 'Sell' ? 'sig' : ''].join(' ');
          return `<td class="${cls}">${fmt(v, c.dec)}</td>`;
        }).join('');
        const badge = r.provisional ? '<span class="badge" title="Bar sementara dari DATA1">S</span>' : '';
        return `<tr><td><a href="#" data-sym="${r.sym}">${r.sym}</a>${badge}</td><td>${fmtDate(r.date)}</td>${cells}</tr>`;
      }).join('');
      table.innerHTML = `<thead>${head}</thead><tbody>${body || `<tr><td colspan="${engine.columns.length + 2}" class="txt muted">Tidak ada saham yang lolos filter.</td></tr>`}</tbody>`;
    };
    table.onclick = (e) => {
      const a = e.target.closest('a[data-sym]');
      if (a) { e.preventDefault(); onPick(a.dataset.sym); return; }
      const th = e.target.closest('th[data-k]');
      if (th) {
        const k = th.dataset.k;
        const dir = sortSpec[0] && sortSpec[0].key === k ? -sortSpec[0].dir : -1;
        sortSpec = [{ key: k, dir }];
        sortRows(result.rows, sortSpec);
        draw();
      }
    };
    draw();
  }

  const Screening = { run, render, compute, fmtDate };
  global.Screening = Screening;
  if (typeof module !== 'undefined' && module.exports) module.exports = Screening;
})(typeof window !== 'undefined' ? window : globalThis);
