(() => {
  const button = document.querySelector('[data-menu-button]');
  const menu = document.querySelector('[data-mobile-menu]');
  const header = document.querySelector('[data-header]');
  const year = document.querySelector('[data-year]');
  const desktop = window.matchMedia('(min-width: 821px)');
  const assistantForm = document.querySelector('[data-hero-assistant-form]');
  const assistantInput = document.querySelector('[data-hero-assistant-input]');

  const closeMenu = () => {
    if (!button || !menu) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', 'Open navigation');
    document.body.style.overflow = '';
  };

  const openMenu = () => {
    if (!button || !menu) return;
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-label', 'Close navigation');
    document.body.style.overflow = 'hidden';
    menu.querySelector('a')?.focus();
  };

  const routeAssistantQuery = (rawQuery) => {
    const query = rawQuery.trim();
    if (!query) {
      assistantInput?.focus();
      return;
    }

    const normalized = query.toLowerCase();
    const academyTerms = ['training', 'course', 'certification', 'certify', 'exam', 'academy', 'learning', 'lab', 'comptia', 'cisco'];
    const storeTerms = ['buy', 'price', 'pricing', 'license', 'licence', 'microsoft 365', 'software', 'hardware', 'product', 'store', 'subscription', 'dell'];

    if (academyTerms.some((term) => normalized.includes(term))) {
      window.location.href = `https://www.skunkworksacademy.com/courses?q=${encodeURIComponent(query)}`;
      return;
    }

    if (storeTerms.some((term) => normalized.includes(term))) {
      window.location.href = `https://store.skunkworks.africa/search?q=${encodeURIComponent(query)}`;
      return;
    }

    const subject = `Skunkworks enquiry: ${query}`;
    const body = `I need help with: ${query}\n\nPlease route this to the appropriate Skunkworks Africa capability.`;
    window.location.href = `mailto:sales@skunkworks.africa?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  button?.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') === 'true';
    open ? closeMenu() : openMenu();
  });

  menu?.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });
  desktop.addEventListener?.('change', (event) => {
    if (event.matches) closeMenu();
  });

  assistantForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    routeAssistantQuery(assistantInput?.value || '');
  });

  document.querySelectorAll('[data-assistant-prompt]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const prompt = chip.getAttribute('data-assistant-prompt') || '';
      if (assistantInput) assistantInput.value = prompt;
      routeAssistantQuery(prompt);
    });
  });

  window.addEventListener('scroll', () => {
    if (!header) return;
    header.dataset.scrolled = String(window.scrollY > 24);
  }, { passive: true });

  if (year) year.textContent = String(new Date().getFullYear());
})();
