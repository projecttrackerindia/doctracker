/* Shared by the Studio (server/views/studio.html) and the endpoint editor
   (server/views/editor.html) so the two can never disagree about what a
   version or a review status means.

   Versions
     Every endpoint and every project carries an X.Y.Z version that the
     editor bumps automatically on each save (see performSave in
     editor.html). Patch is the default; the editor lets you pick Minor or
     Major for a single save.
       ep.version    — bumps every time THIS endpoint is saved
       proj.version  — bumps every time ANYTHING in the project is saved
     Legacy data stored one project-wide value (and copied it onto the
     endpoint), so currentVersion() falls back ep -> project -> 1.0.0.

   Security-review sign-off (Google SecOps / VAPT / Common Log Management)
     Used to be a boolean (ep.secOpsReviewed / ep.vaptReviewed). Now a
     status — none | in_review | approved | findings — stored per kind as
     ep.<kind>Status, plus who/when it last changed (ep.<kind>StatusBy /
     ep.<kind>StatusAt). The old boolean is still written (true only when
     approved) so an older build reading the same record keeps working, and
     reviewStatusOf() reads it when the new field is absent, so existing
     "ticked" endpoints show as Approved. Add a new kind by adding one entry
     to REVIEW_KINDS below — editor.html's review rows are driven generically
     off Object.keys(REVIEW_ROOTS)/['secOps','vapt','logMgmt'], not hardcoded
     per kind.
*/
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------- versions ---------------- */
  var INITIAL_VERSION = '1.0.0';
  var BUMP_LEVELS = [
    { id: 'patch', label: 'Patch', title: 'Edits and fixes (1.0.0 → 1.0.1)' },
    { id: 'minor', label: 'Minor', title: 'Backward-compatible additions (1.0.0 → 1.1.0)' },
    { id: 'major', label: 'Major', title: 'Breaking changes (1.0.0 → 2.0.0)' }
  ];

  // "v1", "1.2", "1.2.3", "v1.2.3-beta" → [major, minor, patch]. Anything
  // that doesn't start with a number falls back to 1.0.0 rather than
  // throwing, so a free-text legacy value can never block a save.
  function parseVersion(v) {
    var m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i.exec(String(v == null ? '' : v));
    if (!m) return [1, 0, 0];
    return [parseInt(m[1], 10), parseInt(m[2] || '0', 10), parseInt(m[3] || '0', 10)];
  }
  function bumpVersion(v, level) {
    var p = parseVersion(v);
    if (level === 'major') return (p[0] + 1) + '.0.0';
    if (level === 'minor') return p[0] + '.' + (p[1] + 1) + '.0';
    return p[0] + '.' + p[1] + '.' + (p[2] + 1);
  }
  // What to show for an endpoint: its own version, else the project's
  // (legacy data), else the initial version.
  function currentVersion(ep, proj) {
    var e = ep && typeof ep.version === 'string' ? ep.version.trim() : '';
    var p = proj && typeof proj.version === 'string' ? proj.version.trim() : '';
    return e || p || INITIAL_VERSION;
  }
  function versionPillHtml(v, muted) {
    return '<span class="dm-ver' + (muted ? ' dm-ver-muted' : '') + '">' + (v ? 'v' + esc(String(v).replace(/^v/i, '')) : '—') + '</span>';
  }

  /* ---------------- review status ---------------- */
  var REVIEW_STATUSES = [
    { id: 'none',      label: 'Not started',   tone: 'none', title: 'No review has been started' },
    { id: 'in_review', label: 'In review',     tone: 'warn', title: 'Review is under way' },
    { id: 'approved',  label: 'Approved',      tone: 'ok',   title: 'Review completed and signed off' },
    { id: 'findings',  label: 'Findings open', tone: 'bad',  title: 'Review raised findings that are not yet resolved' }
  ];
  var REVIEW_BY_ID = {};
  REVIEW_STATUSES.forEach(function (s) { REVIEW_BY_ID[s.id] = s; });
  var REVIEW_KINDS = {
    secOps:  { label: 'Google SecOps', full: 'Google SecOps review' },
    vapt:    { label: 'VAPT',          full: 'VAPT review' },
    logMgmt: { label: 'Log Mgmt',      full: 'Common Log Management review' }
  };

  function reviewStatusOf(ep, kind) {
    if (!ep) return 'none';
    var s = ep[kind + 'Status'];
    if (REVIEW_BY_ID[s]) return s;
    return ep[kind + 'Reviewed'] ? 'approved' : 'none';
  }
  function fmtWhen(iso) {
    if (!iso) return '';
    if (typeof global.formatDateTime === 'function') return global.formatDateTime(iso);
    try { return new Date(iso).toLocaleString(); } catch (e) { return String(iso); }
  }
  // "Approved — by Prasanna · 20 Sep 2026, 5:14 pm" (or just the label when
  // there's nothing recorded, e.g. legacy ticked endpoints).
  function reviewTooltip(ep, kind) {
    var id = reviewStatusOf(ep, kind), st = REVIEW_BY_ID[id];
    var by = ep && ep[kind + 'StatusBy'], at = ep && ep[kind + 'StatusAt'];
    var tip = REVIEW_KINDS[kind].full + ': ' + st.label;
    if (id !== 'none' && (by || at)) {
      tip += ' — ' + [by ? 'by ' + by : '', at ? fmtWhen(at) : ''].filter(Boolean).join(' · ');
    }
    return tip;
  }
  function reviewChipHtml(ep, kind) {
    var st = REVIEW_BY_ID[reviewStatusOf(ep, kind)];
    return '<span class="dm-chip dm-t-' + st.tone + '" title="' + esc(reviewTooltip(ep, kind)) + '">' +
      '<span class="dm-dot dm-t-' + st.tone + '"></span>' + esc(st.label) + '</span>';
  }

  /* ---------------- endpoint lifecycle status ---------------- */
  // Separate from review status above (that's "has this been security-
  // reviewed"; this is "is this endpoint's own build finished"). Stored as
  // ep.status — a plain string so a value this list doesn't know about
  // (an older/newer build, hand-edited data) still renders instead of
  // throwing, just as a neutral "Other" chip carrying its own raw text.
  var ENDPOINT_STATUSES = [
    { id: 'active',          label: 'Active',             tone: 'ok',   title: 'Live and ready to use' },
    { id: 'in_development',  label: 'Under development',  tone: 'info', title: 'Still being built — shape may still change' },
    { id: 'in_review',       label: 'Under review',       tone: 'warn', title: 'Built, awaiting sign-off before general use' },
    { id: 'no_consumers',    label: 'No consumers yet',   tone: 'purple', title: 'Live and working, but not yet integrated by any source system' },
    { id: 'deprecated',      label: 'Deprecated',         tone: 'bad',  title: 'Still present but should not be used for new integrations' }
  ];
  var ENDPOINT_STATUS_BY_ID = {};
  ENDPOINT_STATUSES.forEach(function (s) { ENDPOINT_STATUS_BY_ID[s.id] = s; });
  var DEFAULT_ENDPOINT_STATUS = 'active';

  // Endpoints saved before this field existed have no ep.status at all —
  // treat that the same as "Active" rather than showing a blank/unknown chip.
  function endpointStatusOf(ep) {
    var s = ep && ep.status;
    return s && ENDPOINT_STATUS_BY_ID[s] ? s : (s ? s : DEFAULT_ENDPOINT_STATUS);
  }
  function endpointStatusMeta(ep) {
    var id = endpointStatusOf(ep);
    return ENDPOINT_STATUS_BY_ID[id] || { id: id, label: id, tone: 'none', title: '' };
  }
  function endpointStatusChipHtml(ep) {
    var st = endpointStatusMeta(ep);
    return '<span class="dm-chip dm-t-' + st.tone + '"' + (st.title ? ' title="' + esc(st.title) + '"' : '') + '>' +
      '<span class="dm-dot dm-t-' + st.tone + '"></span>' + esc(st.label) + '</span>';
  }

  /* ---------------- source/target system pill ---------------- */
  // A single "Salesforce → Oracle DB" pill, used everywhere an endpoint's
  // integration direction needs to show at a glance (render view, overview
  // table). Omits itself entirely when neither side is set instead of
  // rendering an empty arrow.
  function systemFlowHtml(ep) {
    var src = ep && ep.sourceSystem ? String(ep.sourceSystem).trim() : '';
    var tgt = ep && ep.targetSystem ? String(ep.targetSystem).trim() : '';
    if (!src && !tgt) return '';
    var full = (src || '?') + ' → ' + (tgt || '?');
    return '<span class="dm-flow" title="' + esc(full) + '">' +
      '<span class="dm-flow-side">' + (src ? esc(src) : '<span class="dm-flow-empty">?</span>') + '</span>' +
      '<span class="dm-flow-arrow">→</span>' +
      '<span class="dm-flow-side">' + (tgt ? esc(tgt) : '<span class="dm-flow-empty">?</span>') + '</span>' +
      '</span>';
  }

  /* ---------------- segmented control ---------------- */
  // opts: { options:[{id,label,tone?,title?}], value, onChange(id, prev) }
  // onChange may return false to veto the change (the control stays put).
  function mountSegmented(root, opts) {
    var state = { value: opts.value, disabled: false };
    root.classList.add('dm-seg');
    root.setAttribute('role', 'radiogroup');

    function render() {
      root.classList.toggle('is-disabled', state.disabled);
      root.innerHTML = opts.options.map(function (o) {
        var on = o.id === state.value;
        return '<button type="button" role="radio" class="dm-seg-btn" data-id="' + esc(o.id) + '"' +
          ' aria-checked="' + on + '" tabindex="' + (on ? 0 : -1) + '"' +
          (state.disabled ? ' disabled' : '') +
          (o.title ? ' title="' + esc(o.title) + '"' : '') + '>' +
          (o.tone ? '<span class="dm-dot dm-t-' + esc(o.tone) + '"></span>' : '') + esc(o.label) + '</button>';
      }).join('');
    }
    function choose(id, focusAfter) {
      if (id === state.value) return;
      var prev = state.value;
      if (opts.onChange && opts.onChange(id, prev) === false) return;
      state.value = id;
      render();
      if (focusAfter) {
        var b = root.querySelector('[data-id="' + id + '"]');
        if (b) b.focus();
      }
    }
    root.addEventListener('click', function (e) {
      var b = e.target.closest('.dm-seg-btn');
      if (b && root.contains(b)) choose(b.getAttribute('data-id'), false);
    });
    root.addEventListener('keydown', function (e) {
      var dir = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      var ids = opts.options.map(function (o) { return o.id; });
      var next = ids[(ids.indexOf(state.value) + dir + ids.length) % ids.length];
      choose(next, true);
    });
    render();
    return {
      get: function () { return state.value; },
      set: function (v) { state.value = v; render(); },
      setDisabled: function (d) { state.disabled = !!d; render(); }
    };
  }

  global.DocMeta = {
    INITIAL_VERSION: INITIAL_VERSION,
    BUMP_LEVELS: BUMP_LEVELS,
    parseVersion: parseVersion,
    bumpVersion: bumpVersion,
    currentVersion: currentVersion,
    versionPillHtml: versionPillHtml,
    REVIEW_STATUSES: REVIEW_STATUSES,
    REVIEW_KINDS: REVIEW_KINDS,
    reviewStatusOf: reviewStatusOf,
    reviewTooltip: reviewTooltip,
    reviewChipHtml: reviewChipHtml,
    mountSegmented: mountSegmented,
    ENDPOINT_STATUSES: ENDPOINT_STATUSES,
    DEFAULT_ENDPOINT_STATUS: DEFAULT_ENDPOINT_STATUS,
    endpointStatusOf: endpointStatusOf,
    endpointStatusMeta: endpointStatusMeta,
    endpointStatusChipHtml: endpointStatusChipHtml,
    systemFlowHtml: systemFlowHtml
  };
})(window);
