/* Canonical toast() — previously reimplemented independently on 4 pages
   (studio.html, editor.html, architecture-studio.html, release-pipeline.html)
   with drifting timeouts (2600/2800/2800/3200ms) and, on release-pipeline.html,
   no shared CSS class at all (inline styles built by hand). One DOM node,
   created lazily on first use, styled by the shared .toast/.toast.show rules
   in /css/components.css. Pages call the same global toast(msg) they already
   did — no call-site changes needed. */
(function(){
  function ensureToastEl(){
    let t = document.getElementById('toast');
    if(!t){
      t = document.createElement('div');
      t.id = 'toast';
      t.className = 'toast';
      document.body.appendChild(t);
    }
    return t;
  }
  window.toast = function toast(msg){
    const t = ensureToastEl();
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(()=>t.classList.remove('show'), 2800);
  };
})();
