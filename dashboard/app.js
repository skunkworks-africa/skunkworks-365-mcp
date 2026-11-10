import { PublicClientApplication } from '@azure/msal-browser';

const $ = id => document.getElementById(id);
let client, account, settings;
function notice(message, error = false) { $('notice').textContent = message; $('notice').className = `notice${error ? ' error' : ''}`; }
function rows(container, items, label, value) {
  container.replaceChildren();
  if (!items?.length) { const p = document.createElement('p'); p.className = 'small'; p.textContent = 'No results available.'; container.append(p); return; }
  const list = document.createElement('ul');
  for (const item of items) {
    const row = document.createElement('li'); row.className = 'row';
    const name = document.createElement('span'); name.textContent = label(item);
    const detail = document.createElement('strong'); detail.textContent = value(item);
    row.append(name, detail); list.append(row);
  }
  container.append(list);
}
async function token() {
  try { return (await client.acquireTokenSilent({ account, scopes: [settings.scope] })).accessToken; }
  catch { return (await client.acquireTokenPopup({ account, scopes: [settings.scope], redirectUri: settings.redirectUri })).accessToken; }
}
async function get(path) {
  const response = await fetch(path, { headers: { Authorization: `Bearer ${await token()}` }, cache: 'no-store' });
  if (!response.ok) throw new Error(response.status === 403 ? 'Your account is not approved for this dashboard.' : 'The dashboard could not load this data.');
  return response.json();
}
async function refresh() {
  const id = $('tenant').value;
  if (!id) return;
  $('refresh').disabled = true; notice('Loading live Microsoft 365 data…');
  try {
    const data = await get(`/dashboard/api/tenant/${encodeURIComponent(id)}/summary`);
    rows($('services'), data.health?.status === 'ok' ? data.health.items : [], x => x.service || x.id || 'Service', x => x.status || 'Unknown');
    rows($('licences'), data.licences?.status === 'ok' ? data.licences.items : [], x => x.skuPartNumber || 'SKU', x => `${x.consumedUnits ?? '—'} assigned · ${x.prepaidUnits?.enabled ?? '—'} enabled`);
    $('updated').textContent = `Last refreshed ${new Date().toLocaleString()}`;
    notice(data.health?.status === 'ok' || data.licences?.status === 'ok' ? 'Live read complete.' : 'Microsoft 365 data is not available for this tenant.', !(data.health?.status === 'ok' || data.licences?.status === 'ok'));
  } catch (error) { notice(error.message, true); }
  finally { $('refresh').disabled = false; }
}
async function signIn() {
  $('signin').disabled = true;
  try {
    const result = await client.loginPopup({ scopes: [settings.scope], redirectUri: settings.redirectUri, prompt: 'select_account' });
    account = result.account;
    const data = await get('/dashboard/api/tenants');
    $('tenant').replaceChildren();
    for (const tenant of data.tenants || []) {
      const option = document.createElement('option'); option.value = tenant.id; option.textContent = tenant.name;
      $('tenant').append(option);
    }
    if (!$('tenant').options.length) { notice('Your account has no approved tenants.', true); return; }
    $('entry').hidden = true; $('workspace').hidden = false; $('signout').hidden = false;
    await refresh();
  } catch (error) { notice(error.message || 'Sign-in was cancelled or access was denied.', true); }
  finally { $('signin').disabled = false; }
}
async function main() {
  try {
    const response = await fetch('/dashboard/config.json', { cache: 'no-store' });
    settings = await response.json();
    if (!settings.enabled) { notice('Dashboard sign-in is awaiting an approved Microsoft app registration.'); return; }
    client = new PublicClientApplication({
      auth: { clientId: settings.clientId, authority: `https://login.microsoftonline.com/${settings.tenantId}`, redirectUri: settings.redirectUri },
      cache: { cacheLocation: 'memoryStorage' }
    });
    await client.initialize();
    $('entry').hidden = false; notice('Sign in to see your approved tenants.');
    $('signin').addEventListener('click', signIn);
    $('refresh').addEventListener('click', refresh);
    $('tenant').addEventListener('change', refresh);
    $('signout').addEventListener('click', async () => {
      try { await client.logoutPopup({ account, postLogoutRedirectUri: settings.redirectUri }); }
      finally { account = undefined; $('workspace').hidden = true; $('signout').hidden = true; $('entry').hidden = false; notice('Signed out.'); }
    });
  } catch (error) { console.error('Dashboard setup failed', error); notice('Dashboard setup could not load.', true); }
}
main();
