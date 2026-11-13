/*
 * portfolio.js — simulasi portofolio sejak awal tahun, mengikuti aturan Galih:
 *
 *  - Pemicu masuk = sinyal Buy (bukan Report).
 *  - Maksimal `slots` saham dari sistem (default 9). Modal per saham = modal ÷ slots.
 *  - Masuk pertama: firstPct% (60%). Setiap sinyal Buy berikutnya selama dipegang: +addPct% (20%), tanpa batas,
 *    selama modal masih ada.
 *  - Sell = sinyal Sell di EOD → jual semua di harga Close.
 *  - Slot kosong diisi kandidat Buy hari itu, urut Power tertinggi. Dilewati → kandidat berikutnya.
 *  - Lot = jumlah lot terbanyak yang (harga × lot × 100 + fee beli) masih ≤ jatah pembelian.
 *  - Saham manual tidak memakai slot (portofolio bisa > 9).
 *
 * Keputusan pengguna (book.decisions) per kunci "yyyymmdd|SIMBOL|NEW" atau "...|ADD":
 *   { act: 'approve' | 'skip', lots?, price? }   lots/price = hasil edit (kalau beli tidak sesuai saran)
 * Tanpa keputusan:
 *   - sebelum cfg.decideFrom  → dianggap dibeli (backtest murni)
 *   - tanggal terakhir        → "menunggu" (tombol Setuju/Lewati)
 *   - di antaranya            → dianggap tidak dibeli
 *
 * File ini tidak berisi rumus AFL; sinyal datang dari formula privat.
 */
(function (global) {
  'use strict';

  const DEFAULT_CFG = { slots: 9, firstPct: 60, addPct: 20, feeBuy: 0.18, feeSell: 0.28, modal: [], start: 0, decideFrom: 0 };

  /** Modal yang berlaku pada tanggal d. */
  function modalAt(cfg, d) {
    let v = 0;
    for (const m of [...cfg.modal].sort((a, b) => a.d - b.d)) if (m.d <= d) v = m.value;
    if (!v && cfg.modal.length) v = [...cfg.modal].sort((a, b) => a.d - b.d)[0].value;
    return v;
  }

  /** Lot terbanyak yang muat di anggaran (termasuk fee beli). */
  function lotsFor(budget, price, feeBuyPct) {
    if (!(budget > 0) || !(price > 0)) return 0;
    return Math.floor(budget / (price * 100 * (1 + feeBuyPct / 100)));
  }

  /**
   * Jalankan simulasi.
   * @param {Object} o
   *   o.sig      Map simbol → {date, C, buyRaw, sellRaw, power, P}
   *   o.universe Set simbol yang boleh dibeli sistem (saham IDX − exclude)
   *   o.cfg      pengaturan (lihat DEFAULT_CFG)
   *   o.book     {decisions:{}, manual:[]}
   *   o.lastDate tanggal terakhir data
   */
  function simulate(o) {
    const cfg = { ...DEFAULT_CFG, ...o.cfg };
    const book = { decisions: {}, manual: [], ...o.book };
    const fb = cfg.feeBuy / 100, fs = cfg.feeSell / 100;
    const lastDate = o.lastDate;

    // indeks tanggal per simbol
    const idx = new Map();
    const days = new Set();
    for (const [sym, s] of o.sig) {
      const m = new Map();
      for (let i = 0; i < s.date.length; i++) {
        m.set(s.date[i], i);
        if (s.date[i] >= cfg.start && s.date[i] <= lastDate && o.universe.has(sym)) days.add(s.date[i]);
      }
      idx.set(sym, m);
    }
    for (const x of book.manual) if (x.d >= cfg.start && x.d <= lastDate) days.add(x.d);
    const dayList = [...days].sort((a, b) => a - b);

    const at = (sym, d) => { const m = idx.get(sym); return m ? m.get(d) : undefined; };
    const close = (sym, d) => { const i = at(sym, d); return i === undefined ? NaN : o.sig.get(sym).C[i]; };

    const pos = new Map(); // simbol → posisi terbuka
    const events = [];
    const pending = []; // keputusan yang ditunggu (tanggal terakhir)
    let candidates = []; // kandidat Buy di tanggal terakhir
    const soldToday = [];
    const tradesClosed = [];

    const invested = () => { let x = 0; for (const p of pos.values()) x += p.cost; return x; };
    const systemCount = () => { let n = 0; for (const p of pos.values()) if (p.source === 'system') n++; return n; };

    function undecidedStatus(d) {
      if (d < cfg.decideFrom) return 'auto';
      if (d === lastDate) return 'pending';
      return 'tidak diputuskan';
    }

    function buy(sym, d, kind, pct, dec, source) {
      const price = dec && dec.price > 0 ? dec.price : close(sym, d);
      const modal = modalAt(cfg, d);
      const perStock = modal / cfg.slots;
      const avail = modal - invested();
      const budget = Math.min(perStock * pct / 100, Math.max(avail, 0));
      const sysLots = lotsFor(budget, price, cfg.feeBuy);
      const edited = dec && dec.act === 'approve' && dec.lots != null;
      const lots = edited ? dec.lots : sysLots;
      const status = dec && dec.act === 'approve' ? (edited && dec.lots !== sysLots ? 'diedit' : 'setuju') : 'auto';
      if (!(lots > 0)) {
        events.push({ d, sym, type: kind, lots: 0, price, status: edited ? 'lewati' : 'modal habis', pct });
        return false;
      }
      const value = lots * 100 * price;
      const fee = value * fb;
      let p = pos.get(sym);
      if (!p) {
        p = { sym, source, lots: 0, cost: 0, porsi: 0, entry: d, buys: 0 };
        pos.set(sym, p);
      }
      p.lots += lots;
      p.cost += value + fee;
      p.porsi += pct;
      p.buys++;
      p.lastAction = d;
      events.push({ d, sym, type: kind, lots, price, value, fee, status, pct, porsi: p.porsi, suggested: sysLots });
      return true;
    }

    function sell(sym, d, price, lots, type, status) {
      const p = pos.get(sym);
      if (!p) return;
      lots = Math.min(lots || p.lots, p.lots);
      const value = lots * 100 * price;
      const fee = value * fs;
      const costPart = p.cost * (lots / p.lots);
      const pl = value - fee - costPart;
      events.push({ d, sym, type, lots, price, value, fee, status, pl, plPct: (pl / costPart) * 100 });
      tradesClosed.push({ sym, entry: p.entry, exit: d, pl, cost: costPart });
      p.cost -= costPart;
      p.lots -= lots;
      if (p.lots <= 0) pos.delete(sym);
      if (d === lastDate) soldToday.push({ sym, price, lots, pl, plPct: (pl / costPart) * 100, type });
    }

    for (const d of dayList) {
      // 1. transaksi manual hari ini
      for (const m of book.manual.filter((x) => x.d === d)) {
        if (m.kind === 'sell') sell(m.sym, d, m.price, m.lots, 'JUAL MANUAL', 'manual');
        else {
          const p = pos.get(m.sym) || { sym: m.sym, source: 'manual', lots: 0, cost: 0, porsi: 0, entry: d, buys: 0 };
          pos.set(m.sym, p);
          const value = m.lots * 100 * m.price;
          p.lots += m.lots; p.cost += value * (1 + fb); p.buys++; p.lastAction = d;
          events.push({ d, sym: m.sym, type: 'BELI MANUAL', lots: m.lots, price: m.price, value, fee: value * fb, status: 'manual', id: m.id });
        }
      }

      // 2. Sell (DSL) untuk semua posisi
      for (const sym of [...pos.keys()]) {
        const i = at(sym, d);
        if (i !== undefined && o.sig.get(sym).sellRaw[i] && pos.get(sym).entry < d) sell(sym, d, o.sig.get(sym).C[i], 0, 'SELL', 'sinyal');
      }

      // 3. Tambah porsi (sinyal Buy lagi pada saham yang sudah dipegang)
      const handled = new Set();
      for (const sym of [...pos.keys()]) {
        const p = pos.get(sym);
        const i = at(sym, d);
        if (i === undefined || !o.sig.get(sym).buyRaw[i] || p.entry >= d) continue;
        const key = `${d}|${sym}|ADD`;
        handled.add(key);
        const dec = book.decisions[key];
        if (dec && dec.act === 'skip') { events.push({ d, sym, type: 'TAMBAH', lots: 0, price: close(sym, d), status: 'lewati', pct: cfg.addPct }); continue; }
        const st = dec ? 'decided' : undecidedStatus(d);
        if (st === 'pending') {
          const modal = modalAt(cfg, d);
          const lots = lotsFor(Math.min(modal / cfg.slots * cfg.addPct / 100, Math.max(modal - invested(), 0)), close(sym, d), cfg.feeBuy);
          pending.push({ key, d, sym, type: 'ADD', price: close(sym, d), lots, porsiNext: p.porsi + cfg.addPct, buyNo: p.buys + 1, power: o.sig.get(sym).power[i] });
          continue;
        }
        if (st === 'tidak diputuskan') { events.push({ d, sym, type: 'TAMBAH', lots: 0, price: close(sym, d), status: st, pct: cfg.addPct }); continue; }
        buy(sym, d, 'TAMBAH', cfg.addPct, dec, p.source);
      }

      // 4. Saham baru: kandidat Buy hari ini, urut Power tertinggi
      const cands = [];
      for (const sym of o.universe) {
        if (pos.has(sym)) continue;
        const i = at(sym, d);
        if (i === undefined || !o.sig.get(sym).buyRaw[i]) continue;
        cands.push({ sym, power: o.sig.get(sym).power[i], price: o.sig.get(sym).C[i], provisional: o.sig.get(sym).P ? o.sig.get(sym).P[i] === 1 : false });
      }
      cands.sort((a, b) => b.power - a.power);
      let free = cfg.slots - systemCount();
      for (const c of cands) {
        const key = `${d}|${c.sym}|NEW`;
        handled.add(key);
        const dec = book.decisions[key];
        c.key = key;
        c.slotFree = free > 0;
        if (dec && dec.act === 'skip') { c.status = 'lewati'; events.push({ d, sym: c.sym, type: 'BELI', lots: 0, price: c.price, status: 'lewati', pct: cfg.firstPct }); continue; }
        if (dec && dec.act === 'approve') { c.status = buy(c.sym, d, 'BELI', cfg.firstPct, dec, 'system') ? 'dibeli' : 'modal habis'; free--; continue; }
        if (free <= 0) { c.status = 'slot penuh'; continue; }
        const st = undecidedStatus(d);
        if (st === 'pending') {
          const modal = modalAt(cfg, d);
          c.lots = lotsFor(Math.min(modal / cfg.slots * cfg.firstPct / 100, Math.max(modal - invested(), 0)), c.price, cfg.feeBuy);
          c.status = 'disarankan';
          pending.push({ key, d, sym: c.sym, type: 'NEW', price: c.price, lots: c.lots, power: c.power });
          free--;
          continue;
        }
        if (st === 'tidak diputuskan') { c.status = st; events.push({ d, sym: c.sym, type: 'BELI', lots: 0, price: c.price, status: st, pct: cfg.firstPct }); continue; }
        c.status = buy(c.sym, d, 'BELI', cfg.firstPct, null, 'system') ? 'dibeli' : 'modal habis';
        free--;
      }
      if (d === lastDate) candidates = cands;

      // 5. Keputusan "setuju" tanpa sinyal (mis. sinyal hilang setelah data final) tetap dicatat sebagai pembelian
      for (const [key, dec] of Object.entries(book.decisions)) {
        const [kd, sym, type] = key.split('|');
        if (+kd !== d || handled.has(key) || dec.act !== 'approve') continue;
        if (type === 'NEW' && !pos.has(sym)) buy(sym, d, 'BELI', cfg.firstPct, dec, 'system');
        if (type === 'ADD' && pos.has(sym)) buy(sym, d, 'TAMBAH', cfg.addPct, dec, pos.get(sym).source);
      }
    }

    // ringkasan posisi pada tanggal terakhir
    const modal = modalAt(cfg, lastDate);
    const positions = [...pos.values()].map((p) => {
      const s = o.sig.get(p.sym);
      const i = at(p.sym, lastDate);
      const C = i !== undefined ? s.C[i] : lastClose(s, lastDate);
      const prev = i !== undefined && i > 0 ? s.C[i - 1] : NaN;
      const value = p.lots * 100 * C;
      const pl = value * (1 - fs) - p.cost;
      return {
        ...p, close: C, chg: ((C - prev) / prev) * 100, avg: p.cost / (p.lots * 100), value, pl, plPct: (pl / p.cost) * 100,
        provisional: i !== undefined && s.P ? s.P[i] === 1 : false,
        addPending: pending.find((x) => x.sym === p.sym && x.type === 'ADD') || null,
      };
    }).sort((a, b) => a.entry - b.entry || a.sym.localeCompare(b.sym));

    // profit per saham sejak awal (seperti metrik "Profit for SIMBOL" di AmiBroker)
    const perSym = new Map();
    for (const t of tradesClosed) {
      const x = perSym.get(t.sym) || { sym: t.sym, realized: 0, open: 0, cost: 0 };
      x.realized += t.pl; x.cost += t.cost; perSym.set(t.sym, x);
    }
    for (const p of positions) {
      const x = perSym.get(p.sym) || { sym: p.sym, realized: 0, open: 0, cost: 0 };
      x.open = p.pl; x.cost += p.cost; perSym.set(p.sym, x);
    }

    const inv = positions.reduce((a, p) => a + p.cost, 0);
    return {
      lastDate, modal, perStock: modal / cfg.slots, invested: inv, available: modal - inv,
      unrealized: positions.reduce((a, p) => a + p.pl, 0),
      realized: tradesClosed.reduce((a, t) => a + t.pl, 0),
      positions, candidates, pending, soldToday, events: events.reverse(),
      perSymbol: [...perSym.values()].map((x) => ({ ...x, total: x.realized + x.open, pct: ((x.realized + x.open) / x.cost) * 100 }))
        .sort((a, b) => b.total - a.total),
      systemCount: positions.filter((p) => p.source === 'system').length,
      cfg,
    };
  }

  function lastClose(s, d) {
    for (let i = s.date.length - 1; i >= 0; i--) if (s.date[i] <= d) return s.C[i];
    return NaN;
  }

  const Portfolio = { simulate, lotsFor, modalAt, DEFAULT_CFG };
  global.Portfolio = Portfolio;
  if (typeof module !== 'undefined' && module.exports) module.exports = Portfolio;
})(typeof window !== 'undefined' ? window : globalThis);
