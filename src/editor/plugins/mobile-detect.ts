export function isMobileTouch(): boolean {
  if (typeof window === 'undefined') return false;

  // Primary signal: touch-only device (coarse pointer, no fine pointer)
  if (typeof matchMedia === 'function') {
    const coarse = matchMedia('(pointer: coarse)').matches;
    const fine = matchMedia('(pointer: fine)').matches;
    if (coarse && !fine) return true;
  }

  // Fallback: touch capability + narrow viewport (catches iOS Safari edge cases
  // where pointer media queries may not report as expected)
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const narrowViewport = window.innerWidth <= 900;
  return hasTouch && narrowViewport;
}
