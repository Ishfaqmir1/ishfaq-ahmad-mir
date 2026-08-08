/**
 * banner.js
 * ---------------------------------------------------------------------------
 * Behaviour for the custom "Banner" section (sections/banner.liquid).
 *
 * Vanilla JavaScript only (no jQuery, no external libraries).
 *
 * Responsibilities:
 *  - Scroll-reveal entrance animation: elements marked with [data-reveal]
 *    fade/slide into view once they enter the viewport (IntersectionObserver).
 *  - The class `.gift-banner--animate` is only added when JS runs, so the
 *    banner remains fully visible without JavaScript (progressive enhancement).
 *  - Respects the user's `prefers-reduced-motion` setting.
 * ---------------------------------------------------------------------------
 */

(() => {
  const sections = document.querySelectorAll('.gift-banner');

  // Bail out entirely when there is nothing to animate.
  if (sections.length === 0) return;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const supportsObserver = 'IntersectionObserver' in window;

  sections.forEach((section) => {
    const revealItems = section.querySelectorAll('[data-reveal]');
    if (revealItems.length === 0) return;

    // Without JS-driven animation (reduced motion or no IO support), just
    // leave the content visible.
    if (prefersReducedMotion || !supportsObserver) return;

    // Gate the hiding CSS behind this class so no-JS keeps content visible.
    section.classList.add('gift-banner--animate');

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      },
      {
        // Start revealing slightly before the element scrolls fully into view.
        rootMargin: '0px 0px -10% 0px',
        threshold: 0.15,
      }
    );

    revealItems.forEach((item) => observer.observe(item));
  });
})();
