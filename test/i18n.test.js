'use strict';
// 화면 문구 다국어 틀 (v0.24.0) 단위 테스트:  npm test
// [쉽게 말하면] 한국어 · 영어 사전의 키 짝이 맞는지, {이름} 바꾸기 · 없는 키 · 언어 고르기가 맞는지 확인합니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const i18n = require('../src/shared/i18n');

test('한국어 · 영어 사전의 키가 짝이 맞고, 글이 비어 있지 않다', () => {
  assert.deepEqual(i18n.checkKeys().missing, { en: [], ko: [] });
  for (const lang of i18n.LANGS) {
    for (const [k, v] of Object.entries(i18n.strings[lang])) assert.ok(typeof v === 'string' && v.trim(), `${lang}:${k}`);
  }
});

test('영역별 사전(v0.30.0): 키는 그 영역 이름으로 시작하고, 어떤 키도 두 파일에 겹치지 않는다', () => {
  const dir = path.join(__dirname, '../src/shared');
  for (const lang of i18n.LANGS) {
    const seen = new Map();
    for (const f of fs.readdirSync(dir).filter((n) => new RegExp(`^i18n-${lang}(-[a-z]+)?\\.js$`).test(n))) {
      const area = (new RegExp(`^i18n-${lang}-([a-z]+)\\.js$`).exec(f) || [])[1];
      for (const k of Object.keys(require(path.join(dir, f)))) {
        assert.ok(!seen.has(k), `${k}: ${seen.get(k)} · ${f}`);
        seen.set(k, f);
        if (area) assert.ok(k.startsWith(`${area}.`), `${f}: ${k}`);
      }
    }
  }
});

test('두 언어에서 {이름} 자리가 같다', () => {
  const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const [k, ko] of Object.entries(i18n.strings.ko)) assert.deepEqual(holes(i18n.strings.en[k]), holes(ko), k);
});

test('t(): 지금 언어 → 한국어 → 키 이름 순, {이름}을 바꾸고 모르는 자리는 그대로', () => {
  i18n.setLang('en');
  assert.equal(i18n.t('settings.historyMaxOption', { n: 500 }), '500 records');
  assert.equal(i18n.t('no.such.key'), 'no.such.key');
  i18n.setLang('ko');
  assert.equal(i18n.t('settings.historyMaxOption', { n: 500 }), '500개');
  assert.equal(i18n.t('settings.historyMaxShrink', { n: 100 }).includes('{drop}'), true);
  assert.equal(i18n.setLang('fr'), 'ko');
});

test('detectLang: 설정값이 있으면 그것, auto면 한국어 브라우저만 ko', () => {
  assert.equal(i18n.detectLang('en', 'ko-KR'), 'en');
  assert.equal(i18n.detectLang('auto', 'ko-KR'), 'ko');
  assert.equal(i18n.detectLang('auto', 'en-US'), 'en');
  assert.equal(i18n.detectLang(undefined, ''), 'en');
});

test('화면(전역)에서도 사전 파일을 먼저 읽으면 MLA.i18n이 같은 글을 준다', () => {
  const ctx = { globalThis: null };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ['i18n-ko.js', 'i18n-en.js', 'i18n.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/shared', f), 'utf8'), ctx);
  }
  assert.equal(ctx.MLA.i18n.t('settings.historyMax'), '기록 최대 개수');
  ctx.MLA.i18n.setLang('en');
  assert.equal(ctx.MLA.i18n.t('settings.historyMax'), 'History size');
});

test('index.html이 사전 → i18n.js 순서로, 다른 공통 모듈보다 먼저 읽는다', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const at = (s) => html.indexOf(s);
  assert.ok(at('i18n-ko.js') > 0 && at('i18n-ko.js') < at('i18n.js"'));
  assert.ok(at('i18n.js"') < at('vendor/ignore.js'));
});
