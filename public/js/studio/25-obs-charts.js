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
  // Its own colour, not --text-faint: a 68%-of-traffic band rendered in the
  // same grey as an empty track read as "nothing here" on the one row that
  // most needed looking at.
  unknown: 'var(--st-u)',
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

/* How many gridlines to cut a scale into so every tick is a whole number.

   Four was hardcoded, which put 2.5 and 7.5 on a 0-10 axis and printed them
   as 3 and 8: ticks that look evenly spaced but aren't, on a chart counting
   whole requests. Picking the divisor from the ceiling instead keeps the
   labels honest at every magnitude. */
function obsGridFractions(yMax){
  const divisions = [4, 5, 2, 1].find(d => yMax % d === 0) || 4;
  return Array.from({ length: divisions + 1 }, (_, i)=> i / divisions);
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
  const stepX = series.length > 1 ? plotW / (series.length - 1) : plotW;

  const xAt = (i)=> padL + (series.length > 1 ? i * stepX : plotW / 2);
  const yAt = (v)=> padT + plotH - (v / yMax) * plotH;

  // A range wide enough to bucket everything into ONE interval is normal —
  // 24 hours auto-selects 15-minute buckets, so ten requests a minute apart
  // are a single point. An area chart cannot draw a single point: the polygon
  // gets two coordinates, encloses no area, and renders as nothing at all.
  // That is a blank chart on a page simultaneously reporting the traffic, so
  // one point is drawn as a stacked column instead.
  const single = series.length === 1;
  const barW = Math.min(plotW * 0.18, 90);
  const barX = xAt(0) - barW / 2;

  // Stacked bands, bottom-up in severity order so errors sit on top where
  // they are visible against the plot edge rather than buried under 2xx.
  const order = ['2xx', '3xx', '4xx', '5xx', 'unknown'];
  const running = series.map(()=>0);
  const bands = [];
  for(const fam of order){
    const lower = running.slice();
    series.forEach((p, i)=>{ running[i] += (p.statusBreakdown?.[fam] || 0); });
    if(running.every((v, i)=> v === lower[i])) continue; // family absent - no empty band
    if(single){
      const yTop = yAt(running[0]);
      const h = yAt(lower[0]) - yTop;
      if(h <= 0) continue;
      bands.push(`<rect class="obs-chart-bar" x="${barX}" y="${yTop}" width="${barW}" height="${h}"
        fill="${OBS_STATUS_COLORS[fam]}" opacity="0.75"></rect>`);
      continue;
    }
    const top = series.map((p, i)=> `${xAt(i)},${yAt(running[i])}`).join(' ');
    const bottom = lower.map((v, i)=> `${xAt(series.length - 1 - i)},${yAt(lower[series.length - 1 - i])}`).join(' ');
    bands.push(`<polygon points="${top} ${bottom}" fill="${OBS_STATUS_COLORS[fam]}" opacity="0.75"></polygon>`);
  }

  // Error rate on its own 0-100% axis. Drawn as a line, not a band, so it
  // reads as a rate rather than another volume. A one-point polyline draws
  // nothing for the same reason the polygon did, so a single bucket gets a
  // short horizontal segment across its column.
  const rateAt = (p)=>{
    const errs = (p.statusBreakdown?.['4xx'] || 0) + (p.statusBreakdown?.['5xx'] || 0);
    return p.total ? errs / p.total : 0;
  };
  const errPoints = single
    ? (()=>{ const y = padT + plotH - rateAt(series[0]) * plotH; return `${barX},${y} ${barX + barW},${y}`; })()
    : series.map((p, i)=> `${xAt(i)},${padT + plotH - rateAt(p) * plotH}`).join(' ');

  /* "Nothing happened" and "we were not watching" are different facts, and a
     zero-filled grid renders them identically - a flat line along the axis
     for both. Anything before collection started is therefore shaded and
     labelled as uncollected, so a quiet morning cannot be mistaken for an
     outage, or an agent that was not running yet for a quiet morning. */
  const coverageStart = o.coverageStart ? Date.parse(o.coverageStart) : NaN;
  let uncollected = '';
  if(isFinite(coverageStart) && series.length > 1){
    const firstTs = Date.parse(series[0].ts);
    const lastTs = Date.parse(series[series.length - 1].ts);
    if(coverageStart > firstTs && lastTs > firstTs){
      const frac = Math.min(1, (coverageStart - firstTs) / (lastTs - firstTs));
      const w = plotW * frac;
      if(w > 1){
        // The hatch is defined inline rather than in the stylesheet: an SVG
        // paint server has to exist in the document to be referenced, and
        // only one traffic chart is on screen at a time, so it travels with
        // the chart that uses it.
        uncollected = `<defs>
            <pattern id="obsHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" class="obs-chart-hatch-line"></line>
            </pattern>
          </defs>
          <rect x="${padL}" y="${padT}" width="${w}" height="${plotH}"
            class="obs-chart-uncollected"></rect>
          ${w > 150 ? `<text x="${padL + w / 2}" y="${padT + plotH / 2}"
            class="obs-chart-uncollected-label">not collected yet</text>` : ''}`;
      }
    }
  }

  const gridLines = obsGridFractions(yMax).map(f=>{
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
    // A zero here means one of two different things; say which.
    const before = isFinite(coverageStart) && Date.parse(p.ts) < coverageStart;
    const title = before
      ? `${when}\nNot collected — the agent was not reporting this environment yet`
      : p.total === 0
        ? `${when}\nNo requests`
        : `${when}\n${p.total.toLocaleString()} request(s)${latency}\n${parts.join(' · ') || 'no responses classified'}\nerror rate ${rate}%`;
    const w = Math.max(stepX, 2);
    return `<rect x="${xAt(i) - w / 2}" y="${padT}" width="${w}" height="${plotH}"
      class="obs-chart-hover" data-obs-point="${i}"><title>${escapeHtml(title)}</title></rect>`;
  }).join('');

  // Axis labels are chosen to be DIFFERENT from one another. A 24-hour range
  // holding one 15-minute bucket printed "10:00" at both ends, which reads as
  // a broken axis rather than as a narrow slice of data.
  let firstLabel = obsTimeLabel(series[0].ts, spanMs);
  let lastLabel = obsTimeLabel(series[series.length - 1].ts, spanMs);
  if(!single && firstLabel === lastLabel){
    firstLabel = obsTimeLabel(series[0].ts, 0);
    lastLabel = obsTimeLabel(series[series.length - 1].ts, 0);
  }
  const midIdx = Math.floor(series.length / 2);
  let midLabel = series.length > 2 ? obsTimeLabel(series[midIdx].ts, spanMs) : '';
  if(midLabel === firstLabel || midLabel === lastLabel) midLabel = '';
  const axis = single
    ? `<div class="obs-chart-axis obs-chart-axis-single"><span>${escapeHtml(firstLabel)}</span></div>`
    : `<div class="obs-chart-axis">
        <span>${escapeHtml(firstLabel)}</span>
        ${midLabel ? `<span>${escapeHtml(midLabel)}</span>` : ''}
        <span>${escapeHtml(lastLabel)}</span>
      </div>`;

  return `<div class="obs-chart-wrap">
    <svg viewBox="0 0 ${width} ${height}" class="obs-chart" preserveAspectRatio="none" role="img"
         aria-label="Requests over time by status family, with error rate">
      ${uncollected}
      ${gridLines}
      ${bands.join('')}
      <polyline points="${errPoints}" class="obs-chart-errline"></polyline>
      ${hoverCols}
    </svg>
    ${axis}
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
  const rows = keys.map((k, i)=>{
    const c = counts[i];
    if(!c) return '';
    // The bar IS the percentage printed beside it. It used to be drawn
    // relative to the largest band instead, so two bands of 1 and 2 drew as
    // 50% and 100% while the labels read 33.3% and 66.7% - the picture and
    // the number disagreeing, in the same row, a centimetre apart.
    const share = Math.round((c / total) * 1000) / 10;
    const pct = share;
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
