(function () {
  const THEME_KEY = 'apiStudio_theme'; // same key used by the main API Studio app
  const stored = localStorage.getItem(THEME_KEY);
  const theme = stored === 'light' || stored === 'dark' ? stored : 'dark';
  document.documentElement.setAttribute('data-theme', theme);

  function toggleAuthTheme() {
    const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(THEME_KEY, next);
    document.querySelectorAll('[data-theme-icon]').forEach((el) => {
      el.style.display = el.getAttribute('data-theme-icon') === next ? 'none' : 'block';
    });
  }

  // No inline onclick here on purpose — the CSP has no 'unsafe-inline' for
  // scriptSrc, so inline event handler attributes are silently blocked by
  // the browser. Wire the button up from here instead, once it exists.
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-theme-icon]').forEach((el) => {
      el.style.display = el.getAttribute('data-theme-icon') === theme ? 'none' : 'block';
    });
    document.querySelectorAll('.theme-toggle').forEach((btn) => {
      btn.addEventListener('click', toggleAuthTheme);
    });
  });
})();
