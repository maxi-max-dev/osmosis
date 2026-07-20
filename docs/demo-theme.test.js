'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const themes = require('./theme-controller');

function fakeButton(theme) {
  const listeners = new Map();
  return {
    dataset: { themeChoice: theme },
    attributes: {},
    addEventListener(name, listener) { listeners.set(name, listener); },
    click() { listeners.get('click')?.(); },
    setAttribute(name, value) { this.attributes[name] = value; }
  };
}

function fakeDocument() {
  const buttons = ['warm', 'buddy', 'classic'].map(fakeButton);
  const root = { dataset: {}, style: {} };
  const meta = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  return {
    buttons,
    documentRef: {
      documentElement: root,
      querySelector(selector) { return selector === 'meta[name="theme-color"]' ? meta : null; },
      querySelectorAll(selector) { return selector === '[data-theme-choice]' ? buttons : []; }
    },
    meta,
    root
  };
}

test('demo theme gives a valid URL parameter priority without changing storage', () => {
  let reads = 0;
  let writes = 0;
  const storage = {
    getItem() { reads += 1; return 'classic'; },
    setItem() { writes += 1; }
  };
  const { documentRef } = fakeDocument();
  assert.equal(themes.initialize({ documentRef, locationSearch: '?theme=buddy', storage }), 'buddy');
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test('demo theme falls back to warm when storage is unavailable or invalid', () => {
  const unavailable = { getItem() { throw new Error('storage disabled'); } };
  assert.equal(themes.resolveTheme({ search: '', storage: unavailable }), 'warm');
  assert.equal(themes.resolveTheme({ search: '', storage: { getItem() { return 'neon'; } } }), 'warm');
});

test('switching static demo themes preserves replay state and never reloads', () => {
  const { buttons, documentRef, meta, root } = fakeDocument();
  const calls = [];
  const storage = { getItem() { return null; }, setItem(key, value) { calls.push([key, value]); } };
  const replayState = { cursor: 3, active: { answered: true, correct: true }, strengths: { rendering: 2 } };
  const before = structuredClone(replayState);

  assert.equal(themes.initialize({ documentRef, locationSearch: '?theme=warm', storage }), 'warm');
  buttons.find((button) => button.dataset.themeChoice === 'buddy').click();

  assert.deepEqual(replayState, before);
  assert.equal(root.dataset.theme, 'buddy');
  assert.equal(root.style.colorScheme, 'light');
  assert.equal(meta.attributes.content, '#d3dddd');
  assert.deepEqual(calls, [[themes.STORAGE_KEY, 'buddy']]);
  assert.equal(buttons.find((button) => button.dataset.themeChoice === 'buddy').attributes['aria-pressed'], 'true');
  assert.equal(buttons.find((button) => button.dataset.themeChoice === 'warm').attributes['aria-pressed'], 'false');
});

test('classic remains the original dark baseline and its theme metadata stays synchronized', () => {
  const { documentRef, meta, root } = fakeDocument();
  assert.equal(themes.applyTheme({ documentRef, theme: 'classic' }), 'classic');
  assert.equal(root.dataset.theme, 'classic');
  assert.equal(root.style.colorScheme, 'dark');
  assert.equal(meta.attributes.content, '#080c18');

  const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(page, /:root \{ color-scheme: dark;[^}]*background: #080c18; color: #eff4ff;/);
  assert.match(page, /html\[data-theme="classic"\]/);
});

test('static demo assets have no external, dynamic, or network-loaded dependencies', () => {
  for (const filename of ['index.html', 'theme-controller.js']) {
    const source = fs.readFileSync(path.join(__dirname, filename), 'utf8');
    assert.doesNotMatch(source, /@import\b/i, `${filename} must not import styles`);
    assert.doesNotMatch(source, /url\s*\(\s*['"]?https?:/i, `${filename} must not load a remote URL`);
    assert.doesNotMatch(source, /\b(?:fetch|import)\s*\(/, `${filename} must not make a network or dynamic-module request`);
    assert.doesNotMatch(source, /<script[^>]+src\s*=\s*['"]https?:/i, `${filename} must not load a remote script`);
  }
});

function contrastRatio(foreground, background) {
  function luminance(hex) {
    const channels = hex.slice(1).match(/../g).map((part) => Number.parseInt(part, 16) / 255);
    const linear = channels.map((value) => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
  }
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + .05) / (darker + .05);
}

test('all visible demo text meets 4.5:1 against its effective component background', () => {
  const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(page, /<button class="theme-choice" type="button" data-theme-choice="warm"/);
  assert.match(page, /<button class="theme-choice" type="button" data-theme-choice="buddy"/);
  assert.match(page, /<button class="theme-choice" type="button" data-theme-choice="classic"/);
  assert.match(page, /button:focus-visible/);
  assert.match(page, /@media \(prefers-reduced-motion: reduce\) \{ \.buddy-robot \{ animation: none; \} \}/);
  const effectivePairs = [
    ['warm body', '#26332e', '#fff7ea'],
    ['warm secondary/sidebar', '#606860', '#fff2dc'],
    ['warm secondary/carried-over panel', '#606860', '#fff1c9'],
    ['warm secondary/card and theme switcher', '#606860', '#fffdf8'],
    ['warm secondary/footer', '#606860', '#fff7ea'],
    ['warm no-api badge', '#176942', '#fff7ea'],
    ['warm carried-over badge', '#78500a', '#fff1c9'],
    ['warm carried-over snapshot', '#78500a', '#fffdf8'],
    ['warm default answer', '#26332e', '#fff2dc'],
    ['warm correct answer', '#176942', '#e2f7e9'],
    ['warm incorrect answer', '#a03945', '#ffe6e6'],
    ['warm primary button', '#ffffff', '#257e70'],
    ['warm disabled replay button', '#26332e', '#f5ead6'],
    ['buddy body', '#22383e', '#d3dddd'],
    ['buddy secondary/sidebar', '#45636a', '#e4ecec'],
    ['buddy secondary/carried-over panel', '#45636a', '#f5e5bd'],
    ['buddy secondary/card and theme switcher', '#45636a', '#f7fafa'],
    ['buddy secondary/footer', '#45636a', '#d3dddd'],
    ['buddy no-api badge', '#176741', '#d3dddd'],
    ['buddy carried-over badge', '#78500a', '#f5e5bd'],
    ['buddy carried-over snapshot', '#78500a', '#f7fafa'],
    ['buddy default answer', '#22383e', '#e4ecec'],
    ['buddy correct answer', '#176741', '#d8efe3'],
    ['buddy incorrect answer', '#963a3e', '#f6dfdd'],
    ['buddy primary button', '#ffffff', '#0e7d88'],
    ['buddy disabled replay button', '#22383e', '#dce7e7'],
    ['classic body', '#eff4ff', '#080c18'],
    ['classic secondary footer', '#7183a6', '#080c18'],
    ['classic note/sidebar', '#9aa9c8', '#080e1c'],
    ['classic answer button', '#dce6ff', '#0d182f'],
    ['classic disabled replay button', '#0b1327', '#94a8d8']
  ];
  for (const [label, foreground, background] of effectivePairs) {
    const ratio = contrastRatio(foreground, background);
    assert.ok(ratio >= 4.5, `${label} must meet 4.5:1; got ${ratio.toFixed(2)}:1`);
  }
  assert.match(page, /answers button:disabled[^}]*opacity: 1/);
  assert.doesNotMatch(page, /(?:window\.)?location\.reload\s*\(/);
});

test('warm embeds the shipped product token values without a runtime stylesheet dependency', () => {
  const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  for (const token of [
    '--demo-bg: #fff7ea', '--demo-surface: #fffdf8', '--demo-ink: #26332e',
    '--demo-accent: #ef7657', '--demo-teal: #257e70', '--demo-gold: #c9972e',
    '--demo-shadow: 0 22px 54px rgba(80, 58, 29, .12)', '--demo-focus: #265f9e'
  ]) assert.ok(page.includes(token), `warm must embed ${token}`);
  assert.doesNotMatch(page, /<link[^>]+styles\.css/i);
});

test('buddy presentation is a finite fixture projection, not a real-time simulation', () => {
  const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(page, /fixture\.entries\.slice\(0, 5\)/);
  assert.match(page, /Ready for recorded milestone/);
  assert.match(page, /All five recorded milestones are complete/);
  assert.doesNotMatch(page, /\b(?:setTimeout|setInterval|requestAnimationFrame)\s*\(/);
});
