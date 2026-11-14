/*
 * study.js — modul Studi Trade.
 *
 * 1. Mengumpulkan SEMUA trade (Buy → Sell) di semua saham dalam rentang tahun yang dipilih.
 * 2. Mencatat nilai indikator di hari Buy (indikator teknikal datang dari formula privat),
 *    ditambah umur saham, RRG sektor, dan breadth pasar.
 * 3. Menyimpan jejak harian tiap trade (Close, High, Low, sinyal Buy) untuk simulasi aturan exit/ukuran posisi.
 * 4. Membandingkan trade pemenang (gain ≥ threshold) dengan semua trade, per indikator,
 *    termasuk pengecekan di periode uji (out-of-sample).
 *
 * Hemat memori: data riwayat dimuat per kelompok saham, langsung dibuang setelah dihitung.
 */
(function (global) {
  'use strict';

  const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const r2 = (x) => Math.round(x * 100) / 100;
  const round = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
  const dayNum = (d) => Date.UTC(Math.floor(d / 10000), Math.floor(d / 100) % 100 - 1, d % 100) / 864e5;

  /** Indeks sektor IDX-IC (nama simbol mengikuti DS3). */
  const SECTORS = ['IDXBASIC', 'IDXCYCLIC', 'IDXNONCYC', 'IDXENERGY', 'IDXINFRA', 'IDXHEALTH', 'IDXFINANCE', 'IDXINDUST', 'IDXPROPERT', 'IDXTECHNO', 'IDXTRANS'];

  /** Kolom tambahan yang dihitung modul ini (bukan dari formula privat). */
  const EXTRA = [
    { key: 'umur', label: 'Umur saham di data (tahun)', type: 'num', dec: 1 },
    { key: 'sektor', label: 'Sektor', type: 'cat' },
    { key: 'sektorRsr', label: 'RRG sektor: RS-Ratio', type: 'num', dec: 2 },
    { key: 'sektorRsm', label: 'RRG sektor: RS-Momentum', type: 'num', dec: 2 },
    { key: 'sektorRrg', label: 'RRG sektor: kuadran', type: 'cat' },
    { key: 'breadth50', label: 'Breadth: % saham di atas MA50', type: 'num', dec: 1 },
    { key: 'breadth200', label: 'Breadth: % saham di atas MA200', type: 'num', dec: 1 },
    { key: 'breadthRep', label: 'Breadth: % saham masuk Report', type: 'num', dec: 1 },
  ];

  /** Peta saham → sektor dari teks "KODE;IDXSEKTOR" (satu per baris). */
  function parseSectorMap(text) {
    const m = new Map();
    for (const line of String(text || '').split(/\r?\n/)) {
      const [a, b] = line.split(/[;,\t]/).map((x) => (x || '').trim().toUpperCase());
      if (a && b && !a.startsWith('#')) m.set(a, b.startsWith('IDX') ? b : `IDX${b}`);
    }
    return m;
  }

  /** Sektor ditebak dari korelasi return harian 120 bar terakhir terhadap tiap indeks sektor. */
  function guessSector(s, i, secRet) {
    if (i < 61) return null;
    const from = Math.max(1, i - 120);
    let best = null, bestR = 0.2; // korelasi minimal 0,2
    for (const [sec, map] of secRet) {
      const xs = [], ys = [];
      for (let k = from; k < i; k++) {
        const r = map.get(s.date[k]);
        if (r === undefined) continue;
        xs.push(s.C[k] / s.C[k - 1] - 1); ys.push(r);
      }
      if (xs.length < 60) continue;
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let sxy = 0, sxx = 0, syy = 0;
      for (let k = 0; k < xs.length; k++) { const a = xs[k] - mx, b = ys[k] - my; sxy += a * b; sxx += a * a; syy += b * b; }
      const r = sxy / Math.sqrt(sxx * syy);
      if (r > bestR) { bestR = r; best = sec; }
    }
    return best;
  }

  /**
   * Tanggal pertama tiap simbol di seluruh database (untuk "umur saham").
   * Membaca semua file tahun satu per satu; hasilnya disimpan agar cukup sekali.
   */
  async function buildFirstDates(gh, files, progress, existing = {}) {
    const out = { ...existing };
    const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
    for (let k = 0; k < sorted.length; k++) {
      progress(k / sorted.length, `Mencatat tanggal awal saham · ${sorted[k].name.slice(0, 4)}`);
      const obj = await Data.gunzipJSON(await gh.getBytes(sorted[k].path, sorted[k].sha));
      for (const [sym, rows] of Object.entries(obj.s)) if (rows.length && !(out[sym] <= rows[0][0])) out[sym] = rows[0][0];
      await tick();
    }
    return out;
  }

  /**
   * Jalankan studi.
   * @param o {gh, files, engine, exclude:Set, isStock(sym, db), firstDates:{sym:yyyymmdd}, sectorMap:Map|null,
   *           params {fromYear, toYear, feeBuy, feeSell}, progress(frac, msg)}
   * @returns {{result, paths}} result = ringkasan trade; paths = jejak harian (urutan sama dengan result.trades)
   */
  async function collect(o) {
    const { params } = o;
    const fb = params.feeBuy / 100, fs = params.feeSell / 100;
    const from = params.fromYear * 10000 + 101, to = params.toYear * 10000 + 1231;
    const files = o.files.filter((f) => { const y = Number(f.name.slice(0, 4)); return y >= params.fromYear - 1 && y <= params.toYear; })
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!files.length) throw new Error('Tidak ada file data untuk rentang tahun itu.');
    const groups = Math.max(1, Math.ceil(files.length / 6));
    const meta = [...o.engine.featureList, ...EXTRA];
    const nEng = o.engine.featureList.length;
    const extraIdx = Object.fromEntries(EXTRA.map((m, k) => [m.key, nEng + k]));
    const trades = [];
    const breadth = new Map(); // tanggal → [jumlah saham, di atas MA50, di atas MA200, masuk Report]
    const firstDates = { ...(o.firstDates || {}) };
    let symbolsDone = 0;
    let guessed = 0;
    const always = new Set(['^JKSE', ...SECTORS]);

    for (let g = 0; g < groups; g++) {
      // a. muat riwayat hanya untuk kelompok saham ini (+ ^JKSE dan indeks sektor)
      let db = new Data.PriceDB();
      for (let k = 0; k < files.length; k++) {
        o.progress((g + (k / files.length) * 0.5) / groups, `Kelompok ${g + 1}/${groups} · membaca ${files[k].name.slice(0, 4)}`);
        const obj = await Data.gunzipJSON(await o.gh.getBytes(files[k].path, files[k].sha));
        const part = {};
        for (const sym of Object.keys(obj.s)) if (always.has(sym) || hash(sym) % groups === g) part[sym] = obj.s[sym];
        db.loadYear({ names: obj.names || {}, s: part });
        await tick();
      }
      const base = db.series('^JKSE') || { date: new Int32Array(0), C: new Float64Array(0) };

      // b. RRG & return harian tiap indeks sektor
      const secRRG = new Map();
      const secRet = new Map();
      for (const sec of SECTORS) {
        const ss = db.series(sec);
        if (!ss || ss.C.length < 40) continue;
        const rr = o.engine.rrgOf(ss, base);
        const m = new Map(), r = new Map();
        for (let i = 0; i < ss.C.length; i++) {
          m.set(ss.date[i], [rr.rsr[i], rr.rsm[i]]);
          if (i > 0) r.set(ss.date[i], ss.C[i] / ss.C[i - 1] - 1);
        }
        secRRG.set(sec, m);
        secRet.set(sec, r);
      }

      // c. hitung trade per saham
      const syms = db.symbols().filter((sym) => !always.has(sym) && !o.exclude.has(sym) && o.isStock(sym, db));
      for (let k = 0; k < syms.length; k++) {
        const sym = syms[k];
        if (k % 10 === 0) { o.progress((g + 0.5 + (k / syms.length) * 0.5) / groups, `Kelompok ${g + 1}/${groups} · ${sym}`); await tick(); }
        const s = db.series(sym);
        if (!s || !s.C.length) continue;
        if (!(firstDates[sym] <= s.date[0])) firstDates[sym] = s.date[0];
        if (s.C.length < (o.engine.minBars || 80)) continue;
        const f = o.engine.features(s, { base });
        const n = s.C.length;

        // breadth: kumpulkan hitungan per tanggal
        const ma50 = AFL.MA(s.C, 50), ma200 = AFL.MA(s.C, 200);
        for (let i = 0; i < n; i++) {
          if (s.date[i] < from || s.date[i] > to || !Number.isFinite(ma50[i])) continue;
          let b = breadth.get(s.date[i]);
          if (!b) { b = [0, 0, 0, 0, 0]; breadth.set(s.date[i], b); }
          b[0]++;
          if (s.C[i] > ma50[i]) b[1]++;
          if (Number.isFinite(ma200[i])) { b[4]++; if (s.C[i] > ma200[i]) b[2]++; }
          if (f.values.inReport[i]) b[3]++;
        }

        for (let i = 0; i < n; i++) {
          if (!f.buy[i] || s.date[i] < from || s.date[i] > to) continue;
          let j = i + 1;
          while (j < n && !f.sell[j]) j++;
          const open = j >= n;
          if (open) j = n - 1;
          const bp = s.C[i], sp = s.C[j];
          let hi = bp, adds = 0;
          const path = { d: [], c: [], h: [], l: [], b: [] };
          for (let k2 = i; k2 <= j; k2++) {
            if (k2 > i && s.H[k2] > hi) hi = s.H[k2];
            if (k2 > i && f.buyRaw[k2]) { adds++; path.b.push(k2 - i); }
            path.d.push(s.date[k2]); path.c.push(r2(s.C[k2])); path.h.push(r2(s.H[k2])); path.l.push(r2(s.L[k2]));
          }
          const cost = bp * (1 + fb);
          const feats = o.engine.featureList.map((x) => (x.type === 'num' ? round(f.values[x.key][i]) : f.values[x.key][i]));
          // kolom tambahan
          let sec = o.sectorMap ? o.sectorMap.get(sym) || null : null;
          if (!sec) { sec = guessSector(s, i, secRet); if (sec) guessed++; }
          const sr = sec && secRRG.get(sec) ? secRRG.get(sec).get(s.date[i]) : null;
          const ex = new Array(EXTRA.length).fill(null);
          ex[0] = round((dayNum(s.date[i]) - dayNum(firstDates[sym])) / 365.25);
          ex[1] = sec ? sec.replace(/^IDX/, '') : '-';
          if (sr && Number.isFinite(sr[0]) && Number.isFinite(sr[1])) {
            ex[2] = round(sr[0]); ex[3] = round(sr[1]);
            ex[4] = sr[0] > 100 ? (sr[1] > 100 ? 'Leading' : 'Weakening') : (sr[1] > 100 ? 'Improving' : 'Lagging');
          } else ex[4] = '-';
          trades.push({
            s: sym, bd: s.date[i], bp: r2(bp), sd: s.date[j], sp: r2(sp), n: j - i, o: open ? 1 : 0, b: adds,
            g: round(((sp * (1 - fs) - cost) / cost) * 100),
            m: round((hi / bp - 1) * 100),
            f: [...feats, ...ex],
            _p: path,
          });
        }
        symbolsDone++;
      }
      db = null; // buang riwayat kelompok ini dari memori
      await tick();
    }

    // d. breadth diisi setelah semua kelompok selesai (butuh hitungan semua saham)
    for (const t of trades) {
      const b = breadth.get(t.bd);
      if (!b) continue;
      t.f[extraIdx.breadth50] = round((b[1] / b[0]) * 100);
      t.f[extraIdx.breadth200] = b[4] ? round((b[2] / b[4]) * 100) : null;
      t.f[extraIdx.breadthRep] = round((b[3] / b[0]) * 100);
    }

    trades.sort((a, b) => a.bd - b.bd || a.s.localeCompare(b.s));
    const paths = trades.map((t) => { const p = t._p; delete t._p; return p; });
    o.progress(1, 'Selesai');
    return {
      result: {
        v: 2, created: new Date().toISOString(), params, featureList: meta, trades, symbols: symbolsDone,
        sectorSource: o.sectorMap && o.sectorMap.size ? 'file' : 'korelasi', sectorGuessed: guessed,
      },
      paths: { v: 1, created: new Date().toISOString(), paths },
      firstDates,
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
   * @param res hasil collect().result
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
        const vals = study.map((t) => t.f[k]).filter((v) => v !== null && v !== undefined);
        const sorted = [...vals].sort((a, b) => a - b);
        const cuts = [quantile(sorted, 0.25), quantile(sorted, 0.5), quantile(sorted, 0.75)];
        const bin = (v) => (v === null || v === undefined ? -1 : v <= cuts[0] ? 0 : v <= cuts[1] ? 1 : v <= cuts[2] ? 2 : 3);
        const bins = (arr) => [0, 1, 2, 3].map((b) => rate(arr.filter((t) => bin(t.f[k]) === b)));
        const okv = (arr) => arr.map((t) => t.f[k]).filter((v) => v !== null && v !== undefined);
        return {
          ...m, medWin: median(okv(study.filter(win))), medAll: median(vals), medLose: median(okv(study.filter((t) => !win(t)))),
          cuts, study: bins(study), test: split ? bins(test) : null,
        };
      }
      const cats = [...new Set(study.map((t) => t.f[k]))].filter((c) => c !== '' && c !== null && c !== undefined).sort();
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

    for (const r of rows) {
      const arr = r.type === 'num' ? r.study : r.cats.filter((c) => c.n >= 20).map((c) => c.rate);
      const v = arr.filter(Number.isFinite);
      r.spread = v.length > 1 ? Math.max(...v) - Math.min(...v) : 0;
    }
    rows.sort((a, b) => b.spread - a.spread);
    return { summary, rows, win };
  }

  const d2s = (x) => `${x % 100}/${Math.floor(x / 100) % 100}/${Math.floor(x / 10000)}`;
  const cell = (v) => (v === null || v === undefined ? '' : typeof v === 'number' ? String(v).replace('.', ',') : `"${String(v).replace(/"/g, '""')}"`);

  /** Daftar trade → teks CSV (pemisah titik koma, cocok untuk Excel Indonesia). */
  function toCSV(res, win) {
    const head = ['No', 'Saham', 'Tgl Buy', 'Harga Buy', 'Tgl Sell', 'Harga Sell', 'Bar', 'Masih terbuka', 'Buy selama dipegang', 'Gain akhir %', 'Gain maks %', 'Pemenang',
      ...res.featureList.map((m) => m.label)];
    const lines = res.trades.map((t, k) => [k + 1, t.s, d2s(t.bd), t.bp, d2s(t.sd), t.sp, t.n, t.o ? 'ya' : '', t.b ?? '', t.g, t.m, win(t) ? 'ya' : '', ...t.f].map(cell).join(';'));
    return '﻿' + [head.map(cell).join(';'), ...lines].join('\r\n');
  }

  /** Jejak harian semua trade → CSV format panjang (satu baris per hari per trade). */
  function pathsToCSV(res, paths) {
    const head = ['No', 'Saham', 'Tgl Buy', 'Harga Buy', 'Hari ke', 'Tanggal', 'Close', 'High', 'Low', 'Sinyal Buy', 'Close vs Buy %', 'High vs Buy %', 'Low vs Buy %'];
    const out = [head.map(cell).join(';')];
    res.trades.forEach((t, k) => {
      const p = paths.paths[k];
      if (!p) return;
      const buys = new Set(p.b);
      for (let i = 0; i < p.d.length; i++) {
        const pc = (x) => Math.round((x / t.bp - 1) * 10000) / 100;
        out.push([k + 1, t.s, d2s(t.bd), t.bp, i, d2s(p.d[i]), p.c[i], p.h[i], p.l[i], buys.has(i) ? 'Buy' : '', pc(p.c[i]), pc(p.h[i]), pc(p.l[i])].map(cell).join(';'));
      }
    });
    return '﻿' + out.join('\r\n');
  }

  const Study = { collect, analyze, toCSV, pathsToCSV, buildFirstDates, parseSectorMap, median, SECTORS, EXTRA };
  global.Study = Study;
  if (typeof module !== 'undefined' && module.exports) module.exports = Study;
})(typeof window !== 'undefined' ? window : globalThis);
