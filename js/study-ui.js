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

  const ui = { res: null, an: null, filter: 'win', sort: { key: 'bd', dir: -1 }, limit: 300, idx: new Map(), loadPaths: null };

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
    $('st-meta').textContent = `Dihitung ${new Date(res.created).toLocaleString('id-ID')} · ${p.fromYear}–${p.toYear} · ${res.trades.length.toLocaleString('id-ID')} trade dari ${res.symbols.toLocaleString('id-ID')} saham` +
      (res.sectorSource ? ` · sektor dari ${res.sectorSource === 'file' ? 'config/sektor.txt' : 'tebakan korelasi harga'}` : '');
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
      <th data-k="n">Bar</th><th data-k="b">Buy selama dipegang</th><th data-k="g">Gain akhir</th><th data-k="m">Gain maks</th>${feats.map((m) => `<th data-k="${m.key}">${esc(m.label)}</th>`).join('')}</tr></thead>
      <tbody>${shown.map((t) => `<tr class="trade-row" data-ti="${ui.idx.get(t)}"><td><a href="#" data-chart="${t.s}">${t.s}</a>${t.o ? '<span class="badge">buka</span>' : ''}</td>
        <td>${tgl(t.bd)}</td><td>${num(t.bp, 0)}</td><td>${tgl(t.sd)}</td><td>${num(t.sp, 0)}</td><td>${t.n}</td><td>${t.b ?? '-'}</td>
        <td class="${cls(t.g)}">${num(t.g)}%</td><td class="up">${num(t.m)}%</td>
        ${t.f.map((v, k) => (feats[k].type === 'num' ? `<td>${num(v, feats[k].dec)}</td>` : `<td class="txt">${esc(v ?? '')}</td>`)).join('')}</tr>`).join('')}</tbody>`;
    $('st-more').hidden = list.length <= ui.limit;
  }

  function setResult(res) {
    ui.res = res;
    ui.limit = 300;
    ui.idx = new Map((res ? res.trades : []).map((t, k) => [t, k]));
    if (res) {
      const ys = [];
      for (let y = res.params.fromYear; y < res.params.toYear; y++) ys.push(y);
      const cur = $('st-split').value;
      $('st-split').innerHTML = '<option value="">Tanpa periode uji</option>' + ys.map((y) => `<option value="${y}">${y} (uji ${y + 1}–${res.params.toYear})</option>`).join('');
      if (cur && ys.includes(Number(cur))) $('st-split').value = cur;
    }
    render();
  }

  /** Grafik jejak harian satu trade: batang High–Low, garis Close, garis harga Buy, titik sinyal Buy lagi. */
  function drawPath(cv, t, p) {
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#05081a'; ctx.fillRect(0, 0, W, H);
    const lo = Math.min(...p.l), hi = Math.max(...p.h);
    const L = 46, R = W - 10, T = 10, B = H - 20;
    const X = (i) => L + (p.d.length > 1 ? (i / (p.d.length - 1)) * (R - L) : (R - L) / 2);
    const Y = (v) => B - ((v - lo) / (hi - lo || 1)) * (B - T);
    ctx.font = '10px system-ui'; ctx.fillStyle = '#9aa6c4';
    [lo, t.bp, hi].forEach((v) => ctx.fillText(num(v, 0), 2, Y(v) + 3));
    ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(L, Y(t.bp)); ctx.lineTo(R, Y(t.bp)); ctx.stroke(); ctx.setLineDash([]);
    const bw = Math.max(1, Math.min(6, (R - L) / p.d.length - 1));
    for (let i = 0; i < p.d.length; i++) {
      ctx.fillStyle = p.c[i] >= t.bp ? 'rgba(52,211,153,.45)' : 'rgba(251,113,133,.45)';
      ctx.fillRect(X(i) - bw / 2, Y(p.h[i]), bw, Math.max(1, Y(p.l[i]) - Y(p.h[i])));
    }
    ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2; ctx.beginPath();
    p.c.forEach((c, i) => (i ? ctx.lineTo(X(i), Y(c)) : ctx.moveTo(X(i), Y(c))));
    ctx.stroke();
    ctx.fillStyle = '#ffd60a';
    for (const i of p.b) { ctx.beginPath(); ctx.arc(X(i), Y(p.l[i]) + 6, 3, 0, 7); ctx.fill(); }
    ctx.fillStyle = '#9aa6c4';
    ctx.fillText(tgl(p.d[0]), L, H - 5);
    ctx.textAlign = 'right'; ctx.fillText(tgl(p.d[p.d.length - 1]), R, H - 5); ctx.textAlign = 'left';
  }

  async function toggleDetail(tr) {
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('path-row')) { next.remove(); return; }
    const k = Number(tr.dataset.ti);
    const t = ui.res.trades[k];
    const paths = ui.loadPaths ? await ui.loadPaths() : null;
    const p = paths && paths.paths[k];
    if (!p) return;
    const row = document.createElement('tr');
    row.className = 'path-row';
    const minL = Math.min(...p.l), maxH = Math.max(...p.h);
    row.innerHTML = `<td colspan="99"><div class="path-box"><div class="muted">${t.s} · ${tgl(t.bd)} → ${tgl(t.sd)} · ${p.d.length} hari · ` +
      `turun terdalam ${num((minL / t.bp - 1) * 100)}% · naik tertinggi ${num((maxH / t.bp - 1) * 100)}% · ` +
      `titik kuning = sinyal Buy lagi (${p.b.length}×) · garis putus = harga Buy</div><canvas class="path-cv"></canvas></div></td>`;
    tr.after(row);
    drawPath(row.querySelector('canvas'), t, p);
  }

  function bind(onChart, loadPaths) {
    ui.loadPaths = loadPaths;
    $('st-csv-path').addEventListener('click', async () => {
      if (!ui.res) return;
      const paths = await loadPaths();
      if (!paths) return;
      const blob = new Blob([Study.pathsToCSV(ui.res, paths)], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `jejak-harian-${ui.res.params.fromYear}-${ui.res.params.toYear}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
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
      const tr = e.target.closest('tr.trade-row');
      if (tr) { toggleDetail(tr); return; }
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
