// Minimal inline-SVG charts: single-series, thin marks, recessive axes,
// hover tooltips via [data-tip] (handled globally in app.js).

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const W = 360;
const H = 180;
const PAD = { l: 8, r: 8, t: 18, b: 24 };

function roundedTop(x, y, w, h, r) {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

const short = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(1).replace('.', ',')}M`;
  if (a >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
};

/** data: [{label, value, tip}] ; target: optional reference value */
export function barChart(data, { target, targetLabel = 'Meta', ariaLabel = 'Gráfico de barras' } = {}) {
  if (!data.length) return '<p class="muted small">Aún no hay datos para graficar.</p>';
  const max = Math.max(1, target || 0, ...data.map((d) => d.value)) * 1.1;
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const step = innerW / data.length;
  const bw = Math.max(6, Math.min(36, step - 6));
  const y = (v) => PAD.t + innerH - (Math.max(0, v) / max) * innerH;
  const base = PAD.t + innerH;
  let out = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel)}">`;
  out += `<line class="gridline" x1="${PAD.l}" x2="${W - PAD.r}" y1="${base}" y2="${base}"/>`;
  data.forEach((d, i) => {
    const cx = PAD.l + step * i + step / 2;
    const top = y(d.value);
    out += `<path class="bar" d="${roundedTop(cx - bw / 2, top, bw, base - top, 4)}"/>`;
    out += `<text class="axis" x="${cx}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text>`;
    if (i === data.length - 1 || data.length <= 6) {
      out += `<text class="value-label" x="${cx}" y="${Math.max(10, top - 4)}" text-anchor="middle">${short(d.value)}</text>`;
    }
    out += `<rect class="hit" x="${cx - step / 2}" y="${PAD.t}" width="${step}" height="${innerH}" data-tip="${esc(d.tip)}"/>`;
  });
  if (target) {
    const ty = y(target);
    out += `<line class="target" x1="${PAD.l}" x2="${W - PAD.r}" y1="${ty}" y2="${ty}"/>`;
    out += `<text class="target-label" x="${W - PAD.r}" y="${ty - 4}" text-anchor="end">${esc(targetLabel)} ${short(target)}</text>`;
  }
  return `${out}</svg>`;
}

/** points: [{label, value, tip}] */
export function lineChart(points, { unit = '', ariaLabel = 'Gráfico de línea' } = {}) {
  if (points.length < 2) return '<p class="muted small">Registra al menos dos semanas para ver la evolución.</p>';
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  const lo = min - span * 0.15;
  const hi = max + span * 0.15;
  const left = 34;
  const innerW = W - left - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const x = (i) => left + (innerW * i) / (points.length - 1);
  const y = (v) => PAD.t + innerH - ((v - lo) / (hi - lo)) * innerH;
  let out = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel)}">`;
  for (const v of [hi, (hi + lo) / 2, lo]) {
    out += `<line class="gridline" x1="${left}" x2="${W - PAD.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    out += `<text class="axis" x="${left - 4}" y="${y(v) + 3}" text-anchor="end">${v.toFixed(0)}</text>`;
  }
  out += `<path class="line" d="${points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.value)}`).join('')}"/>`;
  points.forEach((p, i) => {
    out += `<circle class="dot" cx="${x(i)}" cy="${y(p.value)}" r="4"/>`;
    out += `<circle class="hit" cx="${x(i)}" cy="${y(p.value)}" r="14" data-tip="${esc(p.tip)}"/>`;
  });
  out += `<text class="axis" x="${left}" y="${H - 8}">${esc(points[0].label)}</text>`;
  out += `<text class="axis" x="${W - PAD.r}" y="${H - 8}" text-anchor="end">${esc(points.at(-1).label)}</text>`;
  out += `<text class="value-label" x="${x(points.length - 1)}" y="${y(points.at(-1).value) - 9}" text-anchor="end">${esc(points.at(-1).value)}${esc(unit)}</text>`;
  return `${out}</svg>`;
}

/** Horizontal magnitude bars with direct labels (used for category totals). */
export function hbars(rows, fmt) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return rows.map((r) => `
    <div class="hbar" data-tip="${esc(`${r.label}: ${fmt(r.value)}`)}">
      <span>${esc(r.label)}</span>
      <div class="track"><div class="fill" style="width:${(r.value / max) * 100}%"></div></div>
      <span class="amount">${fmt(r.value)}</span>
    </div>`).join('');
}
