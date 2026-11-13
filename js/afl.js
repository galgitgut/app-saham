/*
 * afl.js — pustaka fungsi gaya AFL (AmiBroker Formula Language) untuk JavaScript.
 *
 * Ini hanya fungsi UMUM (MA, EMA, Ref, Cross, dll.), bukan rumus trading siapa pun.
 * Rumus pribadi (BinarSaujana, RRG, NBSA) ada di repo privat `data-saham`.
 *
 * Aturan dasar:
 *  - Setiap "array" = Float64Array sepanjang jumlah bar.
 *  - Null AmiBroker = NaN. Perbandingan dengan NaN selalu false (sama seperti AmiBroker).
 *  - Kondisi (true/false) disimpan sebagai Uint8Array berisi 0/1.
 */
(function (global) {
  'use strict';

  const NaN_ = Number.NaN;
  const isNull = (x) => Number.isNaN(x);

  /** Buat array baru berisi Null. */
  function empty(n) {
    return new Float64Array(n).fill(NaN_);
  }

  /** Ubah angka biasa jadi array konstan. */
  function arr(x, n) {
    if (typeof x === 'number') return new Float64Array(n).fill(x);
    return x;
  }

  /** Operasi per bar: map(a, b, (x, y) => x + y). */
  function map(a, b, fn) {
    const n = a.length;
    const out = new Float64Array(n);
    const bIsNum = typeof b === 'number';
    for (let i = 0; i < n; i++) out[i] = fn(a[i], bIsNum ? b : b[i], i);
    return out;
  }

  /** Kondisi per bar → Uint8Array 0/1. */
  function cond(n, fn) {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = fn(i) ? 1 : 0;
    return out;
  }

  // ------------------------------------------------------------------ fungsi AFL

  /** Ref(x, -1) = nilai 1 bar sebelumnya. Ref(x, 1) = 1 bar sesudahnya. */
  function Ref(x, k) {
    const n = x.length;
    const out = x instanceof Uint8Array ? new Uint8Array(n) : empty(n);
    for (let i = 0; i < n; i++) {
      const j = i + k;
      if (j >= 0 && j < n) out[i] = x[j];
    }
    return out;
  }

  /** Rata-rata sederhana n bar. */
  function MA(x, p) {
    const n = x.length;
    const out = empty(n);
    let sum = 0;
    let valid = 0;
    for (let i = 0; i < n; i++) {
      if (!isNull(x[i])) { sum += x[i]; valid++; }
      if (i >= p && !isNull(x[i - p])) { sum -= x[i - p]; valid--; }
      if (i >= p - 1 && valid === p) out[i] = sum / p;
    }
    return out;
  }

  function Sum(x, p) {
    return map(MA(x, p), 0, (m) => m * p);
  }

  function rolling(x, p, pick) {
    const n = x.length;
    const out = empty(n);
    for (let i = p - 1; i < n; i++) {
      let v = x[i - p + 1];
      let ok = !isNull(v);
      for (let j = i - p + 2; ok && j <= i; j++) {
        if (isNull(x[j])) ok = false;
        else v = pick(v, x[j]);
      }
      if (ok) out[i] = v;
    }
    return out;
  }

  const HHV = (x, p) => rolling(x, p, Math.max);
  const LLV = (x, p) => rolling(x, p, Math.min);

  /** AMA (adaptive MA) dengan faktor f; dipakai juga untuk EMA. */
  function AMA(x, f) {
    const n = x.length;
    const out = empty(n);
    let prev = NaN_;
    for (let i = 0; i < n; i++) {
      if (isNull(x[i])) continue;
      prev = isNull(prev) ? x[i] : f * x[i] + (1 - f) * prev;
      out[i] = prev;
    }
    return out;
  }

  const EMA = (x, p) => AMA(x, 2 / (p + 1));

  /** Wilder smoothing (dipakai ATR dan RSI). */
  function Wilders(x, p) {
    const n = x.length;
    const out = empty(n);
    let start = -1;
    for (let i = 0; i < n; i++) {
      if (isNull(x[i])) continue;
      if (start < 0) start = i;
      const cnt = i - start + 1;
      if (cnt === p) {
        let s = 0;
        for (let j = start; j <= i; j++) s += x[j];
        out[i] = s / p;
      } else if (cnt > p) {
        out[i] = (out[i - 1] * (p - 1) + x[i]) / p;
      }
    }
    return out;
  }

  function ATR(H, L, C, p) {
    const n = C.length;
    const tr = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const pc = i > 0 ? C[i - 1] : NaN_;
      tr[i] = isNull(pc)
        ? H[i] - L[i]
        : Math.max(H[i] - L[i], Math.abs(H[i] - pc), Math.abs(L[i] - pc));
    }
    return Wilders(tr, p);
  }

  function RSI(C, p = 14) {
    const n = C.length;
    const up = empty(n);
    const dn = empty(n);
    for (let i = 1; i < n; i++) {
      const d = C[i] - C[i - 1];
      up[i] = d > 0 ? d : 0;
      dn[i] = d < 0 ? -d : 0;
    }
    const au = Wilders(up, p);
    const ad = Wilders(dn, p);
    return map(au, ad, (u, d) => 100 - 100 / (1 + u / d));
  }

  function ROC(x, p) {
    const prev = Ref(x, -p);
    return map(x, prev, (a, b) => ((a - b) / b) * 100);
  }

  /** Cross(a, b): a memotong b ke atas di bar ini. */
  function Cross(a, b) {
    const n = a.length;
    const A = arr(a, n);
    const B = arr(b, n);
    return cond(n, (i) => i > 0 && A[i] > B[i] && A[i - 1] <= B[i - 1]);
  }

  function ValueWhen(c, x) {
    const n = x.length;
    const out = empty(n);
    let last = NaN_;
    for (let i = 0; i < n; i++) {
      if (c[i]) last = x[i];
      out[i] = last;
    }
    return out;
  }

  function BarsSince(c) {
    const n = c.length;
    const out = empty(n);
    let last = -1;
    for (let i = 0; i < n; i++) {
      if (c[i]) last = i;
      if (last >= 0) out[i] = i - last;
    }
    return out;
  }

  function ExRem(a, b) {
    const n = a.length;
    const out = new Uint8Array(n);
    let active = false;
    for (let i = 0; i < n; i++) {
      if (!active && a[i]) { out[i] = 1; active = true; }
      else if (active && b[i]) active = false;
    }
    return out;
  }

  function Flip(a, b) {
    const n = a.length;
    const out = new Uint8Array(n);
    let st = false;
    for (let i = 0; i < n; i++) {
      if (a[i]) st = true;
      else if (b[i]) st = false;
      out[i] = st ? 1 : 0;
    }
    return out;
  }

  function Not(c) {
    const out = new Uint8Array(c.length);
    for (let i = 0; i < c.length; i++) out[i] = c[i] ? 0 : 1;
    return out;
  }

  /** Max/Min per bar; Null diabaikan bila salah satu ada nilainya. */
  const Max = (a, b) => map(a, b, (x, y) => (isNull(x) ? y : isNull(y) ? x : Math.max(x, y)));
  const Min = (a, b) => map(a, b, (x, y) => (isNull(x) ? y : isNull(y) ? x : Math.min(x, y)));

  /** Foreign(): seri simbol lain, disejajarkan per tanggal; tanggal kosong diisi nilai sebelumnya. */
  function Foreign(dates, fDates, fValues) {
    const n = dates.length;
    const out = empty(n);
    let j = -1;
    for (let i = 0; i < n; i++) {
      while (j + 1 < fDates.length && fDates[j + 1] <= dates[i]) j++;
      if (j >= 0) out[i] = fValues[j];
    }
    return out;
  }

  /** AmiBroker menyimpan hasil sebagai float32; ini meniru pembulatannya. */
  function f32(x) {
    const out = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = Math.fround(x[i]);
    return out;
  }

  const AFL = {
    empty, arr, map, cond, isNull,
    Ref, MA, Sum, HHV, LLV, AMA, EMA, Wilders, ATR, RSI, ROC,
    Cross, ValueWhen, BarsSince, ExRem, Flip, Not, Max, Min, Foreign, f32,
  };

  global.AFL = AFL;
  if (typeof module !== 'undefined' && module.exports) module.exports = AFL;
})(typeof window !== 'undefined' ? window : globalThis);
