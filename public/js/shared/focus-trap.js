/* Generic Tab-focus containment for whichever modal dialog is currently
   open. There was previously no focus trap anywhere in the app — Tab could
   carry focus out of an open modal into the page behind it. Every modal
   already toggles visible through one of a small number of shared idioms
   (.modal-overlay.show, .ai-overlay:not(.hidden)), so this watches those
   directly instead of requiring each modal's own open/close function to
   register itself — zero per-modal call-site changes. */
(function(){
  const OPEN_SELECTORS = ['.modal-overlay.show', '.ai-overlay:not(.hidden)', '.insp-fullscreen-overlay.show'];
  const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function currentModal(){
    for(const sel of OPEN_SELECTORS){
      const el = document.querySelector(sel);
      if(el) return el;
    }
    return null;
  }

  document.addEventListener('keydown', function(e){
    if(e.key !== 'Tab') return;
    const modal = currentModal();
    if(!modal) return;

    const focusables = Array.from(modal.querySelectorAll(FOCUSABLE))
      .filter(el => el.offsetParent !== null);
    if(focusables.length === 0) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if(!modal.contains(document.activeElement)){
      e.preventDefault();
      first.focus();
    } else if(e.shiftKey && document.activeElement === first){
      e.preventDefault();
      last.focus();
    } else if(!e.shiftKey && document.activeElement === last){
      e.preventDefault();
      first.focus();
    }
  }, true);
})();
