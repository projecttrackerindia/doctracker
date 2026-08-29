(function () {
  const THEME_KEY = 'apiStudio_theme'; // same key used by the main API Studio app
  const stored = localStorage.getItem(THEME_KEY);
  const theme = stored === 'light' || stored === 'dark' ? stored : 'dark';
  document.documentElement.setAttribute('data-theme', theme);

  window.__toggleAuthTheme = function () {
    const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(THEME_KEY, next);
    document.querySelectorAll('[data-theme-icon]').forEach((el) => {
      el.style.display = el.getAttribute('data-theme-icon') === next ? 'none' : 'block';
    });
  };

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-theme-icon]').forEach((el) => {
      el.style.display = el.getAttribute('data-theme-icon') === theme ? 'none' : 'block';
    });
  });
})();
