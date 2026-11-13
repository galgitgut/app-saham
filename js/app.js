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
    archDB: new Data.PriceDB(), // potongan arsip per saham (hanya yang pernah dibuka)
    archDone: new Set(),
    archiveMode: false,
    abDB: null,
    book: null, // keputusan portofolio (portfolio/buku.json di repo data)
    bookDirty: 0,
    histFilter: 'trade',
    porto: null,
  };
  const BOOK_PATH = 'portfolio/buku.json';
  const emptyBook = () => ({ v: 1, cfg: { ...Portfolio.DEFAULT_CFG }, decisions: {}, manual: [] });

  // ------------------------------------------------------------------ util tampilan

  // ---- Layar tunggu (pop-up dengan bar persentase), pesan singkat, dan dialog error
  const Busy = {
    active: false,
    start(title) {
      this.active = true;
      $('busy-title').textContent = title;
      this.set(0, '');
      $('busy').hidden = false;
    },
    set(frac, msg) {
      if (frac !== null && frac !== undefined) {
        const p = Math.max(0, Math.min(100, Math.round(frac * 100)));
        $('busy-fill').style.width = `${p}%`;
        $('busy-pct').textContent = `${p}%`;
      }
      if (msg !== undefined) $('busy-msg').textContent = msg;
    },
    end() {
      this.active = false;
      $('busy').hidden = true;
    },
  };

  let toastTimer = null;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  function showError(msg) {
    $('dlg-msg').textContent = msg;
    $('dlg').hidden = false;
  }

  /** Pesan: saat menunggu → teks di pop-up; error → dialog; selain itu → pesan singkat. */
  function status(msg, isErr = false) {
    $('status').textContent = msg; // catatan tersembunyi (untuk pengujian)
    if (isErr) { Busy.end(); showError(msg); return; }
    if (Busy.active) Busy.set(undefined, msg);
    else toast(msg);
  }

  function log(el, msg, append = true) {
    el.textContent = append && el.textContent ? `${el.textContent}\n${msg}` : msg;
    el.scrollTop = el.scrollHeight;
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));
  const ymd = (d) => Math.floor(d / 10000);
  const toInputDate = (d) => `${ymd(d)}-${String(Math.floor(d / 100) % 100).padStart(2, '0')}-${String(d % 100).padStart(2, '0')}`;
  const fromInputDate = (s) => Number(s.replace(/-/g, ''));

  function switchTab(name, sym) {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
    if (name === 'chart' && (sym || state.chartSym)) showChart(sym || state.chartSym);
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
    Busy.start('Memuat data');
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
    const bookText = await state.gh.getText(BOOK_PATH);
    state.book = bookText ? JSON.parse(bookText) : emptyBook();
    state.book.cfg = { ...Portfolio.DEFAULT_CFG, ...state.book.cfg };
    state.bookDirty = 0;

    // data: file harian dulu (untuk tahu tahun mana yang tersentuh), lalu file tahun, lalu terapkan file harian
    state.db = new Data.PriceDB();
    state.loadedYears = new Set();
    state.archDB = new Data.PriceDB();
    state.archDone = new Set();
    state.files.tahun = (await state.gh.list(REPO_DIRS.tahun)).filter((f) => /^\d{4}\.json\.gz$/.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
    state.files.delta = (await state.gh.list(REPO_DIRS.delta)).filter((f) => f.name.endsWith('.json.gz')).sort((a, b) => a.name.localeCompare(b.name));

    const deltas = [];
    state.deltaYears = new Set();
    let step = 0;
    const steps = state.files.delta.length + 3;
    for (const f of state.files.delta) {
      Busy.set(0.1 + (0.2 * ++step) / steps);
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
      Busy.set(0.3 + (0.55 * ++step) / (steps + want.size));
      status(`Mengunduh data ${y}…`);
      state.db.loadYear(await Data.gunzipJSON(await state.gh.getBytes(f.path, f.sha)));
      state.loadedYears.add(y);
      await tick();
    }
    for (const d of deltas) state.db.applyDelta(d);
    state.db.applyCorrections(state.koreksi);
    state.activeFrom = (maxYear - 1) * 10000;

    await state.gh.pruneCache([...state.files.tahun, ...state.files.delta, ...(await state.gh.list(REPO_DIRS.engine))]);
    Busy.set(0.9, 'Menghitung sinyal semua saham…');
    await tick();
    afterDataChange();
    Busy.set(1);
    Busy.end();
    status(`Siap · ${state.db.symbols().length} simbol · data s.d. ${Screening.fmtDate(lastIdxDate())}`);
    if (!state.files.tahun.length) status('Database kosong. Buka tab Data → Konversi database AmiBroker.');
  }

  /**
   * Arsip untuk chart jangka panjang.
   * File tahun lama berisi SEMUA saham, jadi tidak dimuat utuh (bisa ±1 GB memori untuk 30 tahun).
   * Setiap file dibuka satu per satu, hanya saham yang diminta (dan ^JKSE untuk RRG) yang diambil,
   * lalu sisanya dibuang. File yang sudah diunduh tersimpan di perangkat, jadi unduhan hanya sekali.
   */
  async function loadArchiveFor(sym) {
    const want = [sym, '^JKSE'].filter((x) => !state.archDone.has(x));
    if (!want.length) return true;
    const older = state.files.tahun.filter((f) => Number(f.name.slice(0, 4)) * 10000 < state.activeFrom);
    if (!older.length) return true;
    let missing = 0;
    for (const f of older) if (!(await state.gh.isCached(f.path, f.sha))) missing += f.size;
    if (missing > 0 && !confirm(`Arsip perlu diunduh sekali (±${Math.round(missing / 1048576)} MB) dan disimpan di perangkat ini. Lanjut?`)) return false;
    let k = 0;
    Busy.start(`Memuat arsip ${sym}`);
    for (const f of [...older].reverse()) {
      k++;
      Busy.set(k / older.length);
      status(`Membaca arsip ${f.name.slice(0, 4)} (${k}/${older.length})…`);
      const obj = await Data.gunzipJSON(await state.gh.getBytes(f.path, f.sha));
      const s = {};
      for (const x of want) if (obj.s[x]) s[x] = obj.s[x];
      state.archDB.loadYear({ names: {}, s });
      await tick();
    }
    state.archDB.applyCorrections(state.koreksi);
    want.forEach((x) => state.archDone.add(x));
    Busy.end();
    status(`Arsip ${sym} dimuat.`);
    return true;
  }

  /** Seri harga: arsip (kalau diminta) + data aktif. */
  function chartSeries(sym, withArchive) {
    const act = state.db.series(sym, state.activeFrom);
    if (!withArchive) return act;
    const old = state.archDB.series(sym, 0, state.activeFrom - 1);
    if (!old || !old.date.length) return act;
    const cat = (a, b, T) => { const o = new T(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
    const out = {};
    for (const k of Object.keys(act)) out[k] = cat(old[k], act[k], act[k].constructor);
    return out;
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
    refreshPortfolio();
  }

  // ------------------------------------------------------------------ portofolio

  function screenCtx() {
    return { db: state.db, engines: state.engines, base: baseSeries(state.activeFrom), exclude: state.exclude, cache: state.cache, fromDate: state.activeFrom };
  }

  function refreshPortfolio() {
    if (!state.book || !state.engines.binarsaujana) return;
    const last = lastIdxDate();
    if (!last) return;
    const cfg = state.book.cfg;
    if (!cfg.modal.length) {
      $('po-summary').innerHTML = '<div class="card alert-info">Isi <b>Modal total</b> di bagian "Pengaturan portofolio" di bawah, lalu tekan Terapkan.</div>';
      openSettings();
      document.querySelector('#tab-porto details:last-of-type').open = true;
    }
    const ctx = screenCtx();
    const sig = new Map();
    const universe = new Set();
    const addSig = (sym) => {
      const res = Screening.compute(ctx, 'binarsaujana', sym);
      if (res) sig.set(sym, { date: res.s.date, C: res.s.C, P: res.s.P, buyRaw: res.r.buyRaw, buyFirst: res.r.buy, sellRaw: res.r.sellRaw, power: res.r.positionScore });
      return !!res;
    };
    for (const sym of state.db.symbols()) {
      if (state.exclude.has(sym) || !Data.isIdxStock(state.db, sym)) continue;
      if (addSig(sym)) universe.add(sym);
    }
    for (const m of state.book.manual) if (!sig.has(m.sym) && state.db.get(m.sym)) addSig(m.sym);
    const run = { ...cfg, decideFrom: cfg.decideFrom || last }; // tahun berjalan selalu mulai 1 Jan
    state.porto = Portfolio.simulateYear({ sig, universe, cfg: run, book: state.book, lastDate: last });
    PortfolioUI.render(state.porto, { decision: (k) => state.book.decisions[k], histFilter: state.histFilter });
    if (!$('mn-date').value) $('mn-date').value = toInputDate(last);
    renderManualList();
    renderSaveBar();
  }

  function markDirty() {
    state.bookDirty++;
    refreshPortfolio();
  }

  function renderSaveBar() {
    $('po-save-bar').hidden = !state.bookDirty;
    $('po-dirty').textContent = `${state.bookDirty} perubahan belum disimpan`;
  }

  async function saveBook() {
    $('po-save').disabled = true;
    Busy.start('Menyimpan keputusan');
    try {
      await state.gh.commit([{ path: BOOK_PATH, text: JSON.stringify(state.book, null, 1) }], 'Keputusan portofolio', (m, f) => Busy.set(f, m));
      state.bookDirty = 0;
      renderSaveBar();
      Busy.end();
      status('Keputusan portofolio tersimpan.');
    } catch (e) {
      status(`Gagal menyimpan: ${e.message}`, true);
    }
    $('po-save').disabled = false;
  }

  function openSettings() {
    const c = state.book.cfg;
    const last = lastIdxDate();
    const cur = c.modal.length ? [...c.modal].sort((a, b) => a.d - b.d).at(-1) : null;
    $('pc-modal').value = cur ? cur.value : '';
    $('pc-modal-date').value = toInputDate(cur ? Math.max(cur.d, Math.floor(last / 10000) * 10000 + 101) : Math.floor(last / 10000) * 10000 + 101);
    $('pc-slots').value = c.slots;
    $('pc-first').value = c.firstPct;
    $('pc-add').value = c.addPct;
    $('pc-feebuy').value = c.feeBuy;
    $('pc-feesell').value = c.feeSell;
    $('pc-decide').value = toInputDate(c.decideFrom || last);
    $('pc-entry').value = c.entryMode;
    $('pc-carry').checked = c.carry;
    $('pc-modal-list').textContent = c.modal.length
      ? 'Riwayat modal:\n' + [...c.modal].sort((a, b) => a.d - b.d).map((m) => `  mulai ${Screening.fmtDate(m.d)}: Rp ${Math.round(m.value).toLocaleString('id-ID')}`).join('\n')
      : '';
  }

  function applySettings() {
    const c = state.book.cfg;
    const modal = Number($('pc-modal').value);
    const md = fromInputDate($('pc-modal-date').value);
    if (modal > 0 && md) {
      c.modal = c.modal.filter((m) => m.d !== md);
      const cur = [...c.modal].sort((a, b) => a.d - b.d).filter((m) => m.d <= md).at(-1);
      if (!cur || cur.value !== modal) c.modal.push({ d: md, value: modal });
    }
    c.slots = Math.max(1, Number($('pc-slots').value) || 9);
    c.firstPct = Number($('pc-first').value) || 60;
    c.addPct = Number($('pc-add').value) || 20;
    c.feeBuy = Number($('pc-feebuy').value);
    c.feeSell = Number($('pc-feesell').value);
    c.decideFrom = fromInputDate($('pc-decide').value) || 0;
    c.entryMode = $('pc-entry').value;
    c.carry = $('pc-carry').checked;
    openSettings();
    markDirty();
  }

  function renderManualList() {
    const list = state.book.manual;
    $('mn-list').innerHTML = list.length
      ? list.map((m) => `<div class="edit-row">${Screening.fmtDate(m.d)} · ${m.kind === 'sell' ? 'JUAL' : 'BELI'} ${m.sym} ${m.lots || 'semua'} lot @ ${m.price} <button class="small no" data-mdel="${m.id}">Hapus</button></div>`).join('')
      : 'Belum ada input manual.';
  }

  function addManual() {
    const sym = $('mn-sym').value.trim().toUpperCase();
    const d = fromInputDate($('mn-date').value);
    const price = Number($('mn-price').value);
    const lots = Number($('mn-lots').value) || 0;
    const kind = $('mn-kind').value;
    if (!state.db.get(sym)) { status(`Simbol ${sym} tidak ada di database.`, true); return; }
    if (!d || !(price > 0) || (kind === 'buy' && !(lots > 0))) { status('Lengkapi tanggal, harga, dan lot.', true); return; }
    state.book.manual.push({ id: Date.now(), sym, d, kind, price, lots });
    $('mn-sym').value = ''; $('mn-price').value = ''; $('mn-lots').value = '';
    markDirty();
  }

  function onPortoClick(e) {
    const t = e.target;
    const chart = t.closest('[data-chart]');
    if (chart) { e.preventDefault(); switchTab('chart', chart.dataset.chart); return; }
    const D = state.book.decisions;
    if (t.dataset.approve) {
      const key = t.dataset.approve;
      const inp = document.querySelector(`[data-lots="${key}"]`);
      D[key] = { act: 'approve', lots: Math.max(0, Math.floor(Number(inp && inp.value) || 0)) };
      markDirty();
    } else if (t.dataset.skip) {
      D[t.dataset.skip] = { act: 'skip' };
      markDirty();
    } else if (t.dataset.undo) {
      delete D[t.dataset.undo];
      markDirty();
    } else if (t.dataset.edit) {
      const row = document.querySelector(`[data-editor="${t.dataset.edit}"]`);
      if (row) row.hidden = !row.hidden;
    } else if (t.dataset.esave) {
      const key = t.dataset.esave;
      const lots = Math.max(0, Math.floor(Number(document.querySelector(`[data-elots="${CSS.escape(key)}"]`).value) || 0));
      const price = Number(document.querySelector(`[data-eprice="${CSS.escape(key)}"]`).value);
      if (key.startsWith('manual:')) {
        const m = state.book.manual.find((x) => String(x.id) === key.slice(7));
        if (m) { m.lots = lots; if (price > 0) m.price = price; }
      } else {
        D[key] = { act: 'approve', lots, ...(price > 0 ? { price } : {}) };
      }
      markDirty();
    } else if (t.dataset.mdel) {
      state.book.manual = state.book.manual.filter((x) => String(x.id) !== t.dataset.mdel);
      markDirty();
    } else if (t.closest('#po-hist-filter button')) {
      const b = t.closest('button');
      state.histFilter = b.dataset.f;
      document.querySelectorAll('#po-hist-filter button').forEach((x) => x.classList.toggle('on', x === b));
      PortfolioUI.renderHistory(state.porto, state.histFilter);
    }
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
    const res = Screening.run(screenCtx(), key, date);
    Screening.render($('scr-table'), state.engines[key], res, (sym) => switchTab('chart', sym));
    $('scr-info').textContent = `${res.rows.length} lolos dari ${res.universe} saham · ${Math.round(performance.now() - t0)} ms`;
  }

  // ------------------------------------------------------------------ chart

  function setRange(r) {
    state.chartBars = r;
    state.archiveMode = r === -1;
    document.querySelectorAll('#ch-range button').forEach((x) => x.classList.toggle('on', Number(x.dataset.r) === r));
  }

  async function showChart(sym) {
    sym = sym.trim().toUpperCase();
    // pindah saham → kembali ke 1Y agar arsip saham lain tidak otomatis diunduh
    if (sym !== state.chartSym && state.archiveMode) setRange(252);
    if (!state.db.get(sym)) { status(`Simbol ${sym} tidak ada di database.`, true); return; }
    state.chartSym = sym;
    $('ch-sym').value = sym;
    if (!state.chart) {
      state.chart = new ChartView({ price: $('ch-price'), nbsa: $('ch-nbsa'), nbsaInfo: $('ch-nbsa-info'), title: $('ch-title'), rrg: $('ch-rrg'), rrgInfo: $('rrg-info'), legend: $('ch-legend'), ribbon: $('ch-ribbon'), bsInfo: $('ch-bs-info') });
    }
    if (state.archiveMode && !(await loadArchiveFor(sym))) setRange(252);
    const s = chartSeries(sym, state.archiveMode);
    const base = chartSeries('^JKSE', state.archiveMode) || { date: new Int32Array(0), C: new Float64Array(0) };
    const E = state.engines;
    const bs = E.binarsaujana && E.binarsaujana.chart && s.C.length >= E.binarsaujana.minBars ? E.binarsaujana.chart(s, { base }) : null;
    const nbsa = E.nbsa ? E.nbsa.run(s) : null;
    const rrg = E.rrg ? { ...E.rrg.run(s, { base }), param: E.rrg.param } : null;
    state.chart.show({ sym, name: state.db.names[sym], s, bs, nbsa, rrg, bars: state.archiveMode ? 0 : state.chartBars });
  }

  // ------------------------------------------------------------------ import CSV

  async function onCsvFiles(files) {
    const out = $('csv-result');
    out.textContent = '';
    Busy.start('Import CSV');
    let k = 0;
    for (const file of files) {
      Busy.set(k++ / files.length, file.name);
      await tick();
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
    Busy.set(0.95, 'Menghitung ulang sinyal…');
    await tick();
    afterDataChange();
    Busy.end();
    if (state.pending.length) log(out, 'Data sudah bisa dipakai untuk screening. Tekan "Simpan ke GitHub" agar tersimpan permanen.');
  }

  async function savePending() {
    if (!state.pending.length) return;
    const btn = $('csv-save');
    btn.disabled = true;
    Busy.start('Menyimpan import ke GitHub');
    try {
      const now = new Date();
      const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const bytes = await Data.gzipJSON({ v: 1, created: now.toISOString(), rows: state.pending });
      await state.gh.commit([{ path: `${REPO_DIRS.delta}/${stamp}.json.gz`, bytes }], `Import data ${stamp}`, (m, f) => Busy.set(f, m));
      state.pending = [];
      state.files.delta = (await state.gh.list(REPO_DIRS.delta)).filter((f) => f.name.endsWith('.json.gz'));
      log($('csv-result'), 'Tersimpan di GitHub.');
      Busy.end();
      toast('Import tersimpan di GitHub.');
    } catch (e) {
      status(`Gagal menyimpan: ${e.message}`, true);
    }
    renderDbInfo();
  }

  async function consolidate() {
    if (state.pending.length) { status('Simpan dulu import yang tertunda.', true); return; }
    if (!state.files.delta.length) { status('Tidak ada file harian untuk digabung.'); return; }
    if (!confirm(`Gabungkan ${state.files.delta.length} file harian ke file tahun ${[...state.deltaYears].sort().join(', ')}?`)) return;
    Busy.start('Konsolidasi');
    try {
      const files = [];
      for (const y of [...state.deltaYears].sort()) {
        status(`Menyiapkan ${y}.json.gz…`);
        files.push({ path: `${REPO_DIRS.tahun}/${y}.json.gz`, bytes: await Data.gzipJSON(state.db.toYear(y)) });
      }
      for (const f of state.files.delta) files.push({ path: f.path, delete: true });
      await state.gh.commit(files, `Konsolidasi ${state.files.delta.length} file harian`, (m, f) => Busy.set(f, m));
      await connect();
    } catch (e) {
      status(`Konsolidasi gagal: ${e.message}`, true);
    }
  }

  // ------------------------------------------------------------------ konversi AmiBroker

  async function onAmiBrokerFolder(fileList) {
    const out = $('ab-result');
    out.textContent = '';
    Busy.start('Membaca database AmiBroker');
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
      if (k % 25 === 0) { Busy.set(k / files.length, `File ${k + 1} dari ${files.length}`); await tick(); }
    }
    db.applyCorrections(state.koreksi);
    // import harian yang sudah ada (lebih baru) diterapkan di atas data AmiBroker agar tidak hilang
    for (const f of state.files.delta) db.applyDelta(await Data.gunzipJSON(await state.gh.getBytes(f.path, f.sha)));
    state.abDB = db;
    Busy.end();
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
    Busy.start('Mengunggah hasil konversi');
    try {
      const files = [];
      const ys = db.years();
      for (const y of ys) {
        Busy.set((0.3 * files.length) / ys.length, `Mengemas ${y}…`);
        files.push({ path: `${REPO_DIRS.tahun}/${y}.json.gz`, bytes: await Data.gzipJSON(db.toYear(y)) });
        await tick();
      }
      for (const f of state.files.delta) files.push({ path: f.path, delete: true });
      await state.gh.commit(files, 'Konversi database AmiBroker', (m, f) => Busy.set(0.3 + 0.7 * f, m));
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
    setRange(Number(b.dataset.r));
    if (state.chartSym) showChart(state.chartSym);
  });
  $('csv-file').addEventListener('change', (e) => { const files = [...e.target.files]; e.target.value = ''; onCsvFiles(files); });
  $('csv-save').addEventListener('click', savePending);
  $('btn-consolidate').addEventListener('click', consolidate);
  $('btn-clear-archive').addEventListener('click', async () => {
    const older = state.files.tahun.filter((f) => Number(f.name.slice(0, 4)) * 10000 < state.activeFrom);
    await state.gh.uncache(older);
    state.archDB = new Data.PriceDB();
    state.archDone = new Set();
    if (state.archiveMode) setRange(252);
    status(`Arsip (${older.length} file tahun) dihapus dari perangkat ini.`);
  });
  $('ab-folder').addEventListener('change', (e) => onAmiBrokerFolder([...e.target.files]));
  $('ab-save').addEventListener('click', saveAmiBroker);
  $('set-save').addEventListener('click', saveCfg);
  $('dlg-ok').addEventListener('click', () => { $('dlg').hidden = true; });
  $('set-forget').addEventListener('click', () => {
    localStorage.removeItem('app-saham-cfg');
    $('set-token').value = '';
    log($('set-result'), 'Token dihapus dari perangkat ini.', false);
  });
  $('tab-porto').addEventListener('click', onPortoClick);
  $('po-save').addEventListener('click', saveBook);
  $('pc-apply').addEventListener('click', applySettings);
  $('mn-add').addEventListener('click', addManual);
  document.querySelector('#tab-porto details:last-of-type').addEventListener('toggle', (e) => { if (e.target.open) openSettings(); });
  window.addEventListener('beforeunload', (e) => {
    if (state.pending.length || state.bookDirty) { e.preventDefault(); e.returnValue = ''; }
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  state.cfg = loadCfg();
  if (state.cfg) {
    $('set-owner').value = state.cfg.owner;
    $('set-repo').value = state.cfg.repo;
    $('set-token').value = state.cfg.token;
    start();
  } else {
    toast('Isi Pengaturan dulu.');
    switchTab('setting');
  }
})();
