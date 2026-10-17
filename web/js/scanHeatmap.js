import { fmt } from './engine.js';
import { metricValue } from './scanMetrics.js';

export function heatGeometry(width, height) {
  return { left: 55, top: 25, width: Math.max(1, width - 125), height: Math.max(1, height - 65) };
}

const palette = [[23, 63, 77], [70, 169, 154], [245, 198, 111]];
export function heatColor(value) {
  const t = Math.max(0, Math.min(1, value)) * 2, i = Math.min(1, Math.floor(t));
  return `rgb(${palette[i].map((c, j) => Math.round(c + (palette[i + 1][j] - c) * (t - i))).join(',')})`;
}
const tick = n => Math.abs(n) >= 100000 ? n.toExponential(1) : fmt(n);

export function drawHeatmap(ctx, width, height, rows, axes, metric, selectedX, selectedY) {
  const g = heatGeometry(width, height), xs = axes[0].values, ys = axes[1].values;
  const fraction = (v, values) => values.length === 1 ? 0.5 : (v - values[0]) / (values.at(-1) - values[0]);
  const bounds = (values, i) => values.length === 1 ? [0, 1] : [
    i === 0 ? 0 : fraction((values[i - 1] + values[i]) / 2, values),
    i === values.length - 1 ? 1 : fraction((values[i] + values[i + 1]) / 2, values),
  ];
  const peak = rows.reduce((max, r) => Math.max(max, metricValue(r, metric) ?? 0), 0);
  const maximum = peak > 1e-6 ? peak : 1;
  let selected;
  rows.forEach(r => {
    const bx = bounds(xs, r.xIndex), by = bounds(ys, r.yIndex);
    const x = g.left + bx[0] * g.width, y = g.top + (1 - by[1]) * g.height;
    const w = (bx[1] - bx[0]) * g.width, h = (by[1] - by[0]) * g.height;
    const value = metricValue(r, metric);
    ctx.fillStyle = value !== null ? heatColor(value / maximum) : '#64676c';
    ctx.fillRect(x, y, w + 0.3, h + 0.3);
    if (value === null) {
      ctx.strokeStyle = '#25282c'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y + h); ctx.moveTo(x + w, y); ctx.lineTo(x, y + h); ctx.stroke();
    }
    if (r.xIndex === selectedX && r.yIndex === selectedY) selected = { x, y, w, h };
  });
  if (selected) {
    const { x, y, w, h } = selected;
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, Math.max(1, w - 2), Math.max(1, h - 2));
    ctx.strokeStyle = '#11191c'; ctx.lineWidth = 1; ctx.strokeRect(x + 3, y + 3, Math.max(1, w - 6), Math.max(1, h - 6));
  }
  ctx.font = '12px sans-serif'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#bdc8cb';
  for (let i = 0; i <= 4; i++) {
    if (xs.length > 1 || i === 2) {
      ctx.textAlign = 'center'; ctx.fillText(tick(xs[0] + (xs.at(-1) - xs[0]) * i / 4), g.left + g.width * i / 4, height - 23);
    }
    if (ys.length > 1 || i === 2) {
      ctx.textAlign = 'right'; ctx.fillText(tick(ys[0] + (ys.at(-1) - ys[0]) * i / 4), g.left - 8, g.top + g.height * (1 - i / 4));
    }
  }
  ctx.textAlign = 'left'; ctx.fillText(`${axes[1].chartName || axes[1].name || axes[1].label || '原料'} /分`, 8, 12, Math.max(1, width - 80));
  ctx.textAlign = 'right'; ctx.fillText(`${axes[0].chartName || axes[0].name || axes[0].label || '原料'} /分`, g.left + g.width, height - 8, g.width);
  const barX = width - 49;
  for (let i = 0; i < g.height; i++) {
    ctx.fillStyle = heatColor(1 - i / Math.max(1, g.height - 1)); ctx.fillRect(barX, g.top + i, 12, 1);
  }
  ctx.fillStyle = '#bdc8cb'; ctx.textAlign = 'right';
  ctx.fillText(tick(maximum), width - 3, 12); ctx.fillText('0', width - 3, g.top + g.height + 12);
  ctx.fillText('/分', width - 3, g.top + g.height / 2);
}
