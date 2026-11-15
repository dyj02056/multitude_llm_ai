'use strict';
// 보내기 계획 · 보내기 전 미리보기 (v0.25.0) 단위 테스트:  npm test
// [쉽게 말하면] 미리보기에 보여 주는 "AI마다 넣을 글 · 파일"이 rounds.sendAll이 실제로 보내는 것과 같은지,
// 글자 수 · 받지 않는 파일 · 한도 경고가 맞는지, 화면 연결(Shift+클릭 · 설정 · 확장 파일 목록)이 됐는지 확인합니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SP = require('../src/shared/send-plan');
const { createRounds } = require('../src/shared/rounds');

const ROOT = path.join(__dirname, '..');
const file = (name, type, size) => ({ name, type, size, data: new ArrayBuffer(Math.min(size, 8)) });

test('planSend: 스킬 지침 + 서비스별 글, 예비 글, 보내지 않을 서비스는 직접 올린 파일만', () => {
  const files = [file('a.png', 'image/png', 10), file('project.md', 'text/markdown', 20)];
  const plan = SP.planSend('질문', ['x', 'y', 'z'], files, {
    prefixById: { x: '[스킬]\n', z: 5 },
    textById: { y: '본문으로 넣은 맥락 + 질문' },
    fallbackText: '예비',
    plainIds: ['z'],
    userFileCount: 1,
  });
  assert.deepEqual(
    plan.map((p) => [p.id, p.text, p.files.map((f) => f.name), p.fallbackText]),
    [
      ['x', '[스킬]\n질문', ['a.png', 'project.md'], '[스킬]\n예비'],
      ['y', '본문으로 넣은 맥락 + 질문', ['a.png', 'project.md'], '예비'],
      ['z', '질문', ['a.png'], undefined],
    ],
  );
  assert.deepEqual(SP.planSend('', ['x'], [], {})[0].text, '');
});

test('preview: 글자 수 · 프로젝트 파일 구분 · 받지 않는 종류 · 큰 파일 · 긴 글 경고', () => {
  const files = [file('me.pdf', 'application/pdf', 100), file('big.md', 'text/markdown', 9e6)];
  const services = [
    { id: 'g', name: 'Gemini', accept: ['image', 'document'], maxFileBytes: 5e6 },
    { id: 'd', name: 'Duck.ai', accept: ['image'], maxFileBytes: 25e6 },
  ];
  const long = 'x'.repeat(SP.LONG_TEXT + 1);
  const [g, d] = SP.preview(long, ['g', 'd'], files, { userFileCount: 1 }, services, { maxFiles: 10, maxFileBytes: 25e6 });
  assert.equal(g.name, 'Gemini');
  assert.equal(g.chars, SP.LONG_TEXT + 1);
  assert.deepEqual(g.files.map((f) => [f.name, f.project, f.sent]), [['me.pdf', false, true], ['big.md', true, true]]);
  assert.deepEqual(g.warnings.map((w) => w.code), ['long', 'big']);
  assert.equal(g.warnings[1].vars.names, 'big.md');
  assert.deepEqual(d.warnings.map((w) => w.code), ['long', 'skipped']);
  assert.equal(d.files.filter((f) => f.sent).length, 0);
  const [e] = SP.preview('', ['d'], [file('a.pdf', 'application/pdf', 1)], {}, services);
  assert.deepEqual(e.warnings.map((w) => w.code), ['skipped', 'empty']);
  const many = Array.from({ length: 11 }, (_, i) => file(`${i}.png`, 'image/png', 1));
  assert.deepEqual(SP.preview('q', ['g'], many, {}, services)[0].warnings.map((w) => w.code), ['many']);
  assert.equal(SP.preview('q', ['unknown'], [], {}, services)[0].name, 'unknown');
});

test('rounds.sendAll은 미리보기와 같은 계산으로 보낸다', async () => {
  const sent = [];
  const rounds = createRounds({
    services: [{ id: 'x', name: 'X' }, { id: 'z', name: 'Z' }],
    hasPanel: () => true,
    sendPrompt: async (id, text, files, extra) => (sent.push([id, text, files.map((f) => f.name), extra.fallbackText]), { ok: true }),
    snapshot: async () => null,
    watch: () => {},
    sendPanel: () => {},
    sendSynthStatus: () => {},
    history: { add: () => 'h', setAnswer: () => {}, addSynth: () => {} },
    prefs: () => ({}),
    log: () => {},
  });
  const files = [file('a.png', 'image/png', 10), file('p.md', 'text/markdown', 10)];
  const opts = { prefixById: { x: 'S:' }, fallbackText: 'F', plainIds: ['z'], userFileCount: 1 };
  await rounds.sendAll('Q', ['x', 'z'], files, opts);
  const plan = SP.planSend('Q', ['x', 'z'], files, opts);
  assert.deepEqual(
    sent,
    plan.map((p) => [p.id, p.text, p.files.map((f) => f.name), p.fallbackText]),
  );
});

test('화면 연결: 미리보기 창 · Shift+클릭 · 설정 · 확장 화면 파일 목록', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const html = read('src/renderer/index.html');
  for (const id of ['previewModal', 'previewBody', 'previewSend', 'previewCancel', 'sendPreviewToggle']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.indexOf('../shared/send-plan.js') < html.indexOf('<script src="renderer.js">'));
  assert.ok(html.indexOf('<script src="renderer-compose.js">') < html.indexOf('<script src="send-preview.js">'));
  const compose = read('src/renderer/renderer-compose.js');
  assert.match(compose, /send\(\{ preview: e\.shiftKey \}\)/);
  assert.match(compose, /window\.openSendPreview\(payload, ids\)/);
  assert.match(compose, /onProjectSendCanceled/);
  assert.match(read('src/renderer/project.js'), /window\.onProjectSendCanceled = /);
  const app = read('extension/app.html');
  assert.ok(app.includes('lib/renderer/send-preview.js'));
  assert.ok(app.includes('lib/shared/send-plan.js'));
});
