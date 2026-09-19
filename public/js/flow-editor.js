/* Request-flow builder — shared by the studio "Edit settings" modal
   (server/views/studio.html) and the full-page endpoint editor
   (server/views/editor.html), so the two can never drift apart again.

   Data model (stored on the project as proj.requestFlows):
     [{ id, name, when, direction: '1-way'|'2-way',
        stages: [{ k, systems[], icon, mid, next, back }] }]

   A "flow" is ONE left-to-right chain of boxes. A real integration is rarely
   one continuous chain — e.g. "get a token" (rare, cached 30 min), "send a
   business request" (every call) and "get the third-party token" (only when
   its cache is empty) are three separate exchanges that run at different
   times. Each is its own flow, with:
     name / when  — what it is and when it runs (shown above its diagram)
     stage.next   — label on the arrow leaving this stage toward the next one
     stage.back   — label on the return arrow (two-way flows only)

   Back-compat: projects saved before this existed only have the single-chain
   fields requestFlowDirection / requestFlowStages. load() turns those into one
   flow; applyToProject() keeps those legacy fields mirrored from flow 1 so an
   older build reading the same record still shows something sensible.

   Usage:
     const fe = FlowEditor.create({ root: document.getElementById('someDiv') });
     fe.load(proj);                       // populate (or fe.load({}) to clear)
     FlowEditor.applyToProject(proj, fe.collect());   // on save
*/
(function (global) {
  'use strict';

  var ICONS = [
    { id: 'client', label: 'Client' },
    { id: 'gateway', label: 'Gateway' },
    { id: 'flow', label: 'Flow / API' },
    { id: 'downstream', label: 'Downstream' },
    { id: 'custom', label: 'System (generic)' }
  ];

  // The token → request → third-party-token pattern, offered as a one-click
  // starting point when a project has no flows yet.
  var EXAMPLE = [
    {
      name: 'Get token A',
      when: 'About every 30 min — the source system caches token A and reuses it',
      direction: '2-way',
      stages: [
        { k: 'Source', systems: ['Source system'], icon: 'client', mid: false, next: 'Request token', back: 'Token A (30 min)' },
        { k: 'Token service', systems: ['MuleSoft'], icon: 'gateway', mid: true, next: '', back: '' }
      ]
    },
    {
      name: 'Business request',
      when: 'Every call — token A is validated before anything is forwarded',
      direction: '2-way',
      stages: [
        { k: 'Source', systems: ['Source system'], icon: 'client', mid: false, next: 'Payload + token A', back: 'Response' },
        { k: 'Gateway', systems: ['API gateway'], icon: 'gateway', mid: true, next: 'Payload + token B', back: 'Response' },
        { k: 'Target', systems: ['Third party'], icon: 'downstream', mid: false, next: '', back: '' }
      ]
    },
    {
      name: 'Get token B',
      when: 'Only when token B is missing or expired — cached until then',
      direction: '2-way',
      stages: [
        { k: 'Gateway', systems: ['API gateway'], icon: 'gateway', mid: true, next: 'Token B request', back: 'Token B' },
        { k: 'Target', systems: ['Third party token API'], icon: 'downstream', mid: false, next: '', back: '' }
      ]
    }
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() { return 'flow_' + Math.random().toString(36).slice(2, 9); }
  function str(v) { return typeof v === 'string' ? v : ''; }

  function normStage(s) {
    s = s || {};
    return {
      k: str(s.k),
      systems: Array.isArray(s.systems) ? s.systems.map(function (v) { return String(v); }) : [],
      icon: s.icon || 'custom',
      mid: !!s.mid,
      next: str(s.next),
      back: str(s.back)
    };
  }
  function normFlow(f) {
    f = f || {};
    return {
      id: f.id || uid(),
      name: str(f.name),
      when: str(f.when),
      direction: f.direction === '2-way' ? '2-way' : '1-way',
      stages: Array.isArray(f.stages) ? f.stages.map(normStage) : []
    };
  }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function flowsFromProject(proj) {
    proj = proj || {};
    if (Array.isArray(proj.requestFlows) && proj.requestFlows.length) return proj.requestFlows.map(normFlow);
    if (Array.isArray(proj.requestFlowStages) && proj.requestFlowStages.length) {
      // Legacy single chain -> flow 1. The old free-text caption (if the user
      // typed one) becomes the "when" line so it isn't silently lost.
      var cap = str(proj.requestFlowLabel).trim();
      if (/^(One-way|Two-way) — /.test(cap)) cap = '';
      return [normFlow({
        name: 'Request flow',
        when: cap,
        direction: proj.requestFlowDirection === '2-way' ? '2-way' : '1-way',
        stages: proj.requestFlowStages
      })];
    }
    return [];
  }

  function cleanFlows(flows) {
    return flows.map(function (f) {
      var two = f.direction === '2-way';
      var stages = f.stages.map(function (s) {
        return {
          k: s.k.trim(),
          systems: s.systems.map(function (v) { return v.trim(); }).filter(Boolean),
          icon: s.icon || 'custom',
          mid: !!s.mid,
          next: s.next.trim(),
          back: two ? s.back.trim() : ''
        };
      }).filter(function (s) { return s.k || s.systems.length; });
      if (stages.length) { stages[stages.length - 1].next = ''; stages[stages.length - 1].back = ''; }
      return { id: f.id, name: f.name.trim(), when: f.when.trim(), direction: f.direction, stages: stages };
    }).filter(function (f) { return f.stages.length; });
  }

  // Writes the flows onto a project record, keeping the legacy single-chain
  // fields mirrored from flow 1 (see header comment).
  function applyToProject(proj, flows) {
    proj.requestFlows = flows;
    if (flows.length) {
      proj.requestFlowDirection = flows[0].direction;
      proj.requestFlowStages = flows[0].stages.map(function (s) {
        return { k: s.k, systems: s.systems.slice(), icon: s.icon, mid: s.mid };
      });
    } else {
      // Everything was removed on purpose -> back to the default diagram.
      proj.requestFlowStages = [];
    }
  }

  function create(opts) {
    var root = opts.root;
    var flows = [];
    var radioGroup = 'fsrMid_' + Math.random().toString(36).slice(2, 7);

    function stageRow(f, fi, s, si) {
      var last = si === f.stages.length - 1;
      var two = f.direction === '2-way';
      var hops = last ? '' :
        '<div class="fsr-hops">' +
          '<div class="field"><label>Arrow to next stage <span class="fe-sub">— label</span></label>' +
            '<input type="text" data-f="next" value="' + esc(s.next) + '" placeholder="e.g. Payload + token A"></div>' +
          (two ? '<div class="field"><label>Return arrow <span class="fe-sub">— label</span></label>' +
            '<input type="text" data-f="back" value="' + esc(s.back) + '" placeholder="e.g. Response"></div>' : '') +
        '</div>';
      return '<div class="flow-stage-row" data-si="' + si + '">' +
        '<div class="fsr-fields">' +
          '<div class="field"><label>Role label</label>' +
            '<input type="text" data-f="k" value="' + esc(s.k) + '" placeholder="e.g. Source"></div>' +
          '<div class="field" style="flex:2;"><label>System(s) <span class="fe-sub">— comma-separated</span></label>' +
            '<input type="text" data-f="systems" value="' + esc(s.systems.join(', ')) + '" placeholder="e.g. Employee Portal, WhatsApp Payment Endpoint"></div>' +
          '<div class="field"><label>Icon</label><select data-f="icon">' +
            ICONS.map(function (o) { return '<option value="' + o.id + '"' + ((s.icon || 'custom') === o.id ? ' selected' : '') + '>' + o.label + '</option>'; }).join('') +
          '</select></div>' +
          hops +
        '</div>' +
        '<div class="fsr-side">' +
          '<label class="fsr-mid-label" title="Highlights this stage in the diagram — use it for your own system, e.g. the gateway or API">' +
            '<input type="radio" name="' + radioGroup + '_' + fi + '" data-f="mid"' + (s.mid ? ' checked' : '') + '> Highlight</label>' +
          '<div class="fsr-move-btns">' +
            '<button type="button" class="fsr-icon-btn" data-act="stage-up" title="Move left"' + (si === 0 ? ' disabled' : '') + '>◂</button>' +
            '<button type="button" class="fsr-icon-btn" data-act="stage-down" title="Move right"' + (last ? ' disabled' : '') + '>▸</button>' +
            '<button type="button" class="fsr-icon-btn danger" data-act="stage-remove" title="Remove stage">✕</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }

    function flowCard(f, fi) {
      return '<div class="fe-flow" data-fi="' + fi + '">' +
        '<div class="fe-flow-head">' +
          '<span class="fe-flow-num">' + (fi + 1) + '</span>' +
          '<div class="field fe-name-wrap"><input type="text" data-f="name" value="' + esc(f.name) + '" placeholder="Flow name, e.g. Get token A"></div>' +
          '<div class="field fe-dir-wrap"><select data-f="direction" title="One-way draws forward arrows only; two-way also draws a return arrow">' +
            '<option value="1-way"' + (f.direction === '1-way' ? ' selected' : '') + '>One-way</option>' +
            '<option value="2-way"' + (f.direction === '2-way' ? ' selected' : '') + '>Two-way</option>' +
          '</select></div>' +
          '<div class="fsr-move-btns">' +
            '<button type="button" class="fsr-icon-btn" data-act="flow-up" title="Move flow up"' + (fi === 0 ? ' disabled' : '') + '>▴</button>' +
            '<button type="button" class="fsr-icon-btn" data-act="flow-down" title="Move flow down"' + (fi === flows.length - 1 ? ' disabled' : '') + '>▾</button>' +
            '<button type="button" class="fsr-icon-btn danger" data-act="flow-remove" title="Remove this flow">✕</button>' +
          '</div>' +
        '</div>' +
        '<div class="field fe-when-wrap"><input type="text" data-f="when" value="' + esc(f.when) + '" placeholder="When does this run? e.g. About every 30 min — token is cached and reused"></div>' +
        '<div class="fe-stages">' + (f.stages.length
          ? f.stages.map(function (s, si) { return stageRow(f, fi, s, si); }).join('')
          : '<div class="empty-field">No stages yet — add the first system this flow starts from.</div>') +
        '</div>' +
        '<button type="button" class="fe-btn" data-act="stage-add">+ Add stage</button>' +
      '</div>';
    }

    function render() {
      var body = flows.length
        ? flows.map(flowCard).join('')
        : '<div class="empty-field">Not customized — the Overview shows the default Client → Gateway → Flow → Downstream diagram. Add a flow to describe your own.</div>';
      root.innerHTML = body +
        '<div class="fe-actions">' +
          '<button type="button" class="fe-btn" data-act="flow-add">+ Add flow</button>' +
          (flows.length ? '' : '<button type="button" class="fe-btn" data-act="example" title="Token → business request → third-party token">Insert example (3 flows)</button>') +
        '</div>';
    }

    function loc(el) {
      var fEl = el.closest('[data-fi]');
      var sEl = el.closest('[data-si]');
      return { fi: fEl ? +fEl.getAttribute('data-fi') : -1, si: sEl ? +sEl.getAttribute('data-si') : -1 };
    }
    function move(arr, i, d) {
      var j = i + d;
      if (j < 0 || j >= arr.length) return;
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }

    root.addEventListener('input', function (e) {
      var t = e.target;
      if (t.tagName !== 'INPUT' || t.type !== 'text') return;
      var f = t.getAttribute('data-f'); if (!f) return;
      var p = loc(t); var fl = flows[p.fi]; if (!fl) return;
      if (p.si < 0) { if (f === 'name' || f === 'when') fl[f] = t.value; return; }
      var st = fl.stages[p.si]; if (!st) return;
      if (f === 'systems') st.systems = t.value.split(',').map(function (v) { return v.trim(); }).filter(Boolean);
      else if (f === 'k' || f === 'next' || f === 'back') st[f] = t.value;
    });

    root.addEventListener('change', function (e) {
      var t = e.target;
      var f = t.getAttribute && t.getAttribute('data-f'); if (!f) return;
      var p = loc(t); var fl = flows[p.fi]; if (!fl) return;
      if (t.tagName === 'SELECT' && p.si < 0 && f === 'direction') {
        fl.direction = t.value === '2-way' ? '2-way' : '1-way';
        render(); // return-arrow fields appear/disappear with the direction
      } else if (t.tagName === 'SELECT' && p.si >= 0 && f === 'icon') {
        fl.stages[p.si].icon = t.value;
      } else if (t.type === 'radio' && f === 'mid') {
        fl.stages.forEach(function (s, j) { s.mid = (j === p.si); });
      }
    });

    root.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b || !root.contains(b) || b.disabled) return;
      var act = b.getAttribute('data-act');
      var p = loc(b); var fl = flows[p.fi];
      if (act === 'flow-add') {
        flows.push(normFlow({ name: '', direction: '1-way', stages: [{}, {}] }));
        flows[flows.length - 1].stages[0].icon = 'client';
        flows[flows.length - 1].stages[1].icon = 'downstream';
      }
      else if (act === 'example') flows = clone(EXAMPLE).map(normFlow);
      else if (act === 'flow-up') move(flows, p.fi, -1);
      else if (act === 'flow-down') move(flows, p.fi, 1);
      else if (act === 'flow-remove') flows.splice(p.fi, 1);
      else if (fl && act === 'stage-add') fl.stages.push(normStage({}));
      else if (fl && act === 'stage-up') move(fl.stages, p.si, -1);
      else if (fl && act === 'stage-down') move(fl.stages, p.si, 1);
      else if (fl && act === 'stage-remove') fl.stages.splice(p.si, 1);
      else return;
      render();
    });

    render();
    return {
      load: function (proj) { flows = flowsFromProject(proj); render(); },
      collect: function () { return cleanFlows(flows); }
    };
  }

  global.FlowEditor = { create: create, applyToProject: applyToProject, ICONS: ICONS };
})(window);
