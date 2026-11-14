/*
 * study.js — modul Studi Trade.
 *
 * 1. Mengumpulkan SEMUA trade (Buy → Sell) di semua saham dalam rentang tahun yang dipilih.
 * 2. Mencatat nilai indikator di hari Buy (indikatornya datang dari formula privat).
 * 3. Membandingkan trade pemenang (gain ≥ threshold) dengan semua trade, per indikator,
 *    termasuk pengecekan di periode uji (out-of-sample).
 *
 * Hemat memori: data riwayat dimuat per kelompok saham, langsung dibuang setelah dihitung.
 * Yang disimpan hanya daftar trade. File arsip di perangkat bisa dihapus setelah selesai.
 */
(function (global) {
  'use strict';

  const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const round = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);

  /**
   * Jalankan studi.
   * @param o {gh, files (daftar file tahun {name,path,sha}), engine, exclude:Set, isStock(sym, db)->bool,
   *           params {fromYear, toYear, feeBuy, feeSell}, progress(frac, msg)}
   */
  async function collect(o) {
    const { params } = o;
    const fb = params.feeBuy / 100, fs = params.feeSell / 100;
    const from = params.fromYear * 10000 + 101, to = params.toYear * 10000 + 1231;
    // 1 tahun sebelum rentang ikut dimuat sebagai pemanasan indikator
    const files = o.files.filter((f) => { const y = Number(f.name.slice(0, 4)); return y >= params.fromYear - 1 && y <= params.toYear; })
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!files.length) throw new Error('Tidak ada file data untuk rentang tahun itu.');
    const groups = Math.max(1, Math.ceil(files.length / 6));
    const meta = o.engine.featureList;
    const trades = [];
    let symbolsDone = 0;

    for (let g = 0; g < groups; g++) {
      // a. muat riwayat hanya untuk kelompok saham ini
      let db = new Data.PriceDB();
      for (let k = 0; k < files.length; k++) {
        o.progress((g + (k / files.length) * 0.5) / groups, `Kelompok ${g + 1}/${groups} · membaca ${files[k].name.slice(0, 4)}`);
        const obj = await Data.gunzipJSON(await o.gh.getBytes(files[k].path, files[k].sha));
        const part = {};
        for (const sym of Object.keys(obj.s)) if (sym === '^JKSE' || hash(sym) % groups === g) part[sym] = obj.s[sym];
        db.loadYear({ names: obj.names || {}, s: part });
        await tick();
      }
      // b. hitung trade per saham
      const base = db.series('^JKSE') || { date: new Int32Array(0), C: new Float64Array(0) };
      const syms = db.symbols().filter((sym) => sym !== '^JKSE' && !o.exclude.has(sym) && o.isStock(sym, db));
      for (let k = 0; k < syms.length; k++) {
        const sym = syms[k];
        if (k % 10 === 0) { o.progress((g + 0.5 + (k / syms.length) * 0.5) / groups, `Kelompok ${g + 1}/${groups} · ${sym}`); await tick(); }
        const s = db.series(sym);
        if (!s || s.C.length < (o.engine.minBars || 80)) continue;
        const f = o.engine.features(s, { base });
        const n = s.C.length;
        for (let i = 0; i < n; i++) {
          if (!f.buy[i] || s.date[i] < from || s.date[i] > to) continue;
          let j = i + 1;
          while (j < n && !f.sell[j]) j++;
          const open = j >= n;
          if (open) j = n - 1;
          const bp = s.C[i], sp = s.C[j];
          let hi = bp;
          for (let k2 = i + 1; k2 <= j; k2++) if (s.H[k2] > hi) hi = s.H[k2];
          const cost = bp * (1 + fb);
          trades.push({
            s: sym, bd: s.date[i], bp, sd: s.date[j], sp, n: j - i, o: open ? 1 : 0,
            g: round(((sp * (1 - fs) - cost) / cost) * 100),
            m: round((hi / bp - 1) * 100),
            f: meta.map((x) => (x.type === 'num' ? round(f.values[x.key][i]) : f.values[x.key][i])),
          });
        }
        symbolsDone++;
      }
      db = null; // buang riwayat kelompok ini dari memori
      await tick();
    }
    trades.sort((a, b) => a.bd - b.bd || a.s.localeCompare(b.s));
    o.progress(1, 'Selesai');
    return {
      v: 1, created: new Date().toISOString(), params, featureList: meta, trades, symbols: symbolsDone,
    };
  }

  // ------------------------------------------------------------------ statistik

  const median = (a) => {
    if (!a.length) return NaN;
    const b = [...a].sort((x, y) => x - y);
    const m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  };
  const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : NaN);

  /**
   * Bandingkan pemenang vs semua trade.
   * @param res hasil collect()
   * @param opt {threshold, gainType:'akhir'|'maks', splitYear|null, includeOpen}
   */
  function analyze(res, opt) {
    const win = (t) => (opt.gainType === 'maks' ? t.m : t.g) >= opt.threshold;
    let trades = res.trades;
    if (!opt.includeOpen) trades = trades.filter((t) => !t.o);
    const split = opt.splitYear ? opt.splitYear * 10000 + 1231 : null;
    const study = split ? trades.filter((t) => t.bd <= split) : trades;
    const test = split ? trades.filter((t) => t.bd > split) : [];
    const rate = (arr) => (arr.length ? (arr.filter(win).length / arr.length) * 100 : NaN);

    const summary = {
      total: study.length, winners: study.filter(win).length, winRate: rate(study),
      avgGain: study.reduce((a, t) => a + t.g, 0) / (study.length || 1),
      avgGainWin: median(study.filter(win).map((t) => t.g)),
      medHold: median(study.map((t) => t.n)),
      testTotal: test.length, testRate: rate(test),
    };

    const rows = res.featureList.map((m, k) => {
      if (m.type === 'num') {
        const vals = study.map((t) => t.f[k]).filter((v) => v !== null);
        const sorted = [...vals].sort((a, b) => a - b);
        const cuts = [quantile(sorted, 0.25), quantile(sorted, 0.5), quantile(sorted, 0.75)];
        const bin = (v) => (v === null ? -1 : v <= cuts[0] ? 0 : v <= cuts[1] ? 1 : v <= cuts[2] ? 2 : 3);
        const bins = (arr) => [0, 1, 2, 3].map((b) => rate(arr.filter((t) => bin(t.f[k]) === b)));
        return {
          ...m,
          medWin: median(study.filter(win).map((t) => t.f[k]).filter((v) => v !== null)),
          medAll: median(vals),
          medLose: median(study.filter((t) => !win(t)).map((t) => t.f[k]).filter((v) => v !== null)),
          cuts, study: bins(study), test: split ? bins(test) : null,
        };
      }
      const cats = [...new Set(study.map((t) => t.f[k]))].filter((c) => c !== '' && c !== null).sort();
      const W = study.filter(win);
      return {
        ...m,
        cats: cats.map((c) => {
          const inCat = study.filter((t) => t.f[k] === c);
          return {
            c, n: inCat.length,
            shareWin: (W.filter((t) => t.f[k] === c).length / (W.length || 1)) * 100,
            shareAll: (inCat.length / (study.length || 1)) * 100,
            rate: rate(inCat),
            test: split ? rate(test.filter((t) => t.f[k] === c)) : null,
          };
        }),
      };
    });

    // indikator diurutkan dari yang paling membedakan (selisih win rate kuartil terbaik vs terburuk)
    for (const r of rows) {
      const arr = r.type === 'num' ? r.study : r.cats.filter((c) => c.n >= 20).map((c) => c.rate);
      const v = arr.filter(Number.isFinite);
      r.spread = v.length > 1 ? Math.max(...v) - Math.min(...v) : 0;
    }
    rows.sort((a, b) => b.spread - a.spread);
    return { summary, rows, win };
  }

  /** Daftar trade → teks CSV (pemisah titik koma, cocok untuk Excel Indonesia). */
  function toCSV(res, win) {
    const head = ['Saham', 'Tgl Buy', 'Harga Buy', 'Tgl Sell', 'Harga Sell', 'Bar', 'Masih terbuka', 'Gain akhir %', 'Gain maks %', 'Pemenang',
      ...res.featureList.map((m) => m.label)];
    const d = (x) => `${x % 100}/${Math.floor(x / 100) % 100}/${Math.floor(x / 10000)}`;
    const cell = (v) => (v === null || v === undefined ? '' : typeof v === 'number' ? String(v).replace('.', ',') : `"${String(v).replace(/"/g, '""')}"`);
    const lines = res.trades.map((t) => [t.s, d(t.bd), t.bp, d(t.sd), t.sp, t.n, t.o ? 'ya' : '', t.g, t.m, win(t) ? 'ya' : '', ...t.f].map(cell).join(';'));
    return '﻿' + [head.map(cell).join(';'), ...lines].join('\r\n');
  }

  const Study = { collect, analyze, toCSV, median };
  global.Study = Study;
  if (typeof module !== 'undefined' && module.exports) module.exports = Study;
})(typeof window !== 'undefined' ? window : globalThis);
