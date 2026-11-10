'use strict';

// 스크린샷 도구 (v0.20.1): 장면 목록 · 테스트용 채팅 페이지 · 문서가 가리키는 그림이 모두 있는지
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const S = require('../scripts/screenshots/sample');

const ROOT = path.join(__dirname, '..');

test('테스트용 채팅 페이지: 글은 이스케이프하고, 실제 서비스가 아니라고 표시한다', () => {
  const html = S.chatPage('Gemini', '#4285f4', [{ role: 'user', text: '<script>alert(1)</script>' }, { role: 'ai', text: '| a | b |\n|---|---|\n| 1 | 2 |' }]);
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('테스트용 채팅 페이지'));
  assert.match(html, /<table><tr><th>a<\/th><th>b<\/th><\/tr><tr><td>1<\/td><td>2<\/td><\/tr><\/table>/);
});

test('장면마다 그림이 있고, README · docs가 가리키는 그림도 모두 있다', () => {
  const run = fs.readFileSync(path.join(ROOT, 'scripts', 'screenshots', 'run.js'), 'utf8');
  const scenes = [...run.matchAll(/name: '([\w-]+)', page:/g)].map((m) => m[1]);
  assert.ok(scenes.length >= 15, scenes.join(', '));
  for (const s of scenes) assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'screenshots', `${s}.png`)), s);
  const docs = ['README.md', ...fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];
  for (const d of docs) {
    const text = fs.readFileSync(path.join(ROOT, d), 'utf8');
    for (const m of text.matchAll(/screenshots\/([\w-]+\.png)/g)) assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'screenshots', m[1])), `${d}: ${m[1]}`);
  }
});

test('package.json에 npm run screenshots', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.screenshots, 'electron scripts/screenshots/run.js');
});
