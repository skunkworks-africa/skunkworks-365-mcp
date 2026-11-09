import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('root and docs pages stay identical for GitHub Pages sources',()=>assert.equal(read('index.html'),read('docs/index.html')));
test('root and docs brand bundles are identical',()=>{
  for(const path of ['styles.css','adaptive-shell.css','theme-init.js','site.js','mcp.css','mcp-site.js','assets/skunkworks-global-footer.css','assets/skunkworks-global-footer.js']) {
    assert.equal(read(path),read('docs/'+path),path);
  }
});
test('inherits black/white adaptive contract from canonical corporate styles',()=>{
  const css=read('styles.css'),shell=read('adaptive-shell.css');
  for(const token of ['--bg:#fff','--fg:#000','--bg:#000','--fg:#fff']) assert.ok(css.includes(token),token);
  assert.ok(shell.includes('--shell-bg:#000000'));
  assert.ok(shell.includes('--shell-bg:#ffffff'));
  assert.ok(read('index.html').includes('href="/adaptive-shell.css"'));
  assert.ok(read('index.html').includes('href="/styles.css"'));
});
test('brand navigation matches corporate ordering and shared global footer',()=>{
  const page=read('index.html');
  const nav=page.match(/<nav class="desktop-nav"[^>]*>([\s\S]*?)<\/nav>/)?.[1]||'';
  const names=[...nav.matchAll(/>(Solutions|Services|Academy|Skunkworks)<\/a>/g)].map(m=>m[1]);
  assert.deepEqual(names,['Solutions','Services','Academy','Skunkworks']);
  assert.ok(page.includes('https://www.skunkworks.africa/'));
  assert.ok(page.includes('https://store.skunkworks.africa/'));
  assert.ok(page.includes('data-skunkworks-footer-mount'));
  assert.ok(page.includes('skunkworks-global-footer.js'));
});
test('functional developer content and download links remain',()=>{
  const page=read('index.html');
  for(const name of ['quickstart','chatgpt','downloads','status','security']) assert.ok(page.includes('id="'+name+'"'),name);
  for(const text of ['npm run build','connector_unavailable','not a remote MCP endpoint','/archive/refs/heads/main.zip']) assert.ok(page.includes(text),text);
});

test('mobile navigation remains reachable on short screens',()=>{
  assert.match(read('mcp.css'),/max-height:calc\(100dvh - var\(--header\)\)/);
  assert.ok(read('mcp.css').includes('overflow-y:auto'));
});
test('inverted sections have contrasting keyboard focus',()=>{
  assert.ok(read('mcp.css').includes('.section-band :focus-visible,.cta :focus-visible{outline:3px solid var(--bg)'));
});
test('theme picker applies preferences when storage is disabled',()=>{
  const footer=read('assets/skunkworks-global-footer.js');
  assert.ok(footer.includes('try{localStorage.setItem('));
  assert.ok(footer.includes("catch(_){}try{if(location.hostname"));
});
test('page script does not duplicate corporate assistant routing',()=>{
  assert.ok(read('site.js').includes('data-menu-button'));
  assert.ok(!read('site.js').includes('routeAssistantQuery'));
});
