'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', 'public');

function staticKeys(html) {
  return [...html.matchAll(/data-i18n(?:-aria)?="([a-z0-9_]+)"/g)].map((match) => match[1]);
}

test('every wall static phrase has Chinese and English UI copy instead of rendering its key', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.match(html, /<html lang="zh-CN">/);
  for (const key of staticKeys(html)) {
    const occurrences = app.match(new RegExp(`\\b${key}:`, 'g')) || [];
    assert.ok(occurrences.length >= 2, `${key} must be present in both UI locale dictionaries`);
  }
  assert.match(app, /studio_title: '一次只学一件有用的事。'/);
  assert.match(app, /studio_title: 'Learn one useful thing at a time.'/);
  assert.match(app, /ui_locale: 'zh-CN'/);
});
