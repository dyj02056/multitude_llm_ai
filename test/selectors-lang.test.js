'use strict';
// 셀렉터 언어 짝 (v0.25.0) 단위 테스트:  npm test
// [쉽게 말하면] 화면 글(aria-label · title · placeholder)에 기대는 셀렉터를 서비스 · 항목마다 모아,
// 한국어 화면용이 있으면 영어 화면용도 있고 그 반대도 맞는지, 로그아웃 · 한도 문구 정규식이 두 언어를 다 찾는지 봅니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const { SERVICES, DEFAULT_LIMIT_TEXT } = require('../src/shared/services');
const services = require('../src/shared/services');

const FIELDS = ['input', 'send', 'stop', 'response'];
const HANGUL = /[가-힣]/;
// 언어와 상관없는 이름 (서비스 · 제품 이름)
const BRANDS = /^(grok|gemini|claude|chatgpt|qwen|mistral|perplexity|deepseek|genspark)$/i;
const ATTR = /\[(?:aria-label|title|placeholder)\s*[*^$|~]?=\s*"([^"]*)"(?:\s*i)?\]/g;

/** 셀렉터 목록에서 글에 기대는 것만 → { ko: [셀렉터], en: [셀렉터] } */
function textSelectors(list) {
  const out = { ko: [], en: [] };
  for (const sel of list || []) {
    for (const m of sel.matchAll(ATTR)) {
      const v = m[1].trim();
      if (!v || BRANDS.test(v)) continue;
      if (HANGUL.test(v)) out.ko.push(sel);
      else if (/[A-Za-z]/.test(v)) out.en.push(sel);
    }
  }
  return out;
}

test('글에 기대는 셀렉터는 서비스 · 항목마다 한국어와 영어 짝이 있다', () => {
  let counted = 0;
  const listed = {};
  for (const svc of SERVICES) {
    for (const f of FIELDS) {
      const { ko, en } = textSelectors(svc[f]);
      if (!ko.length && !en.length) continue;
      counted += ko.length + en.length;
      listed[`${svc.id}.${f}`] = { ko, en };
      assert.ok(en.length, `${svc.id}.${f}: 한국어 셀렉터(${ko.join(' | ')})에 영어 짝이 없습니다`);
      assert.ok(ko.length, `${svc.id}.${f}: 영어 셀렉터(${en.join(' | ')})에 한국어 짝이 없습니다`);
    }
  }
  assert.ok(counted >= 30, JSON.stringify(listed)); // 목록이 비어 테스트가 저절로 통과하지 않게
  const attached = textSelectors(services.uploadOf({}).attached);
  assert.ok(attached.ko.length && attached.en.length, '첨부 확인 표시');
});

test('로그아웃 · 사용 한도 문구 정규식은 두 언어를 다 찾는다', () => {
  for (const svc of SERVICES) {
    const text = svc.loggedOut?.text;
    if (!text) continue;
    const re = new RegExp(text, 'i');
    assert.ok(re.test('로그인'), `${svc.id}: 로그인`);
    assert.ok(['log in', 'login', 'sign in', 'signin'].some((w) => re.test(w)), `${svc.id}: log in / sign in`);
  }
  const limit = new RegExp(DEFAULT_LIMIT_TEXT, 'i');
  assert.ok(limit.test('You have reached your usage limit'));
  assert.ok(limit.test('사용량 한도에 도달했습니다'));
});

test('언어 짝을 더한 서비스: 구조 셀렉터가 여전히 맨 앞', () => {
  const by = Object.fromEntries(SERVICES.map((s) => [s.id, s]));
  assert.equal(by.qwen.send[0], '#send-message-button');
  assert.equal(by.zai.send[0], '#send-message-button');
  assert.equal(by.zai.stop[0], '#stop-response-button');
  assert.equal(by.genspark.send[0], '.input-icon.enter-icon');
  assert.equal(by.chatgpt.send[0], 'button[data-testid="send-button"]');
  assert.equal(by.gemini.send.at(-1), 'button.send-button:not(.stop)'); // 순서는 바꾸지 않았다
});
