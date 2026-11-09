/* MCP documentation: canonical mobile navigation behavior without product-query routing. */
(()=>{
  const button=document.querySelector('[data-menu-button]');
  const menu=document.querySelector('[data-mobile-menu]');
  const desktop=window.matchMedia('(min-width: 821px)');
  const closeMenu=()=>{
    if(!button||!menu)return;
    menu.hidden=true;
    button.setAttribute('aria-expanded','false');
    button.setAttribute('aria-label','Open navigation');
    document.body.style.overflow='';
  };
  const openMenu=()=>{
    if(!button||!menu)return;
    menu.hidden=false;
    button.setAttribute('aria-expanded','true');
    button.setAttribute('aria-label','Close navigation');
    document.body.style.overflow='hidden';
    menu.querySelector('a')?.focus();
  };
  button?.addEventListener('click',()=>button.getAttribute('aria-expanded')==='true'?closeMenu():openMenu());
  menu?.querySelectorAll('a').forEach(a=>a.addEventListener('click',closeMenu));
  document.addEventListener('keydown',event=>{if(event.key==='Escape')closeMenu()});
  desktop.addEventListener?.('change',event=>{if(event.matches)closeMenu()});
})();