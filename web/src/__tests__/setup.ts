import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

// jsdom has no layout observers; the photo sheets and the album use them.
class NoObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
globalThis.ResizeObserver ??= NoObserver as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver ??= NoObserver as unknown as typeof IntersectionObserver;
