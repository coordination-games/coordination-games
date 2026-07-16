import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function readPreference(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(QUERY).matches;
}

// React hook: true when the viewer has asked the OS to reduce motion. Board
// animation (the requestAnimationFrame repaint loop and travelling VFX) must be
// replaced by a static equivalent when this is true, never merely paused.
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(readPreference);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(QUERY);
    const onChange = () => setReduced(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

// Non-hook read for imperative canvas code that just needs the current value.
export function prefersReducedMotion(): boolean {
  return readPreference();
}
