/* Set the saved light/dark/system choice before CSS is rendered on every page. */
(() => {
  const valid = new Set(['system', 'light', 'dark']);
  let theme = 'system';
  try {
    const match = document.cookie.match(/(?:^|;\s*)skunkworks-theme=([^;]+)/);
    const value = match ? decodeURIComponent(match[1]) : window.localStorage.getItem('skunkworks-theme');
    if (valid.has(value)) theme = value;
  } catch (_) {
    // Storage may be restricted. Default to the device preference.
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
