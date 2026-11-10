async function check() {
  const state = document.getElementById('state');
  state.textContent = 'Checking service…';
  try {
    const response = await fetch('/healthz', { cache: 'no-store' });
    const health = await response.json();
    state.textContent = response.ok && health.status === 'ok'
      ? 'Service is responding.' : 'Service is unavailable.';
  } catch { state.textContent = 'Service is unavailable.'; }
  document.getElementById('checked').textContent = `Checked ${new Date().toLocaleString()}`;
}
document.getElementById('retry').addEventListener('click', check);
check();
