/*
 * chart.js — menggambar chart harga, panel NBSA, dan RRG.
 * Memakai library Lightweight Charts (TradingView). Angka indikator datang dari formula privat.
 */
(function (global) {
  'use strict';

  const COLORS = {
    up: '#3fb950', down: '#f85149', up2: 'rgba(46,160,67,0.35)', down2: 'rgba(219,97,162,0.35)',
    white: '#e6edf3', aqua: '#39c5cf', grey: '#8b949e', text: '#c9d1d9', grid: '#21262d', bg: '#0d1117',
  };

  const toTime = (d) => `${Math.floor(d / 10000)}-${String(Math.floor(d / 100) % 100).padStart(2, '0')}-${String(d % 100).padStart(2, '0')}`;
  const fromTime = (t) => (typeof t === 'string' ? Number(t.replace(/-/g, '')) : t.year * 10000 + t.month * 100 + t.day);
  const fmt = (x, d = 0) => (Number.isNaN(x) || x === undefined ? '-' : x.toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d }));

  class ChartView {
    constructor(el) {
      this.el = el;
      const LC = global.LightweightCharts;
      if (!LC) throw new Error('Library chart gagal dimuat (cek koneksi internet).');
      const base = {
        autoSize: true,
        layout: { background: { color: COLORS.bg }, textColor: COLORS.text },
        grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
        crosshair: { mode: LC.CrosshairMode.Normal },
        timeScale: { rightOffset: 4, borderColor: '#30363d' },
        rightPriceScale: { borderColor: '#30363d' },
        localization: { locale: 'id-ID' },
      };
      this.price = LC.createChart(el.price, base);
      this.candle = this.price.addCandlestickSeries({
        upColor: COLORS.up, downColor: COLORS.down, borderVisible: false,
        wickUpColor: COLORS.up, wickDownColor: COLORS.down,
      });
      this.vol = this.price.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
      this.price.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

      this.sub = LC.createChart(el.nbsa, { ...base, timeScale: { ...base.timeScale, visible: true } });
      this.subBars = [];
      this.subLines = [];

      // geser/zoom kedua chart bersamaan
      let syncing = false;
      const link = (a, b) => a.timeScale().subscribeVisibleLogicalRangeChange((r) => {
        if (syncing || !r) return;
        syncing = true;
        b.timeScale().setVisibleLogicalRange(r);
        syncing = false;
      });
      link(this.price, this.sub);
      link(this.sub, this.price);

      const onMove = (p) => {
        if (!this.s) return;
        const i = p && p.time ? this.s.date.indexOf(fromTime(p.time)) : -1;
        this._info(i >= 0 ? i : this.s.date.length - 1);
      };
      this.price.subscribeCrosshairMove(onMove);
      this.sub.subscribeCrosshairMove(onMove);
      window.addEventListener('resize', () => this.s && this._rrg(this.rrgIdx));
    }

    /**
     * Tampilkan satu simbol.
     * @param o {sym, name, s (seri), signals {buy, sell} | null, nbsa (hasil formula NBSA) | null,
     *           rrg {x, y, param} | null, bars (jumlah bar terlihat; 0 = semua)}
     */
    show(o) {
      this.s = o.s;
      this.o = o;
      const s = o.s;
      const t = Array.from(s.date, toTime);
      this.candle.setData(t.map((time, i) => ({ time, open: s.O[i], high: s.H[i], low: s.L[i], close: s.C[i] })));
      this.vol.setData(t.map((time, i) => ({
        time, value: s.V[i], color: s.C[i] >= s.O[i] ? 'rgba(63,185,80,0.4)' : 'rgba(248,81,73,0.4)',
      })));

      const markers = [];
      if (o.signals) {
        for (let i = 0; i < t.length; i++) {
          if (o.signals.buy[i]) markers.push({ time: t[i], position: 'belowBar', color: COLORS.up, shape: 'arrowUp', text: 'B' });
          if (o.signals.sell[i]) markers.push({ time: t[i], position: 'aboveBar', color: COLORS.down, shape: 'arrowDown', text: 'S' });
        }
      }
      this.candle.setMarkers(markers);

      // panel NBSA
      for (const x of [...this.subBars, ...this.subLines]) this.sub.removeSeries(x);
      this.subBars = [];
      this.subLines = [];
      if (o.nbsa) {
        const bars = [...o.nbsa.plot.bars].sort((a, b) => (b.behind ? 1 : 0) - (a.behind ? 1 : 0));
        for (const b of bars) {
          const ser = this.sub.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
          ser.setData(t.map((time, i) => (Number.isNaN(b.values[i]) ? { time } : { time, value: b.values[i], color: COLORS[b.color(i)] })));
          this.subBars.push(ser);
        }
        for (const l of o.nbsa.plot.lines) {
          const ser = this.sub.addLineSeries({ color: COLORS[l.color], lineWidth: 1, priceLineVisible: false, lastValueVisible: false, lineType: 1 });
          ser.setData(t.map((time, i) => (Number.isNaN(l.values[i]) ? { time } : { time, value: l.values[i] })));
          this.subLines.push(ser);
        }
      }

      const n = t.length;
      const vis = o.bars > 0 ? Math.min(o.bars, n) : n;
      this.price.timeScale().setVisibleLogicalRange({ from: n - vis, to: n + 3 });
      this._info(n - 1);
    }

    _info(i) {
      const { s, o } = this;
      const pc = i > 0 ? s.C[i - 1] : NaN;
      const chg = ((s.C[i] - pc) / pc) * 100;
      const sementara = s.P && s.P[i] ? ' <span class="badge">SEMENTARA</span>' : '';
      this.el.title.innerHTML = `${o.sym} <span class="muted">${o.name || ''} · ${toTime(s.date[i])}</span>${sementara}<br>` +
        `<span class="muted">O</span> ${fmt(s.O[i])} <span class="muted">H</span> ${fmt(s.H[i])} ` +
        `<span class="muted">L</span> ${fmt(s.L[i])} <span class="muted">C</span> ${fmt(s.C[i])} ` +
        `<span class="${chg >= 0 ? 'up' : 'down'}" style="color:${chg >= 0 ? COLORS.up : COLORS.down}">${chg >= 0 ? '+' : ''}${fmt(chg, 2)}%</span>`;
      if (o.nbsa) {
        const info = o.nbsa.info(i);
        this.el.nbsaInfo.innerHTML = Object.entries(info).map(([k, v]) => `<span>${k}: <b>${v}</b></span>`).join('');
      } else {
        this.el.nbsaInfo.textContent = '';
      }
      this._rrg(i);
    }

    // ---------------------------------------------------------------- RRG
    _rrg(endIdx) {
      this.rrgIdx = endIdx;
      const cv = this.el.rrg;
      const ctx = cv.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const W = cv.clientWidth, H = cv.clientHeight;
      cv.width = W * dpr; cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      const r = this.o && this.o.rrg;
      if (!r) { this.el.rrgInfo.textContent = ''; return; }

      const { ekor, jarak } = r.param;
      const pts = [];
      for (let k = ekor - 1; k >= 0; k--) {
        const idx = endIdx - k * jarak;
        if (idx >= 0 && !Number.isNaN(r.x[idx]) && !Number.isNaN(r.y[idx])) pts.push([r.x[idx], r.y[idx]]);
      }
      if (!pts.length) { this.el.rrgInfo.textContent = 'Data belum cukup untuk RRG.'; return; }

      let xmin = 100, xmax = 100, ymin = 100, ymax = 100;
      for (const [x, y] of pts) { xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
      const rx = Math.max(xmax - xmin, 0.5), ry = Math.max(ymax - ymin, 0.5);
      xmin -= rx * 0.1; xmax += rx * 0.1; ymin -= ry * 0.1; ymax += ry * 0.1;
      const L = 40, R = W - 50, T = 10, B = H - 26;
      const X = (v) => L + ((v - xmin) / (xmax - xmin)) * (R - L);
      const Y = (v) => B - ((v - ymin) / (ymax - ymin)) * (B - T);
      const cx = X(100), cy = Y(100);

      // kuadran
      const quad = [['#191e46', L, T, cx, cy], ['#143c19', cx, T, R, cy], ['#461616', L, cy, cx, B], ['#413c0f', cx, cy, R, B]];
      for (const [c, x1, y1, x2, y2] of quad) { ctx.fillStyle = c; ctx.fillRect(x1, y1, x2 - x1, y2 - y1); }

      // grid & sumbu
      ctx.font = '11px system-ui';
      ctx.fillStyle = '#7d8590';
      ctx.strokeStyle = '#373737';
      ctx.setLineDash([2, 3]);
      const step = (span) => { const raw = span / 6; const p = 10 ** Math.floor(Math.log10(raw)); const m = raw / p; return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p; };
      const sx = step(xmax - xmin), sy = step(ymax - ymin);
      ctx.textAlign = 'center';
      for (let g = Math.ceil(xmin / sx) * sx; g <= xmax; g += sx) {
        ctx.beginPath(); ctx.moveTo(X(g), T); ctx.lineTo(X(g), B); ctx.stroke();
        ctx.fillText(g.toFixed(1), X(g), B + 14);
      }
      ctx.textAlign = 'left';
      for (let g = Math.ceil(ymin / sy) * sy; g <= ymax; g += sy) {
        ctx.beginPath(); ctx.moveTo(L, Y(g)); ctx.lineTo(R, Y(g)); ctx.stroke();
        ctx.fillText(g.toFixed(1), R + 4, Y(g) + 4);
      }
      ctx.setLineDash([]);
      ctx.strokeStyle = '#666';
      ctx.beginPath(); ctx.moveTo(cx, T); ctx.lineTo(cx, B); ctx.moveTo(L, cy); ctx.lineTo(R, cy); ctx.stroke();

      ctx.font = 'bold 12px system-ui';
      ctx.fillStyle = '#7878ff'; ctx.fillText('Improving', L + 6, T + 16);
      ctx.fillStyle = '#ff5a5a'; ctx.fillText('Lagging', L + 6, B - 8);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#5adc5a'; ctx.fillText('Leading', R - 6, T + 16);
      ctx.fillStyle = '#e6d250'; ctx.fillText('Weakening', R - 6, B - 8);

      // ekor
      const col = '#00d2ff';
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 2;
      let px, py;
      pts.forEach(([x, y], k) => {
        const qx = X(x), qy = Y(y);
        if (k === 0) { ctx.beginPath(); ctx.arc(qx, qy, 3, 0, 7); ctx.fill(); }
        else {
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(qx, qy); ctx.stroke();
          if (k < pts.length - 1) arrow(ctx, px, py, qx, qy, 7);
        }
        px = qx; py = qy;
      });
      ctx.fillRect(px - 5, py - 5, 10, 10);
      ctx.textAlign = 'left';
      ctx.font = 'bold 12px system-ui';
      ctx.fillText(this.o.sym, px + 8, py - 6);

      const [xn, yn] = pts[pts.length - 1];
      const kuadran = xn >= 100 ? (yn >= 100 ? 'Leading' : 'Weakening') : (yn >= 100 ? 'Improving' : 'Lagging');
      this.el.rrgInfo.textContent = `${toTime(this.s.date[endIdx])} · RS-Ratio ${xn.toFixed(2)} · RS-Momentum ${yn.toFixed(2)} · ${kuadran}`;
    }
  }

  function arrow(ctx, x1, y1, x2, y2, uk) {
    const dx = x2 - x1, dy = y2 - y1, pj = Math.hypot(dx, dy);
    if (pj <= 2) return;
    const ux = dx / pj, uy = dy / pj, bx = x2 - ux * uk, by = y2 - uy * uk;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(bx - uy * uk * 0.5, by + ux * uk * 0.5);
    ctx.lineTo(bx + uy * uk * 0.5, by - ux * uk * 0.5);
    ctx.closePath();
    ctx.fill();
  }

  global.ChartView = ChartView;
})(typeof window !== 'undefined' ? window : globalThis);
