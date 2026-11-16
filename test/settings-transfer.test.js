'use strict';
// 설정 옮기기 (v0.29.0) 단위 테스트:  npm test
// [쉽게 말하면] 옮길 설정 고르기 · 파일 모양 · 비밀번호 암호화(PBKDF2 + AES-GCM) · 바뀌는 것 목록 · 라이브러리 합치기 · 앱/확장 연결을 봅니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ST = require('../src/shared/settings-transfer');
const P = require('../src/shared/prompt-lib');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const state = {
  selected: ['gemini', 'chatgpt'], layout: 'grid', synthTarget: 'chatgpt', autoSynth: false, answerTimeoutMin: 20, historyMax: 500,
  notify: { round: true, limit: false }, sendPreview: false, retryOnce: true, autoRecommend: false, commitOffer: true, lang: 'en',
  local: { enabled: true, baseUrl: 'http://localhost:11434', model: 'qwen', contextTokens: 8192 },
  projectRoot: 'C:\\secret', rects: [], services: [], remote: {},
};

test('옮길 설정: 정해 둔 칸만 (프로젝트 · 패널 위치 · 원격 상태는 빼고), 모양이 틀린 값은 버림', () => {
  const s = ST.pickSettings(state);
  assert.deepEqual(Object.keys(s).sort(), [...ST.KEYS].sort());
  assert.ok(!('projectRoot' in s));
  const c = ST.cleanSettings({ selected: ['gemini', 'Bad Id', 'gemini'], layout: 'GRID', autoSynth: 'yes', historyMax: -1, notify: { round: 1, limit: true, '<x>': true }, local: { enabled: true, baseUrl: 5, extra: 1 } });
  assert.deepEqual(c, { selected: ['gemini'], notify: { limit: true }, local: { enabled: true } });
  assert.deepEqual(ST.cleanSettings(null), {});
});

test('파일 모양: 내보낸 글을 그대로 읽고, 기록 · 변수 값 · 켠 스킬은 넣지 않으며, 다른 파일은 거절', () => {
  const lib = P.normalizeLibrary({ templates: [{ id: 'u-1', name: 'T', text: '{q}' }], skills: [{ id: 's-1', name: 'S', body: 'b' }], lastVars: { 'u-1': { a: 'b' } }, activeSkills: ['s-1'], presets: [{ name: 'P' }] });
  const out = ST.buildExport({ settings: ST.pickSettings(state), library: lib, app: 'app', appVersion: '0.29.0', now: 0 });
  const text = JSON.stringify(out);
  assert.ok(!text.includes('lastVars') && !text.includes('activeSkills') && !text.includes('"history"') && !text.includes('"records"') && !text.includes('secret'));
  const back = ST.parseFile(text);
  assert.equal(back.encrypted, false);
  assert.equal(back.data.library.presets.length, 1);
  assert.equal(back.data.settings.local.model, 'qwen');
  assert.equal(back.data.app, 'app');
  const code = (fn) => {
    try {
      fn();
    } catch (e) {
      return e.code;
    }
    return null;
  };
  assert.equal(code(() => ST.parseFile('nope')), 'json');
  assert.equal(code(() => ST.parseFile('{"kind":"other"}')), 'kind');
  assert.equal(code(() => ST.parseFile(JSON.stringify({ ...out, version: 9 }))), 'version');
  assert.equal(code(() => ST.parseFile('x'.repeat(6 * 1024 * 1024))), 'size');
});

test('암호화: PBKDF2-SHA256 25만 번 + AES-GCM, 무작위 salt/iv, 맞는 비밀번호로만 풀린다', async () => {
  const plain = JSON.stringify(ST.buildExport({ settings: { layout: 'row' }, library: {} }));
  const a = await ST.encrypt(plain, 'correct horse');
  const b = await ST.encrypt(plain, 'correct horse');
  const env = JSON.parse(a);
  assert.equal(env.kind, ST.ENC_KIND);
  assert.deepEqual([env.kdf.name, env.kdf.hash, env.cipher.name], ['PBKDF2', 'SHA-256', 'AES-GCM']);
  assert.ok(env.kdf.iterations >= 200000);
  assert.notEqual(JSON.parse(b).kdf.salt, env.kdf.salt);
  assert.ok(!a.includes('row')); // 글이 그대로 보이지 않는다
  const parsed = ST.parseFile(a);
  assert.equal(parsed.encrypted, true);
  const data = await ST.decrypt(parsed.envelope, 'correct horse');
  assert.equal(data.settings.layout, 'row');
  await assert.rejects(ST.decrypt(parsed.envelope, 'wrong pass'), (e) => e.code === 'password');
  const tampered = { ...env, data: env.data.slice(0, -4) + (env.data.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
  await assert.rejects(ST.decrypt(tampered, 'correct horse'), (e) => e.code === 'password');
  await assert.rejects(ST.decrypt({ ...env, kdf: { ...env.kdf, iterations: 1000 } }, 'correct horse'), (e) => e.code === 'kind'); // 너무 적은 반복은 거절
  await assert.rejects(ST.encrypt(plain, 'short'), (e) => e.code === 'password');
});

test('바뀌는 것: 파일에 있는 칸 중 지금과 다른 것만 (로컬 LLM · 알림은 칸끼리 합쳐 비교)', () => {
  const d = ST.diffSettings(state, { layout: 'row', synthTarget: 'chatgpt', local: { model: 'llama' }, notify: { round: true } });
  assert.deepEqual(d.map((x) => x.key), ['layout', 'local']);
  assert.equal(d[0].from, 'grid');
  assert.deepEqual(ST.diffSettings(state, {}), []);
});

test('라이브러리 합치기: 덮어쓰기 · 둘 다 남기기, 한도 검사, 프리셋은 지금 스킬도 참고', () => {
  const cur = P.normalizeLibrary({ templates: [{ id: 'u-1', name: 'T', text: 'old' }], skills: [{ id: 's-1', name: 'S', body: 'old' }] });
  const inc = { templates: [{ id: 'u-1', name: 'T', text: 'new' }, { id: 'u-2', name: 'T2', text: 'x' }], skills: [{ id: 's-1', name: 'S', body: 'new' }], presets: [{ id: 'p-1', name: 'P', skills: ['s-1'] }] };
  assert.deepEqual(ST.conflicts(cur, inc), { total: 2, templates: 1, skills: 1, presets: 0 });
  const ow = ST.mergeLibrary(cur, inc, { mode: 'overwrite', normalize: P.normalizeLibrary, newId: P.newId });
  assert.equal(ow.lib.templates.length, 2);
  assert.equal(ow.lib.templates[0].text, 'new');
  assert.equal(ow.lib.skills[0].body, 'new');
  assert.deepEqual(ow.counts.templates, { added: 1, replaced: 1, copied: 0 });
  assert.deepEqual(ow.lib.presets[0].skills, ['s-1']);
  const kb = ST.mergeLibrary(cur, inc, { mode: 'keepBoth', normalize: P.normalizeLibrary, newId: P.newId, copyName: (n) => `${n} (가져옴)` });
  assert.equal(kb.lib.templates.length, 3);
  assert.equal(kb.lib.templates[0].text, 'old');
  assert.equal(kb.lib.skills[1].name, 'S (가져옴)');
  assert.notEqual(kb.lib.skills[1].id, 's-1');
  const full = P.normalizeLibrary({ skills: Array.from({ length: 50 }, (_, i) => ({ id: `s-${i}`, name: 'x', body: 'b' })) });
  const over = ST.mergeLibrary(full, { skills: [{ id: 's-new', name: 'n', body: 'b' }] }, { normalize: P.normalizeLibrary, newId: P.newId });
  assert.equal(over.lib.skills.length, 50);
  assert.equal(over.dropped, 1);
});

test('연결: 설정 화면 · 가져오기 창 · 앱 저장(file:save mla) · 확장 다운로드 · 빌드 목록', () => {
  const html = read('src/renderer/index.html');
  for (const id of ['id="transferExport"', 'id="transferImport"', 'id="transferModal"', 'name="transferMode"', 'src="../shared/settings-transfer.js"', 'src="settings-transfer-ui.js"']) assert.ok(html.includes(id), id);
  assert.match(read('src/main/ipc/history.js'), /mla: \{ nameKey: 'main\.save\.mla', ext: 'mla\.json'/);
  assert.match(read('extension/host.js'), /mla: 'application\/json'/);
  const ui = read('src/renderer/settings-transfer-ui.js');
  assert.match(ui, /host\.saveFile\(\{ name: .*kind: 'mla' \}\)/);
  assert.match(ui, /host\.local\.setPrefs\(s\.local\)/); // 설정은 기존 창구로 (본체가 다시 검사)
  assert.match(ui, /PL\.normalizeLibrary/);
  assert.match(read('src/shared/settings-transfer.js'), /\[쉽게 말하면\]/);
});
