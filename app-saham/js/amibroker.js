/*
 * amibroker.js — membaca file database native AmiBroker (format "BROKDAt5").
 *
 * Satu file = satu simbol. Struktur:
 *   offset 0     : teks "BROKDAt5"
 *   offset 8     : kode simbol (mis. "^JKSE")
 *   offset 152   : nama lengkap (mis. "Bank Negara Indonesia (Persero) Tbk.")
 *   offset 1180  : jumlah bar (uint32)
 *   offset 1184+ : bar, masing-masing 40 byte:
 *                  8 byte tanggal terpaket + 8 float32 (Close, Open, High, Low, Volume, OpenInt, Aux1, Aux2)
 *   Aux1 = Frekuensi, Aux2 = NBSA.
 */
(function (global) {
  'use strict';

  function readCString(bytes, start, maxLen) {
    let s = '';
    for (let i = start; i < start + maxLen && i < bytes.length; i++) {
      if (bytes[i] === 0) break;
      s += String.fromCharCode(bytes[i]);
    }
    return s;
  }

  /**
   * Baca satu file AmiBroker.
   * @param {ArrayBuffer} buf isi file
   * @returns {{sym:string, name:string, bars:Array}} atau null kalau bukan file AmiBroker
   */
  function parseBroker(buf) {
    const bytes = new Uint8Array(buf);
    if (bytes.length < 1184 || readCString(bytes, 0, 8) !== 'BROKDAt5') return null;
    const dv = new DataView(buf);
    const sym = readCString(bytes, 8, 32);
    const name = readCString(bytes, 152, 148);
    const count = dv.getUint32(1180, true);
    const bars = [];
    for (let i = 0; i < count; i++) {
      const off = 1184 + i * 40;
      if (off + 40 > bytes.length) break;
      // tanggal terpaket: tahun = bit 52–63, bulan = bit 48–51, hari = bit 43–47
      const hi = dv.getUint32(off + 4, true);
      const year = hi >>> 20;
      const month = (hi >>> 16) & 0xf;
      const day = (hi >>> 11) & 0x1f;
      bars.push({
        d: year * 10000 + month * 100 + day,
        c: dv.getFloat32(off + 8, true),
        o: dv.getFloat32(off + 12, true),
        h: dv.getFloat32(off + 16, true),
        l: dv.getFloat32(off + 20, true),
        v: dv.getFloat32(off + 24, true),
        f: dv.getFloat32(off + 32, true),
        n: dv.getFloat32(off + 36, true),
      });
    }
    return { sym, name, bars };
  }

  const AmiBroker = { parseBroker };
  global.AmiBroker = AmiBroker;
  if (typeof module !== 'undefined' && module.exports) module.exports = AmiBroker;
})(typeof window !== 'undefined' ? window : globalThis);
