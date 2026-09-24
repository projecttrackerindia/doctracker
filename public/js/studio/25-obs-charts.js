/* ============================================================================
   Observability charts.

   Pure render functions: they take data and return SVG/HTML strings, so they
   can be unit-reasoned about and reused wherever the shape fits.

   SVG rather than canvas because these need to be readable at any width, sit
   in both light and dark themes, and carry native <title> tooltips without a
   hit-testing layer. Nothing here loads a charting library - the whole app
   ships no third-party JS and this is not the place to start.
   ========================================================================= */

const OBS_STATUS_COLORS = {
  '2xx': 'var(--st-2)',
  '3xx': 'var(--st-3)',
  '4xx': 'var(--st-4)',
  '5xx': 'var(--st-5)',
  unknown: 'var(--text-faint)',
};

const OBS_STATUS_FAMILIES = ['2xx', '3xx', '4xx', '5xx', 'unknown'];

/* Axis ticks that land on round numbers instead of on whatever the maximum
   happens to be. A y-axis labelled "1,247" reads as noise; "1,500" reads as a
   scale. */
function obsNiceCeiling(value){
  if(value <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalised = value / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

function obsFormatCount(n){
  if(n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if(n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if(n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

/* Time labels sized to the span: a 15-minute window wants clock time, a
   90-day window wants dates. Showing "24 Sept" on every tick of an hour-long
   window is what makes a chart look machine-generated. */
function obsTimeLabel(iso, spanMs){
  const d = new Date(iso);
  if(isNaN(d.getTime())) return '';
  const pad = (n)=>String(n).padStart(2, '0');
  if(spanMs <= 6 * 3600e3) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if(spanMs <= 3 * 86400e3) return `${d.getDate()} ${d.toLocaleString(undefined,{month:'short'})} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getDate()} ${d.toLocaleString(undefined,{month:'short'})}`;
}

/* ---------------------------------------------------------------------------
   Traffic over time.

   THE headline chart, and the thing the console had no answer for before: a
   stacked area of requests by status family, with error rate as a line on its
   own right-hand axis.

   Stacked-by-family rather than one total line because the question is almost
   never "how many requests" on its own - it is "how many, and were they ok".
   A spike that is entirely 2xx and a spike that is half 5xx look identical on
   a total line and completely different here.
   ------------------------------------------------------------------------ */
function renderTrafficChart(series, opts){
  const o = opts || {};
  const width = 1000;   // viewBox units; the SVG scales to its container
  const height = 260;
  const padL = 52, padR = 48, padT = 16, padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  if(!series || series.length === 0){
    return `<div class="obs-chart-empty">No traffic in this range.</div>`;
  }

  const spanMs = Date.parse(series[series.length - 1].ts) - Date.parse(series[0].ts);
  const maxTotal = Math.max(...series.map(p => p.total), 1);
  const yMax = obsNiceCeiling(maxTotal);
  // One point produces no line; give it a visible column instead of a dot
  // floating in an empty plot.
  const stepX = series.length > 1 ? plotW / (series.length - 1) : plotW;

  const xAt = (i)=> padL + (series.length > 1 ? i * stepX : plotW / 2);
  const yAt = (v)=> padT + plotH - (v / yMax) * plotH;

  // Stacked bands, bottom-up in severity order so errors sit on top where
  // they are visible against the plot edge rather than buried under 2xx.
  const order = ['2xx', '3xx', '4xx', '5xx', 'unknown'];
  const running = series.map(()=>0);
  const bands = [];
  for(const fam of order){
    const lower = running.slice();
    series.forEach((p, i)=>{ running[i] += (p.statusBreakdown?.[fam] || 0); });
    if(running.every((v, i)=> v === lower[i])) continue; // family absent - no empty band
    const top = series.map((p, i)=> `${xAt(i)},${yAt(running[i])}`).join(' ');
    const bottom = lower.map((v, i)=> `${xAt(series.length - 1 - i)},${yAt(lower[series.length - 1 - i])}`).join(' ');
    bands.push(`<polygon points="${top} ${bottom}" fill="${OBS_STATUS_COLORS[fam]}" opacity="0.75"></polygon>`);
  }

  // Error rate on its own 0-100% axis. Drawn as a line, not a band, so it
  // reads as a rate rather than another volume.
  const errPoints = series.map((p, i)=>{
    const errs = (p.statusBreakdown?.['4xx'] || 0) + (p.statusBreakdown?.['5xx'] || 0);
    const rate = p.total ? errs / p.total : 0;
    return `${xAt(i)},${padT + plotH - rate * plotH}`;
  }).join(' ');

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map(f=>{
    const y = padT + plotH - f * plotH;
    return `<line x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}" class="obs-chart-grid"></line>
      <text x="${padL - 8}" y="${y + 4}" class="obs-chart-ylabel">${obsFormatCount(Math.round(yMax * f))}</text>
      <text x="${padL + plotW + 8}" y="${y + 4}" class="obs-chart-ylabel obs-chart-ylabel-right">${Math.round(f * 100)}%</text>`;
  }).join('');

  // Hover targets: one invisible column per point, carrying a native title.
  // No JS hit-testing, no tooltip library, and it works on touch.
  const hoverCols = series.map((p, i)=>{
    const errs = (p.statusBreakdown?.['4xx'] || 0) + (p.statusBreakdown?.['5xx'] || 0);
    const rate = p.total ? Math.round((errs / p.total) * 1000) / 10 : 0;
    const parts = OBS_STATUS_FAMILIES
      .filter(f => (p.statusBreakdown?.[f] || 0) > 0)
      .map(f => `${f} ${(p.statusBreakdown[f]).toLocaleString()}`);
    const when = formatDateTime(p.ts);
    const latency = p.meanLatencyMs === null || p.meanLatencyMs === undefined
      ? '' : ` — mean ${p.meanLatencyMs}ms`;
    const title = `${when}\n${p.total.toLocaleString()} request(s)${latency}\n${parts.join(' · ') || 'no responses classified'}\nerror rate ${rate}%`;
    const w = Math.max(stepX, 2);
    return `<rect x="${xAt(i) - w / 2}" y="${padT}" width="${w}" height="${plotH}"
      class="obs-chart-hover" data-obs-point="${i}"><title>${escapeHtml(title)}</title></rect>`;
  }).join('');

  const firstLabel = obsTimeLabel(series[0].ts, spanMs);
  const lastLabel = obsTimeLabel(series[series.length - 1].ts, spanMs);
  const midIdx = Math.floor(series.length / 2);
  const midLabel = series.length > 2 ? obsTimeLabel(series[midIdx].ts, spanMs) : '';

  return `<div class="obs-chart-wrap">
    <svg viewBox="0 0 ${width} ${height}" class="obs-chart" preserveAspectRatio="none" role="img"
         aria-label="Requests over time by status family, with error rate">
      ${gridLines}
      ${bands.join('')}
      <polyline points="${errPoints}" class="obs-chart-errline"></polyline>
      ${hoverCols}
    </svg>
    <div class="obs-chart-axis">
      <span>${escapeHtml(firstLabel)}</span>
      ${midLabel ? `<span>${escapeHtml(midLabel)}</span>` : ''}
      <span>${escapeHtml(lastLabel)}</span>
    </div>
    ${o.hideLegend ? '' : `<div class="obs-chart-legend">
      ${order.filter(f => series.some(p => (p.statusBreakdown?.[f] || 0) > 0)).map(f =>
        `<button type="button" class="obs-legend-chip" data-obs-filter-family="${f}" title="Show only ${f} responses in the log explorer">
          <i style="background:${OBS_STATUS_COLORS[f]};"></i>${f}
        </button>`).join('')}
      <span class="obs-legend-chip obs-legend-static"><i class="obs-legend-line"></i>error rate</span>
    </div>`}
  </div>`;
}

/* ---------------------------------------------------------------------------
   Latency distribution, drawn from the histogram bands the rollups store.

   Shows WHERE the time goes rather than three percentile numbers. A bimodal
   distribution - most requests fast, a second clump at two seconds - is
   invisible in p50/p95/p99 and obvious here.
   ------------------------------------------------------------------------ */
function renderLatencyHistogram(buckets, latency){
  const keys = ['10','25','50','100','250','500','1000','2500','5000','10000','inf'];
  const labels = {
    '10':'≤10ms','25':'≤25ms','50':'≤50ms','100':'≤100ms','250':'≤250ms',
    '500':'≤500ms','1000':'≤1s','2500':'≤2.5s','5000':'≤5s','10000':'≤10s','inf':'>10s',
  };
  const counts = keys.map(k => Number(buckets?.[k] || 0));
  const total = counts.reduce((a,b)=>a+b, 0);
  if(!total){
    return `<div class="obs-chart-empty">No latency data in this range — requests are counted, but no duration was parsed from the log lines.</div>`;
  }
  const max = Math.max(...counts, 1);
  const rows = keys.map((k, i)=>{
    const c = counts[i];
    if(!c) return '';
    const pct = Math.round((c / max) * 100);
    const share = Math.round((c / total) * 1000) / 10;
    // Anything over a second is where a user starts noticing; colour the tail.
    const slow = k === 'inf' || Number(k) >= 1000;
    return `<div class="obs-histo-row" title="${labels[k]}: ${c.toLocaleString()} request(s), ${share}%">
      <span class="obs-histo-label">${labels[k]}</span>
      <span class="obs-ip-bar-track"><span class="obs-ip-bar" style="width:${Math.max(pct,2)}%;background:${slow ? 'var(--st-4)' : 'var(--accent)'};"></span></span>
      <span class="obs-ip-count">${obsFormatCount(c)} <span style="opacity:.7;">(${share}%)</span></span>
    </div>`;
  }).join('');

  const marks = latency ? `<div class="obs-histo-marks">
    <span><b>p50</b> ${latency.p50}ms</span>
    <span><b>p95</b> ${latency.p95}ms</span>
    <span><b>p99</b> ${latency.p99}ms</span>
    ${latency.max !== null && latency.max !== undefined ? `<span><b>max</b> ${latency.max}ms</span>` : ''}
  </div>` : '';

  return `<div class="obs-histo">${rows}</div>${marks}`;
}

/* Sparkline for a single metric inside a KPI tile. Deliberately tiny and
   axis-less: it answers "which way is this going" at a glance, and the chart
   above answers everything else. */
function renderKpiSparkline(values, colorVar){
  const nums = (values || []).map(v => Number(v) || 0);
  if(nums.length < 2) return '';
  const max = Math.max(...nums, 1);
  const w = 100, h = 24;
  const step = w / (nums.length - 1);
  const pts = nums.map((v, i)=> `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" class="obs-kpi-spark" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${pts}" style="stroke:var(${colorVar || '--accent'});"></polyline>
  </svg>`;
}
