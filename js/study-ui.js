/*
 * study-ui.js — tampilan tab Studi Trade (tabel perbandingan & daftar trade).
 */
(function (global) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const num = (x, d = 1) => (Number.isFinite(x) ? x.toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d }) : '-');
  const tgl = (d) => `${String(d % 100).padStart(2, '0')}/${String(Math.floor(d / 100) % 100).padStart(2, '0')}/${Math.floor(d / 10000)}`;
  const cls = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : '');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const ui = { res: null, an: null, filter: 'win', sort: { key: 'bd', dir: -1 }, limit: 300 };

  /** Sel win rate berwarna: makin tinggi dibanding rata-rata, makin hijau. */
  function rateCell(v, base, best) {
    if (!Number.isFinite(v)) return '<td class="muted">-</td>';
    const diff = v - base;
    const a = Math.min(Math.abs(diff) / Math.max(base, 5), 1) * 0.55;
    const bg = diff >= 0 ? `rgba(52,211,153,${a})` : `rgba(251,113,133,${a})`;
    return `<td style="background:${bg}${best ? ';font-weight:800' : ''}">${num(v, 0)}%</td>`;
  }

  function render() {
    const res = ui.res;
    if (!res) { $('st-result').hidden = true; return; }
    $('st-result').hidden = false;
    const p = res.params;
    $('st-meta').textContent = `Dihitung ${new Date(res.created).toLocaleString('id-ID')} · ${p.fromYear}–${p.toYear} · ${res.trades.length.toLocaleString('id-ID')} trade dari ${res.symbols.toLocaleString('id-ID')} saham`;
    const opt = {
      threshold: Number($('st-thr').value) || 0,
      gainType: $('st-type').value,
      splitYear: Number($('st-split').value) || null,
      includeOpen: $('st-open').checked,
    };
    const an = Study.analyze(res, opt);
    ui.an = an;
    const s = an.summary;
    $('st-summary').innerHTML = [
      ['Trade (periode studi)', s.total.toLocaleString('id-ID'), ''],
      ['Pemenang', `${s.winners.toLocaleString('id-ID')} (${num(s.winRate)}%)`, 'up'],
      ['Rata-rata gain akhir', `${num(s.avgGain)}%`, cls(s.avgGain)],
      ['Median gain pemenang', `${num(s.avgGainWin)}%`, 'up'],
      ['Median lama pegang', `${num(s.medHold, 0)} bar`, ''],
      ...(opt.splitYear ? [['Periode uji', `${s.testTotal.toLocaleString('id-ID')} trade · win ${num(s.testRate)}%`, '']] : []),
    ].map(([k, v, c]) => `<div class="stat ${c}"><span>${k}</span><b>${v}</b></div>`).join('');

    // indikator angka
    const nums = an.rows.filter((r) => r.type === 'num');
    const base = s.winRate, baseT = s.testRate;
    $('st-num').innerHTML = `<thead><tr><th>Indikator</th><th>Median pemenang</th><th>Median semua</th><th>Median lainnya</th>
      <th>Q1</th><th>Q2</th><th>Q3</th><th>Q4</th>${opt.splitYear ? '<th>Uji Q1</th><th>Uji Q2</th><th>Uji Q3</th><th>Uji Q4</th>' : ''}</tr></thead><tbody>${nums.map((r) => {
      const best = Math.max(...r.study.filter(Number.isFinite));
      const qTitle = `batas kuartil: ${r.cuts.map((c) => num(c, r.dec)).join(' | ')}`;
      return `<tr><td title="${esc(qTitle)}">${esc(r.label)}</td><td class="up">${num(r.medWin, r.dec)}</td><td>${num(r.medAll, r.dec)}</td><td>${num(r.medLose, r.dec)}</td>
        ${r.study.map((v) => rateCell(v, base, v === best)).join('')}
        ${r.test ? r.test.map((v) => rateCell(v, baseT, false)).join('') : ''}</tr>`;
    }).join('')}</tbody>`;

    // indikator kategori
    const cats = an.rows.filter((r) => r.type === 'cat');
    $('st-cat').innerHTML = `<thead><tr><th>Indikator</th><th>Kategori</th><th>Jumlah trade</th><th>% dari pemenang</th><th>% dari semua</th><th>Win rate</th>${opt.splitYear ? '<th>Win rate uji</th>' : ''}</tr></thead><tbody>${cats.map((r) => r.cats.map((c, k) =>
      `<tr><td>${k === 0 ? esc(r.label) : ''}</td><td class="txt">${esc(c.c)}</td><td>${c.n.toLocaleString('id-ID')}</td>
      <td>${num(c.shareWin)}%</td><td>${num(c.shareAll)}%</td>${rateCell(c.rate, base, false)}${opt.splitYear ? rateCell(c.test, baseT, false) : ''}</tr>`).join('')).join('')}</tbody>`;

    renderTrades();
  }

  function renderTrades() {
    const res = ui.res;
    const an = ui.an;
    const q = $('st-search').value.trim().toUpperCase();
    let list = res.trades;
    if (ui.filter === 'win') list = list.filter(an.win);
    if (ui.filter === 'open') list = list.filter((t) => t.o);
    if (q) list = list.filter((t) => t.s.includes(q));
    const { key, dir } = ui.sort;
    const fi = res.featureList.findIndex((m) => m.key === key);
    const val = (t) => (fi >= 0 ? t.f[fi] : t[key]);
    list = [...list].sort((a, b) => {
      const x = val(a), y = val(b);
      if (typeof x === 'string' || typeof y === 'string') return String(x).localeCompare(String(y)) * dir;
      return ((x ?? -Infinity) - (y ?? -Infinity)) * dir;
    });
    $('st-count').textContent = `${list.length.toLocaleString('id-ID')} trade`;
    const shown = list.slice(0, ui.limit);
    const feats = res.featureList;
    $('st-trades').innerHTML = `<thead><tr><th data-k="s">Saham</th><th data-k="bd">Buy</th><th data-k="bp">Harga</th><th data-k="sd">Sell</th><th data-k="sp">Harga</th>
      <th data-k="n">Bar</th><th data-k="g">Gain akhir</th><th data-k="m">Gain maks</th>${feats.map((m) => `<th data-k="${m.key}">${esc(m.label)}</th>`).join('')}</tr></thead>
      <tbody>${shown.map((t) => `<tr><td><a href="#" data-chart="${t.s}">${t.s}</a>${t.o ? '<span class="badge">buka</span>' : ''}</td>
        <td>${tgl(t.bd)}</td><td>${num(t.bp, 0)}</td><td>${tgl(t.sd)}</td><td>${num(t.sp, 0)}</td><td>${t.n}</td>
        <td class="${cls(t.g)}">${num(t.g)}%</td><td class="up">${num(t.m)}%</td>
        ${t.f.map((v, k) => (feats[k].type === 'num' ? `<td>${num(v, feats[k].dec)}</td>` : `<td class="txt">${esc(v ?? '')}</td>`)).join('')}</tr>`).join('')}</tbody>`;
    $('st-more').hidden = list.length <= ui.limit;
  }

  function setResult(res) {
    ui.res = res;
    ui.limit = 300;
    if (res) {
      const ys = [];
      for (let y = res.params.fromYear; y < res.params.toYear; y++) ys.push(y);
      const cur = $('st-split').value;
      $('st-split').innerHTML = '<option value="">Tanpa periode uji</option>' + ys.map((y) => `<option value="${y}">${y} (uji ${y + 1}–${res.params.toYear})</option>`).join('');
      if (cur && ys.includes(Number(cur))) $('st-split').value = cur;
    }
    render();
  }

  function bind(onChart) {
    ['st-thr', 'st-type', 'st-split', 'st-open'].forEach((id) => $(id).addEventListener('change', render));
    $('st-search').addEventListener('input', () => { ui.limit = 300; renderTrades(); });
    $('st-more').addEventListener('click', () => { ui.limit += 300; renderTrades(); });
    $('st-filter').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      ui.filter = b.dataset.f;
      ui.limit = 300;
      document.querySelectorAll('#st-filter button').forEach((x) => x.classList.toggle('on', x === b));
      renderTrades();
    });
    $('st-trades').addEventListener('click', (e) => {
      const a = e.target.closest('[data-chart]');
      if (a) { e.preventDefault(); onChart(a.dataset.chart); return; }
      const th = e.target.closest('th[data-k]');
      if (th) {
        const k = th.dataset.k;
        ui.sort = { key: k, dir: ui.sort.key === k ? -ui.sort.dir : -1 };
        renderTrades();
      }
    });
    $('st-csv').addEventListener('click', () => {
      if (!ui.res) return;
      const blob = new Blob([Study.toCSV(ui.res, ui.an.win)], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `studi-trade-${ui.res.params.fromYear}-${ui.res.params.toYear}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
  }

  global.StudyUI = { setResult, bind, render, get result() { return ui.res; } };
})(typeof window !== 'undefined' ? window : globalThis);
