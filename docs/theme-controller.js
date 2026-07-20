(function attachOsmosisDemoThemes(globalScope, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (globalScope) globalScope.OsmosisDemoThemes = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  'use strict';

  const THEMES = Object.freeze(['warm', 'buddy', 'classic']);
  const THEME_DETAILS = Object.freeze({
    warm: Object.freeze({ colorScheme: 'light', themeColor: '#fff7ea' }),
    buddy: Object.freeze({ colorScheme: 'light', themeColor: '#d3dddd' }),
    classic: Object.freeze({ colorScheme: 'dark', themeColor: '#080c18' })
  });
  const STORAGE_KEY = 'osmosis-demo-theme';

  function isTheme(value) {
    return typeof value === 'string' && THEMES.includes(value);
  }

  function readStoredTheme(storage) {
    try {
      return storage && typeof storage.getItem === 'function' ? storage.getItem(STORAGE_KEY) : null;
    } catch {
      return null;
    }
  }

  function resolveTheme({ search = '', storage } = {}) {
    const queryTheme = new URLSearchParams(search).get('theme');
    if (isTheme(queryTheme)) return queryTheme;
    const storedTheme = readStoredTheme(storage);
    return isTheme(storedTheme) ? storedTheme : 'warm';
  }

  function applyTheme({ documentRef, theme }) {
    const nextTheme = isTheme(theme) ? theme : 'warm';
    const root = documentRef.documentElement;
    const details = THEME_DETAILS[nextTheme];
    root.dataset.theme = nextTheme;
    root.style.colorScheme = details.colorScheme;
    const metaTheme = documentRef.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute('content', details.themeColor);
    documentRef.querySelectorAll('[data-theme-choice]').forEach((button) => {
      const selected = button.dataset.themeChoice === nextTheme;
      button.setAttribute('aria-pressed', String(selected));
    });
    return nextTheme;
  }

  function writeStoredTheme(storage, theme) {
    try {
      if (storage && typeof storage.setItem === 'function') storage.setItem(STORAGE_KEY, theme);
    } catch {
      // Storage can be unavailable for a local file or a privacy-restricted browser.
    }
  }

  function initialize({ documentRef, locationSearch = '', storage } = {}) {
    const selected = applyTheme({ documentRef, theme: resolveTheme({ search: locationSearch, storage }) });
    documentRef.querySelectorAll('[data-theme-choice]').forEach((button) => {
      button.addEventListener('click', () => {
        const chosen = button.dataset.themeChoice;
        if (!isTheme(chosen)) return;
        applyTheme({ documentRef, theme: chosen });
        writeStoredTheme(storage, chosen);
      });
    });
    return selected;
  }

  return Object.freeze({
    STORAGE_KEY,
    THEMES,
    THEME_DETAILS,
    applyTheme,
    initialize,
    isTheme,
    readStoredTheme,
    resolveTheme,
    writeStoredTheme
  });
});
