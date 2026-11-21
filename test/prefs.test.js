'use strict';
// 설정 다듬기 · 보내기 옵션 검사 (shared/prefs.js, v0.40.1) 단위 테스트:  npm test
// [쉽게 말하면]
//   - 예전 설정(없어진 서비스 · 이상한 값)을 Windows 앱과 확장이 똑같이 고치는지
//   - 로컬 LLM 설정을 합칠 때 이 PC 주소가 아니면 거절하는지
//   - 보내기 옵션에서 모르는 항목은 버리고, 로컬 LLM 패널 몫(스킬 지침 · 본문)은 남기는지
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../src/shared/prefs');
const L = require('../src/shared/local-llm');
const { SERVICES, DEFAULT_SELECTED } = require('../src/shared/services');

test('normalizePrefs: 없어진 서비스 · 이상한 값은 기본값으로, 켜 둔 로컬 패널은 다시 넣는다', () => {
  const saved = {
    selected: ['groq', 'poe', 'chatgpt', 'local', 'local-3'],
    local: { enabled: true, panels: 2, baseUrl: 'http://localhost:11434' },
    layout: 'nope',
    synthTarget: 'poe',
    historyMax: 7,
    historyArchive: 'yes',
    retryOnce: undefined,
    recommendOrder: 'x',
    lang: 'fr',
  };
  const p = P.normalizePrefs({ ...saved }, saved);
  assert.deepEqual(p.selected, ['chatgpt', 'grok', 'local']); // groq → grok, poe 버림, local-3은 패널 수(2) 밖
  assert.equal(p.layout, 'grid');
  assert.equal(p.synthTarget, 'chatgpt');
  assert.equal(p.historyArchive, false);
  assert.equal(p.retryOnce, true);
  assert.equal(p.recommendOrder, 'completion');
  assert.equal(p.lang, 'auto');
  assert.equal(p.onboarded, true); // 예전부터 쓰던 사람
});

test('normalizePrefs: 로컬 LLM을 끄면 로컬 패널은 빠지고, 비면 기본 선택', () => {
  const p = P.normalizePrefs({ selected: ['local'], local: { enabled: false } }, null);
  assert.deepEqual(p.selected, DEFAULT_SELECTED);
  assert.equal(p.onboarded, false); // 새로 설치
});

test('mergeLocalPrefs: 안 바꾼 칸은 그대로, 바깥 주소는 거절', () => {
  const cur = L.normalizeLocalPrefs({ enabled: false, model: 'a', panels: 2, extraModels: ['b', ''] });
  const m = L.mergeLocalPrefs(cur, { enabled: true, model: 'c' });
  assert.equal(m.enabled, true);
  assert.equal(m.model, 'c');
  assert.equal(m.panels, 2);
  assert.deepEqual(m.extraModels, ['b', '']);
  assert.equal(L.mergeLocalPrefs(cur, { baseUrl: 'https://example.com' }), null);
  assert.deepEqual(L.mergeLocalPrefs(cur, null), cur);
});

test('cleanSendOpts: 아는 항목만, 길이 자르기, 로컬 패널 몫은 남긴다', () => {
  const ids = [...SERVICES.map((s) => s.id), 'local'];
  const o = P.cleanSendOpts(
    {
      question: 'q'.repeat(30000),
      prefixById: { local: 'skill', chatgpt: 's'.repeat(30000), evil: 'x' },
      textById: { local: 'body', 'local-2': 'off' },
      plainIds: ['local', 'nope'],
      userFileCount: -1,
      noHistory: true,
      project: { name: '  my-proj  ', path: 'C:\\secret' },
      extra: 'drop me',
    },
    ids,
  );
  assert.equal(o.question.length, 20000);
  assert.deepEqual(Object.keys(o.prefixById).sort(), ['chatgpt', 'local']);
  assert.equal(o.prefixById.local, 'skill');
  assert.equal(o.prefixById.chatgpt.length, 25000);
  assert.deepEqual(o.textById, { local: 'body' }); // 켜지 않은 local-2는 버린다
  assert.deepEqual(o.plainIds, ['local']);
  assert.equal(o.userFileCount, undefined);
  assert.equal(o.noHistory, true);
  assert.deepEqual(o.project, { name: 'my-proj' });
  assert.equal(o.extra, undefined);
  assert.deepEqual(P.cleanSendOpts(null, ids), {});
  assert.deepEqual(P.cleanSendOpts([1], ids), {});
});

test('Windows 앱과 확장이 같은 규칙을 쓴다 (예전 복사본이 남아 있지 않음)', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const main = read('src/main/main.js');
  const host = read('extension/host.js');
  assert.match(main, /normalizePrefs\(prefs, saved\)/);
  assert.match(host, /MLA\.prefs\.normalizePrefs\(/);
  assert.match(main, /cleanSendOpts\(opts, allServices\(\)/);
  assert.match(host, /MLA\.prefs\.cleanSendOpts\(opts, allServices\(\)/);
  for (const src of [main, host, read('src/main/ipc/settings.js')]) assert.doesNotMatch(src, /next\.contextTokens === undefined/);
  assert.match(read('extension/app.html'), /<script src="lib\/shared\/prefs\.js"><\/script>[\s\S]*<script src="host\.js"><\/script>/);
});
