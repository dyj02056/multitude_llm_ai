'use strict';
// 서비스 목록·보내기 대상별 첨부 (v0.7.0) 단위 테스트:  npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/shared/services');
const { createRounds } = require('../src/shared/rounds');

test('Claude · Z.ai: 서비스 주소와 로그인 화면', () => {
  const claude = S.SERVICES.find((s) => s.id === 'claude');
  const zai = S.SERVICES.find((s) => s.id === 'zai');
  assert.equal(S.isServiceUrl(claude, 'https://claude.ai/new'), true);
  assert.equal(S.isServiceUrl(claude, 'https://claude.ai.evil.example/'), false);
  assert.equal(S.isServiceUrl(zai, 'https://chat.z.ai/c/1'), true);
  assert.match('https://claude.ai/login?returnTo=%2Fnew', new RegExp(claude.loggedOut.url));
  assert.equal(zai.tokenBridge.preferCookie, true);
});

test('보내기: 프로젝트 파일을 보내지 않을 서비스(plainIds)에는 직접 올린 파일만', async () => {
  const sent = {};
  const r = createRounds({
    services: S.SERVICES,
    hasPanel: () => true,
    sendPrompt: async (id, text, files, extra) => {
      sent[id] = { text, files: files.map((f) => f.name), fallback: extra.fallbackText };
      return { ok: true, attach: { ok: true } };
    },
    snapshot: async () => null,
    watch: () => {},
    sendPanel: () => {},
    sendSynthStatus: () => {},
    history: { add: () => 1, setAnswer: () => {}, addSynth: () => {} },
    prefs: () => ({}),
    log: () => {},
  });
  const file = (name, type) => ({ name, type, size: 1, data: new ArrayBuffer(1) });
  await r.sendAll('맥락+질문', ['gemini', 'zai'], [file('mine.png', 'image/png'), file('project.md', 'text/markdown')], {
    textById: { zai: '질문' },
    fallbackText: '본문 맥락',
    plainIds: ['zai'],
    userFileCount: 1,
  });
  assert.deepEqual(sent.gemini, { text: '맥락+질문', files: ['mine.png', 'project.md'], fallback: '본문 맥락' });
  assert.deepEqual(sent.zai, { text: '질문', files: ['mine.png'], fallback: undefined });
});
