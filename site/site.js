(() => {
  const { document, window, IntersectionObserver } = globalThis;
  if (!document || !window) return;
  const root = document.documentElement;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.dataset.motion = reduced ? 'reduced' : 'ready';

  const revealItems = [...document.querySelectorAll('[data-reveal]')];
  if (reduced || typeof IntersectionObserver !== 'function') {
    revealItems.forEach((item) => item.setAttribute('data-visible', 'true'));
  } else {
    const reveal = new IntersectionObserver(
      (entries, observer) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.setAttribute('data-visible', 'true');
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    );
    revealItems.forEach((item) => reveal.observe(item));
  }

  const download = document.querySelector('#download');
  const downloadLink = document.querySelector('[data-nav-target="download"]');
  if (download && downloadLink && typeof IntersectionObserver === 'function') {
    const sectionObserver = new IntersectionObserver(
      ([entry]) => downloadLink.toggleAttribute('aria-current', entry.isIntersecting),
      { threshold: 0.25 },
    );
    sectionObserver.observe(download);
  }
})();
