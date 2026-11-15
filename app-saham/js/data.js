/*
 * data.js — database harga di memori, import CSV, dan format file penyimpanan.
 *
 * Bentuk data per simbol (kolom): d (yyyymmdd), o, h, l, c, v, f (frekuensi), n (NBSA),
 * p (1 = bar dari DATA1 yang belum dikonfirmasi DS3).
 *
 * File di repo `data-saham`:
 *   data/tahun/YYYY.json.gz   satu file per tahun, semua simbol
 *   data/delta/*.json.gz      hasil import harian (kecil), digabung ke file tahun saat "Konsolidasi"
 *
 * Aturan merge:
 *   1. Kunci = simbol + tanggal (jam dibuang)
 *   2. DS3 selalu menang. DATA1 tidak pernah menimpa bar DS3.
 *   3. DATA1 yang lebih baru menimpa DATA1 lama di tanggal yang sama.
 *   4. Frek/NBSA hanya dari DS3.
 */
(function (global) {
  'use strict';

  const FIELDS = ['d', 'o', 'h', 'l', 'c', 'v', 'f', 'n', 'p'];

  // ------------------------------------------------------------------ database

  class PriceDB {
    constructor() {
      this.sym = new Map(); // simbol → {d:[],o:[],...}
      this.names = {};
    }

    get(sym) {
      return this.sym.get(sym);
    }

    symbols() {
      return [...this.sym.keys()].sort();
    }

    _ensure(sym) {
      let s = this.sym.get(sym);
      if (!s) {
        s = {};
        for (const k of FIELDS) s[k] = [];
        this.sym.set(sym, s);
      }
      return s;
    }

    /** Cari posisi tanggal d (binary search). Mengembalikan {i, found}. */
    static _find(arr, d) {
      let lo = 0, hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] < d) lo = mid + 1; else hi = mid;
      }
      return { i: lo, found: arr[lo] === d };
    }

    /**
     * Masukkan satu bar sesuai aturan merge.
     * @param {string} src 'DS3' | 'DATA1' | 'AB' (database AmiBroker) | 'FILE' (file tahun/delta)
     * @returns {boolean} true kalau data berubah
     */
    upsert(sym, bar, src) {
      // AmiBroker menyimpan harga sebagai float32; disamakan agar hasil hitung identik
      bar = { ...bar };
      for (const k of ['o', 'h', 'l', 'c', 'v', 'f', 'n']) bar[k] = Math.fround(bar[k] ?? 0);
      const s = this._ensure(sym);
      const { i, found } = PriceDB._find(s.d, bar.d);
      const p = src === 'DATA1' ? 1 : src === 'FILE' ? (bar.p ? 1 : 0) : 0;
      if (found) {
        if (src === 'DATA1' && s.p[i] === 0) return false; // bar DS3 tidak boleh ditimpa DATA1
        const nb = { ...bar, p };
        if (src === 'DATA1') { nb.f = 0; nb.n = 0; }
        let changed = false;
        for (const k of FIELDS) {
          if (k === 'd') continue;
          const v = nb[k] ?? 0;
          if (s[k][i] !== v) { s[k][i] = v; changed = true; }
        }
        return changed;
      }
      for (const k of FIELDS) {
        const v = k === 'p' ? p : bar[k] ?? 0;
        s[k].splice(i, 0, src === 'DATA1' && (k === 'f' || k === 'n') ? 0 : v);
      }
      return true;
    }

    /** Terapkan koreksi manual, mis. [{sym:'BBNI', d:20130918, l:2113}]. */
    applyCorrections(list) {
      for (const k of list || []) {
        const s = this.sym.get(k.sym);
        if (!s) continue;
        const { i, found } = PriceDB._find(s.d, k.d);
        if (!found) continue;
        for (const f of ['o', 'h', 'l', 'c', 'v']) if (k[f] !== undefined) s[f][i] = k[f];
      }
    }

    /** Tanggal terakhir di seluruh database. */
    lastDate() {
      let m = 0;
      for (const s of this.sym.values()) if (s.d.length) m = Math.max(m, s.d[s.d.length - 1]);
      return m;
    }

    /** Seri untuk mesin indikator (Float64Array per kolom), mulai dari tanggal tertentu. */
    series(sym, fromDate = 0, toDate = 99999999) {
      const s = this.sym.get(sym);
      if (!s) return null;
      const a = PriceDB._find(s.d, fromDate).i;
      const b = PriceDB._find(s.d, toDate + 1).i;
      const col = (k) => Float64Array.from(s[k].slice(a, b));
      return {
        date: Int32Array.from(s.d.slice(a, b)),
        O: col('o'), H: col('h'), L: col('l'), C: col('c'), V: col('v'), F: col('f'), N: col('n'),
        P: Uint8Array.from(s.p.slice(a, b)),
      };
    }

    // -------------------------------------------------------------- file tahun

    /** Isi file tahun → masuk database. */
    loadYear(obj) {
      Object.assign(this.names, obj.names || {});
      for (const [sym, rows] of Object.entries(obj.s)) {
        const s = this._ensure(sym);
        if (!rows.length) continue;
        const after = s.d.length === 0 || rows[0][0] > s.d[s.d.length - 1];
        const before = !after && rows[rows.length - 1][0] < s.d[0];
        if (after) {
          // tahun berikutnya: tinggal ditambahkan di belakang
          for (const r of rows) for (let k = 0; k < FIELDS.length; k++) s[FIELDS[k]].push(r[k] ?? 0);
        } else if (before) {
          // tahun sebelumnya (arsip): disisipkan di depan sekaligus
          FIELDS.forEach((f, k) => { s[f] = rows.map((r) => r[k] ?? 0).concat(s[f]); });
        } else {
          for (const r of rows) this.upsert(sym, rowToBar(r), 'FILE');
        }
      }
    }

    /** Database → objek file untuk satu tahun. */
    toYear(year) {
      const from = year * 10000, to = year * 10000 + 9999;
      const out = { v: 1, year, names: {}, s: {} };
      for (const [sym, s] of this.sym) {
        const a = PriceDB._find(s.d, from).i;
        const b = PriceDB._find(s.d, to + 1).i;
        if (a >= b) continue;
        const rows = [];
        for (let i = a; i < b; i++) rows.push(FIELDS.map((k) => s[k][i]));
        out.s[sym] = rows;
        if (this.names[sym]) out.names[sym] = this.names[sym];
      }
      return out;
    }

    /** Daftar tahun yang ada datanya. */
    years() {
      const ys = new Set();
      for (const s of this.sym.values()) for (const d of s.d) ys.add(Math.floor(d / 10000));
      return [...ys].sort();
    }

    /** Terapkan file delta. */
    applyDelta(obj) {
      for (const r of obj.rows) this.upsert(r[0], rowToBar(r.slice(1)), 'FILE');
    }
  }

  function rowToBar(r) {
    const b = {};
    FIELDS.forEach((k, i) => (b[k] = r[i] ?? 0));
    return b;
  }

  // ------------------------------------------------------------------ CSV

  function splitLines(text) {
    return text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  }

  const num = (x) => (x === undefined || x.trim() === '' ? NaN : Number(x));

  /** Tanggal "a/b/yyyy[ jam]" → yyyymmdd. order 'MDY' (DS3) atau 'DMY' (DATA1). */
  function parseDate(str, order) {
    const [datePart, timePart] = str.trim().split(/\s+/);
    const [x, y, z] = datePart.split('/').map(Number);
    const [m, d] = order === 'MDY' ? [x, y] : [y, x];
    if (!(z > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    return { d: z * 10000 + m * 100 + d, time: timePart && timePart !== '0:00' ? timePart : null };
  }

  /** Kenali jenis file dari baris judul. */
  function detectFormat(text) {
    const head = splitLines(text.slice(0, 500))[0] || '';
    const h = head.toLowerCase().replace(/\s/g, '');
    if (h.startsWith('ticker,date/time,')) return 'DATA1';
    if (h.startsWith('ticker,date,open,high,low,close,volume')) return 'DS3';
    return null;
  }

  // Indeks di DATA1 yang kebetulan 4 huruf (lainnya otomatis gugur karena bukan 4 huruf)
  const DATA1_INDEX4 = new Set(['ISSI']);

  /** Saham Indonesia di DATA1: kode 4 huruf, bukan ETF (X...), bukan indeks. */
  function isData1Stock(t) {
    return /^[A-Z]{4}$/.test(t) && t[0] !== 'X' && !DATA1_INDEX4.has(t);
  }

  /**
   * Baca CSV DS3 atau DATA1.
   * @returns {{format, rows:[{sym, bar}], skipped:{...}}}
   */
  function parseCSV(text) {
    const format = detectFormat(text);
    if (!format) throw new Error('Format CSV tidak dikenal (bukan DS3 atau DATA1).');
    const lines = splitLines(text).slice(1);
    const rows = [];
    const skipped = { kosong: 0, bukanSaham: 0, tanggal: 0 };
    for (const line of lines) {
      const c = line.split(',');
      const sym = c[0].trim();
      if (format === 'DATA1' && !isData1Stock(sym)) { skipped.bukanSaham++; continue; }
      const dt = parseDate(c[1], format === 'DS3' ? 'MDY' : 'DMY');
      if (!dt) { skipped.tanggal++; continue; }
      const o = num(c[2]), h = num(c[3]), l = num(c[4]), cl = num(c[5]), v = num(c[6]);
      if ([o, h, l, cl].some(Number.isNaN)) { skipped.kosong++; continue; }
      const bar = { d: dt.d, o, h, l, c: cl, v: Number.isNaN(v) ? 0 : v, f: 0, n: 0 };
      if (format === 'DS3') {
        bar.f = num(c[8]) || 0;
        bar.n = num(c[9]) || 0;
      }
      rows.push({ sym, bar, time: dt.time });
    }
    return { format, rows, skipped };
  }

  /**
   * Import CSV ke database.
   * @returns {{format, total, changed, deltaRows, skipped}} deltaRows = baris untuk file delta
   */
  function importCSV(db, text) {
    let { format, rows, skipped } = parseCSV(text);
    if (format === 'DATA1') {
      // DATA1 hanya untuk hari-hari terakhir. Bar lama (saham suspend/delisting) diabaikan.
      const toDay = (d) => Date.UTC(Math.floor(d / 10000), Math.floor(d / 100) % 100 - 1, d % 100) / 864e5;
      const maxDay = Math.max(...rows.map((r) => toDay(r.bar.d)));
      const before = rows.length;
      rows = rows.filter((r) => maxDay - toDay(r.bar.d) <= 7);
      skipped.lama = before - rows.length;
    }
    const deltaRows = [];
    let changed = 0;
    for (const { sym, bar } of rows) {
      if (db.upsert(sym, bar, format)) {
        changed++;
        const s = db.get(sym);
        const { i } = PriceDB._find(s.d, bar.d);
        deltaRows.push([sym, ...FIELDS.map((k) => s[k][i])]);
      }
    }
    return { format, total: rows.length, changed, deltaRows, skipped };
  }

  /** Daftar exclude (format .tls AmiBroker: satu simbol per baris). */
  function parseList(text) {
    return new Set(splitLines(text).map((s) => s.trim()).filter(Boolean));
  }

  /** Saham IDX: kode 4 huruf yang punya data Frekuensi, atau datang dari DATA1. */
  function isIdxStock(db, sym) {
    if (!/^[A-Z]{4}$/.test(sym)) return false;
    const s = db.get(sym);
    if (!s) return false;
    for (let i = s.d.length - 1; i >= 0; i--) if (s.f[i] > 0 || s.p[i] === 1) return true;
    return false;
  }

  // ------------------------------------------------------------------ gzip JSON

  async function gzipJSON(obj) {
    const stream = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function gunzipJSON(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }

  const Data = {
    PriceDB, FIELDS, parseCSV, importCSV, parseDate, detectFormat, parseList, isIdxStock,
    gzipJSON, gunzipJSON,
  };
  global.Data = Data;
  if (typeof module !== 'undefined' && module.exports) module.exports = Data;
})(typeof window !== 'undefined' ? window : globalThis);
