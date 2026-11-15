'use strict';
// 사이드탭 한 번 누르기 질문 · 이 페이지에서 전에 물어본 것 (v0.29.0) 단위 테스트:  npm test
// [쉽게 말하면] 페이지 언어 어림 · 번역 방향 · 주소 정리(# · utm_* 빼기) · 같은 페이지 기록 찾기 · 사이드탭 화면 연결을 봅니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SP = require('../src/shared/side-panel');
const { t } = require('../src/shared/i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('페이지 언어 어림: 한글이 글자의 30% 이상이면 ko', () => {
  assert.equal(SP.detectLang('이번 분기 AI 반도체 수출이 30% 늘었다'), 'ko');
  assert.equal(SP.detectLang('Exports of AI chips rose 30% this quarter'), 'en');
  assert.equal(SP.detectLang('Le marché a progressé'), 'en');
  assert.equal(SP.detectLang('1234 !!'), 'en');
});

test('한 번 누르기 질문: 종류마다 문구, 번역은 한국어 페이지 → 영어 · 그 밖 → 한국어', () => {
  assert.equal(SP.quickPrompt('summary', null, t), t('side.quick.summaryPrompt'));
  assert.equal(SP.quickPrompt('keypoints', null, t), t('side.quick.keypointsPrompt'));
  assert.equal(SP.quickPrompt('explain', null, t), t('side.quick.explainPrompt'));
  assert.equal(SP.quickPrompt('translate', { text: '한국어 기사 본문입니다' }, t), t('side.quick.translateToEn'));
  assert.equal(SP.quickPrompt('translate', { text: 'An English article' }, t), t('side.quick.translateToKo'));
  assert.equal(SP.quickPrompt('weird', null, t), '');
  for (const k of SP.QUICK) assert.ok(SP.quickPrompt(k, { text: 'x' }, t).length > 10, k);
});

test('주소 정리: # 뒤 · utm_* · 광고 클릭 id를 빼고 나머지 쿼리는 남긴다', () => {
  assert.equal(SP.normalizePageUrl('https://News.Example.com/a/b?id=3&utm_source=x&fbclid=1#top'), 'https://news.example.com/a/b?id=3');
  assert.equal(SP.normalizePageUrl('https://x.com/p?utm_medium=a'), 'https://x.com/p');
  assert.equal(SP.normalizePageUrl('chrome://settings'), '');
  assert.equal(SP.normalizePageUrl('not a url'), '');
});

test('전에 물어본 것: 같은 페이지(정리한 주소) 기록만, 최신부터, 답이 있는 AI만', () => {
  const recs = [
    { id: 'r1', at: 1, question: '요약', page: { url: 'https://a.com/x?utm_source=t' }, answers: { gemini: { md: '세 줄' }, claude: { state: 'send-error' } } },
    { id: 'r2', at: 5, question: '번역', page: { url: 'https://a.com/x#sec' }, answers: {} },
    { id: 'r3', at: 9, question: '다른', page: { url: 'https://a.com/y' }, answers: {} },
    { id: 'r4', at: 9, question: '페이지 없음', answers: {} },
  ];
  const got = SP.recallFor(recs, 'https://a.com/x');
  assert.deepEqual(got.map((x) => x.id), ['r2', 'r1']);
  assert.deepEqual(got[1].answers, [{ id: 'gemini', text: '세 줄' }]);
  assert.deepEqual(SP.recallFor(recs, ''), []);
});

test('연결: 사이드탭 화면에 i18n · 한 번 누르기 단추 · 전에 물어본 것 줄, 페이지 내용은 새로 저장하지 않음', () => {
  const html = read('extension/sidepanel.html');
  assert.ok(html.indexOf('lib/shared/i18n.js') < html.indexOf('sidepanel.js'));
  for (const k of SP.QUICK) assert.ok(html.includes(`data-quick="${k}"`), k);
  assert.ok(html.includes('id="spRecall"'));
  const js = read('extension/sidepanel.js');
  assert.match(js, /SP\.recallFor\(sideHistory\.all\(\)/);
  assert.match(js, /SP\.quickPrompt\(kind, ctx, t\)/);
  assert.ok(!/storage\.local\.set\(\{\s*'?(recall|pageText)/.test(js));
});
