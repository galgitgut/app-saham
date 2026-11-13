/*
 * app.js — pengatur utama: koneksi GitHub, memuat data & formula, tab Screening/Chart/Data/Pengaturan.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const REPO_DIRS = { tahun: 'data/tahun', delta: 'data/delta', engine: 'engine' };

  const state = {
    cfg: null,
    gh: null,
    db: new Data.PriceDB(),
    engines: {},
    exclude: new Set(),
    koreksi: [],
    files: { tahun: [], delta: [] },
    loadedYears: new Set(),
    deltaYears: new Set(),
    activeFrom: 0,
    pending: [], // baris hasil import yang belum disimpan ke GitHub
    cache: new Map(), // hasil formula per simbol
    chart: null,
    chartSym: null,
    chartBars: 252,
    archiveLoaded: false,
    abDB: null,
  };

  // ------------------------------------------------------------------ util tampilan

  function status(msg, isErr = false) {
    const el = $('status');
    el.textContent = msg;
    el.classList.toggle('err', isErr);
  }

  function log(el, msg, append = true) {
    el.textContent = append && el.textContent ? `${el.textContent}\n${msg}` : msg;
    el.scrollTop = el.scrollHeight;
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));
  const ymd = (d) => Math.floor(d / 10000);
  const toInputDate = (d) => `${ymd(d)}-${String(Math.floor(d / 100) % 100).padStart(2, '0')}-${String(d % 100).padStart(2, '0')}`;
  const fromInputDate = (s) => Number(s.replace(/-/g, ''));

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
    if (name === 'chart' && state.chartSym) showChart(state.chartSym);
  }

  // ------------------------------------------------------------------ memuat data

  function loadEngine(name, code) {
    // Formula dari repo privat dijalankan dengan pustaka AFL sebagai bahan
    // eslint-disable-next-line no-new-func
    return new Function('AFL', code)(AFL);
  }

  async function connect() {
    const { owner, repo, token } = state.cfg;
    state.gh = new GitHub({ owner, repo, token });
    status('Menyambung ke GitHub…');
    await state.gh.check();

    // formula
    state.engines = {};
    for (const f of await state.gh.list(REPO_DIRS.engine)) {
      if (!f.name.endsWith('.js')) continue;
      try {
        state.engines[f.name.replace(/\.js$/, '')] = loadEngine(f.name, await state.gh.getText(f.path));
      } catch (e) {
        console.error(e);
        status(`Formula ${f.name} error: ${e.message}`, true);
      }
    }

    // konfigurasi
    state.exclude = Data.parseList((await state.gh.getText('config/exclude.txt')) || '');
    state.koreksi = JSON.parse((await state.gh.getText('config/koreksi.json')) || '[]');

    // data: file harian dulu (untuk tahu tahun mana yang tersentuh), lalu file tahun, lalu terapkan file harian
    state.db = new Data.PriceDB();
    state.loadedYears = new Set();
    state.archiveLoaded = false;
    state.files.tahun = (await state.gh.list(REPO_DIRS.tahun)).filter((f) => /^\d{4}\.json\.gz$/.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
    state.files.delta = (await state.gh.list(REPO_DIRS.delta)).filter((f) => f.name.endsWith('.json.gz')).sort((a, b) => a.name.localeCompare(b.name));

    const deltas = [];
    state.deltaYears = new Set();
    for (const f of state.files.delta) {
      status(`Mengunduh ${f.name}…`);
      const obj = await Data.gunzipJSON(await state.gh.getBytes(f.path, f.sha));
      deltas.push(obj);
      for (const r of obj.rows) state.deltaYears.add(ymd(r[1]));
    }

    const allYears = state.files.tahun.map((f) => Number(f.name.slice(0, 4)));
    const maxYear = Math.max(...allYears, ...state.deltaYears, 0);
    const want = new Set([maxYear - 1, maxYear, ...state.deltaYears]);
    for (const f of state.files.tahun) {
      const y = Number(f.name.slice(0, 4));
      if (!want.has(y)) continue;
      status(`Mengunduh data ${y}…`);
      state.db.loadYear(await Data.gunzipJSON(await state.gh.getBytes(f.path, f.sha)));
      state.loadedYears.add(y);
      await tick();
    }
    for (const d of deltas) state.db.applyDelta(d);
    state.db.applyCorrections(state.koreksi);
    state.activeFrom = (maxYear - 1) * 10000;

    await state.gh.pruneCache([...state.files.tahun, ...state.files.delta, ...(await state.gh.list(REPO_DIRS.engine))]);
    afterDataChange();
    status(`Siap · ${state.db.symbols().length} simbol · data s.d. ${Screening.fmtDate(lastIdxDate())}`);
    if (!state.files.tahun.length) status('Database kosong. Buka tab Data → Konversi database AmiBroker.');
  }

  /** Muat tahun-tahun arsip (untuk chart jangka panjang). */
  async function loadArchive() {
    if (state.archiveLoaded) return;
    const older = state.files.tahun.filter((f) => !state.loadedYears.has(Number(f.name.slice(0, 4)))).reverse();
    for (const f of older) {
      status(`Mengunduh arsip ${f.name.slice(0, 4)}…`);
      state.db.loadYear(await Data.gunzipJSON(await state.gh.getBytes(f.path, f.sha)));
      state.loadedYears.add(Number(f.name.slice(0, 4)));
      await tick();
    }
    state.db.applyCorrections(state.koreksi);
    state.archiveLoaded = true;
    status('Arsip dimuat.');
  }

  function lastIdxDate() {
    let m = 0;
    for (const sym of state.db.symbols()) {
      const s = state.db.get(sym);
      const d = s.d[s.d.length - 1];
      if (d > m && Data.isIdxStock(state.db, sym)) m = d;
    }
    return m;
  }

  function baseSeries(from) {
    const b = state.db.series('^JKSE', from);
    return b || { date: new Int32Array(0), C: new Float64Array(0) };
  }

  function afterDataChange() {
    state.cache.clear();
    const last = lastIdxDate();
    if (last) $('scr-date').value = toInputDate(last);
    $('sym-list').innerHTML = state.db.symbols().map((s) => `<option value="${s}">`).join('');
    const scr = Object.entries(state.engines).filter(([, e]) => e.columns);
    const cur = $('scr-engine').value;
    $('scr-engine').innerHTML = scr.map(([k, e]) => `<option value="${k}">${e.name}</option>`).join('');
    if (cur && state.engines[cur]) $('scr-engine').value = cur;
    renderDbInfo();
  }

  function renderDbInfo() {
    const years = [...state.loadedYears].sort();
    const lines = [
      `Simbol: ${state.db.symbols().length}`,
      `Tahun dimuat: ${years.join(', ') || '-'}`,
      `File tahun di GitHub: ${state.files.tahun.length} · file harian: ${state.files.delta.length}`,
      `Daftar exclude: ${state.exclude.size} simbol · formula: ${Object.keys(state.engines).join(', ') || '-'}`,
      `Import belum disimpan: ${state.pending.length} baris`,
    ];
    $('db-info').textContent = lines.join('\n');
    $('pending-info').textContent = state.pending.length ? `${state.pending.length} baris menunggu disimpan` : '';
    $('csv-save').disabled = !state.pending.length;
  }

  // ------------------------------------------------------------------ screening

  function runScreening() {
    const key = $('scr-engine').value;
    if (!key) { status('Belum ada formula screening di repo data.', true); return; }
    const date = fromInputDate($('scr-date').value);
    const t0 = performance.now();
    const ctx = { db: state.db, engines: state.engines, base: baseSeries(state.activeFrom), exclude: state.exclude, cache: state.cache, fromDate: state.activeFrom };
    const res = Screening.run(ctx, key, date);
    Screening.render($('scr-table'), state.engines[key], res, (sym) => { state.chartSym = sym; switchTab('chart'); });
    $('scr-info').textContent = `${res.rows.length} lolos dari ${res.universe} saham · ${Math.round(performance.now() - t0)} ms`;
  }

  // ------------------------------------------------------------------ chart

  function showChart(sym) {
    sym = sym.trim().toUpperCase();
    if (!state.db.get(sym)) { status(`Simbol ${sym} tidak ada di database.`, true); return; }
    state.chartSym = sym;
    $('ch-sym').value = sym;
    if (!state.chart) {
      state.chart = new ChartView({ price: $('ch-price'), nbsa: $('ch-nbsa'), nbsaInfo: $('ch-nbsa-info'), title: $('ch-title'), rrg: $('ch-rrg'), rrgInfo: $('rrg-info') });
    }
    const from = state.archiveLoaded ? 0 : state.activeFrom;
    const s = state.db.series(sym, from);
    const base = baseSeries(0);
    const E = state.engines;
    let signals = null;
    if (E.binarsaujana && s.C.length >= E.binarsaujana.minBars) {
      const r = E.binarsaujana.run(s, { base });
      signals = { buy: r.buy, sell: r.sell };
    }
    const nbsa = E.nbsa ? E.nbsa.run(s) : null;
    const rrg = E.rrg ? { ...E.rrg.run(s, { base }), param: E.rrg.param } : null;
    state.chart.show({ sym, name: state.db.names[sym], s, signals, nbsa, rrg, bars: state.chartBars });
  }

  // ------------------------------------------------------------------ import CSV

  async function onCsvFiles(files) {
    const out = $('csv-result');
    out.textContent = '';
    for (const file of files) {
      try {
        const text = await file.text();
        const r = Data.importCSV(state.db, text);
        state.pending.push(...r.deltaRows);
        for (const row of r.deltaRows) state.deltaYears.add(ymd(row[1]));
        const sk = Object.entries(r.skipped).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ');
        log(out, `${file.name} → ${r.format}: ${r.total} baris, ${r.changed} baru/berubah${sk ? ` (dilewati: ${sk})` : ''}`);
      } catch (e) {
        log(out, `${file.name} → GAGAL: ${e.message}`);
      }
    }
    state.db.applyCorrections(state.koreksi);
    afterDataChange();
    if (state.pending.length) log(out, 'Data sudah bisa dipakai untuk screening. Tekan "Simpan ke GitHub" agar tersimpan permanen.');
  }

  async function savePending() {
    if (!state.pending.length) return;
    const btn = $('csv-save');
    btn.disabled = true;
    try {
      const now = new Date();
      const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const bytes = await Data.gzipJSON({ v: 1, created: now.toISOString(), rows: state.pending });
      await state.gh.commit([{ path: `${REPO_DIRS.delta}/${stamp}.json.gz`, bytes }], `Import data ${stamp}`, (m) => status(m));
      state.pending = [];
      state.files.delta = (await state.gh.list(REPO_DIRS.delta)).filter((f) => f.name.endsWith('.json.gz'));
      log($('csv-result'), 'Tersimpan di GitHub.');
    } catch (e) {
      status(`Gagal menyimpan: ${e.message}`, true);
    }
    renderDbInfo();
  }

  async function consolidate() {
    if (state.pending.length) { status('Simpan dulu import yang tertunda.', true); return; }
    if (!state.files.delta.length) { status('Tidak ada file harian untuk digabung.'); return; }
    if (!confirm(`Gabungkan ${state.files.delta.length} file harian ke file tahun ${[...state.deltaYears].sort().join(', ')}?`)) return;
    try {
      const files = [];
      for (const y of [...state.deltaYears].sort()) {
        status(`Menyiapkan ${y}.json.gz…`);
        files.push({ path: `${REPO_DIRS.tahun}/${y}.json.gz`, bytes: await Data.gzipJSON(state.db.toYear(y)) });
      }
      for (const f of state.files.delta) files.push({ path: f.path, delete: true });
      await state.gh.commit(files, `Konsolidasi ${state.files.delta.length} file harian`, (m) => status(m));
      await connect();
    } catch (e) {
      status(`Konsolidasi gagal: ${e.message}`, true);
    }
  }

  // ------------------------------------------------------------------ konversi AmiBroker

  async function onAmiBrokerFolder(fileList) {
    const out = $('ab-result');
    out.textContent = '';
    const files = [...fileList].filter((f) => f.size >= 1184);
    const db = new Data.PriceDB();
    const anomalies = [];
    let ok = 0;
    for (let k = 0; k < files.length; k++) {
      const r = AmiBroker.parseBroker(await files[k].arrayBuffer());
      if (!r) continue;
      ok++;
      db.names[r.sym] = r.name;
      for (const b of r.bars) {
        db.upsert(r.sym, b, 'AB');
        if (!(b.h >= Math.max(b.o, b.c) && b.l <= Math.min(b.o, b.c))) anomalies.push(`${r.sym} ${Screening.fmtDate(b.d)} O${b.o} H${b.h} L${b.l} C${b.c}`);
      }
      if (k % 50 === 0) { log(out, `Membaca ${k + 1}/${files.length}…`, false); await tick(); }
    }
    db.applyCorrections(state.koreksi);
    // import harian yang sudah ada (lebih baru) diterapkan di atas data AmiBroker agar tidak hilang
    for (const f of state.files.delta) db.applyDelta(await Data.gunzipJSON(await state.gh.getBytes(f.path, f.sha)));
    state.abDB = db;
    const ys = db.years();
    log(out, [
      `${ok} simbol terbaca dari ${files.length} file.`,
      `Tahun: ${ys[0]}–${ys[ys.length - 1]} (${ys.length} file tahun akan dibuat).`,
      `Anomali OHLC (tidak diubah, hanya dilaporkan): ${anomalies.length}`,
      ...anomalies.slice(0, 30).map((a) => '  ' + a),
      anomalies.length > 30 ? `  … dan ${anomalies.length - 30} lainnya` : '',
      'Tekan "Unggah hasil konversi". Ini mengganti semua file tahun di GitHub dalam satu commit.',
    ].filter(Boolean).join('\n'), false);
    $('ab-save').disabled = false;
  }

  async function saveAmiBroker() {
    const db = state.abDB;
    if (!db) return;
    if (!confirm('Unggah hasil konversi? Semua file tahun di GitHub akan diganti.')) return;
    $('ab-save').disabled = true;
    try {
      const files = [];
      for (const y of db.years()) {
        status(`Mengemas ${y}…`);
        files.push({ path: `${REPO_DIRS.tahun}/${y}.json.gz`, bytes: await Data.gzipJSON(db.toYear(y)) });
        await tick();
      }
      for (const f of state.files.delta) files.push({ path: f.path, delete: true });
      await state.gh.commit(files, 'Konversi database AmiBroker', (m) => status(m));
      state.abDB = null;
      log($('ab-result'), 'Selesai diunggah.');
      await connect();
    } catch (e) {
      status(`Unggah gagal: ${e.message}`, true);
      $('ab-save').disabled = false;
    }
  }

  // ------------------------------------------------------------------ pengaturan

  function loadCfg() {
    try { return JSON.parse(localStorage.getItem('app-saham-cfg') || 'null'); } catch (_) { return null; }
  }

  async function saveCfg() {
    state.cfg = { owner: $('set-owner').value.trim(), repo: $('set-repo').value.trim() || 'data-saham', token: $('set-token').value.trim() };
    if (!state.cfg.owner || !state.cfg.token) { log($('set-result'), 'Username dan token wajib diisi.', false); return; }
    localStorage.setItem('app-saham-cfg', JSON.stringify(state.cfg));
    await start();
    log($('set-result'), $('status').textContent, false);
  }

  async function start() {
    try {
      await connect();
    } catch (e) {
      console.error(e);
      status(e.message, true);
      log($('set-result'), e.message, false);
    }
  }

  // ------------------------------------------------------------------ pasang event

  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('scr-run').addEventListener('click', runScreening);
  $('ch-go').addEventListener('click', () => showChart($('ch-sym').value));
  $('ch-sym').addEventListener('keydown', (e) => { if (e.key === 'Enter') showChart($('ch-sym').value); });
  $('ch-range').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    document.querySelectorAll('#ch-range button').forEach((x) => x.classList.toggle('on', x === b));
    state.chartBars = Number(b.dataset.r);
    if (state.chartBars === -1) { await loadArchive(); state.chartBars = 0; }
    if (state.chartSym) showChart(state.chartSym);
  });
  $('csv-file').addEventListener('change', (e) => { const files = [...e.target.files]; e.target.value = ''; onCsvFiles(files); });
  $('csv-save').addEventListener('click', savePending);
  $('btn-consolidate').addEventListener('click', consolidate);
  $('ab-folder').addEventListener('change', (e) => onAmiBrokerFolder([...e.target.files]));
  $('ab-save').addEventListener('click', saveAmiBroker);
  $('set-save').addEventListener('click', saveCfg);
  $('set-forget').addEventListener('click', () => {
    localStorage.removeItem('app-saham-cfg');
    $('set-token').value = '';
    log($('set-result'), 'Token dihapus dari perangkat ini.', false);
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.pending.length) { e.preventDefault(); e.returnValue = ''; }
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  state.cfg = loadCfg();
  if (state.cfg) {
    $('set-owner').value = state.cfg.owner;
    $('set-repo').value = state.cfg.repo;
    $('set-token').value = state.cfg.token;
    start();
  } else {
    status('Isi Pengaturan dulu.');
    switchTab('setting');
  }
})();
