'use strict';
// 프로젝트 작업 이어 하기 · 바 쌓기 (v0.28.0) 단위 테스트:  npm test
// [쉽게 말하면]
//   - 이어 하기: 저장 모양(파일 내용 없음 · 한도), 같은 실행/다른 실행 · 패널 세대 · 대화 주소로 되살릴지 정하기
//   - 바 쌓기: 변경 바와 제안 바가 함께 뜨면 2줄 — 본체 · 확장이 웹페이지를 그만큼 줄인다
//   - 화면 · 본체 연결: 읽는 순서, 저장할 때 ctx, 새 대화에서 버리기
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const PS = require('../src/shared/project-session');
const L = require('../src/shared/layout');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const NOW = Date.UTC(2026, 10, 16);

test('대화 주소 열쇠: 대화 id가 있는 경로만, 처음 주소 · 쿼리 · 끝 / 는 무시', () => {
  assert.equal(PS.convKey('https://chatgpt.com/c/6720f1c2-8a3b-4cde-9f00-1234567890ab?model=x', ['https://chatgpt.com/']), 'chatgpt.com/c/6720f1c2-8a3b-4cde-9f00-1234567890ab');
  assert.equal(PS.convKey('https://claude.ai/new', ['https://claude.ai/new']), null);
  assert.equal(PS.convKey('https://claude.ai/new/', ['https://claude.ai/new']), null);
  assert.equal(PS.convKey('https://gemini.google.com/app', ['https://gemini.google.com/app']), null);
  assert.equal(PS.convKey('https://claude.ai/recents', []), null); // id처럼 보이지 않음
  assert.equal(PS.convKey('https://gemini.google.com/app/3f2a9c0d1e4b5a67', ['https://gemini.google.com/app']), 'gemini.google.com/app/3f2a9c0d1e4b5a67');
  assert.equal(PS.convKey('file:///c/x/123456789012', []), null);
  assert.equal(PS.convKey('not a url', []), null);
});

const sent = new Map([['a.js', { hash: 'h1', lines: 10 }], ['gone.js', null]]);
const rec = (over = {}) => PS.packPanel({ run: 'R1', epoch: '0', at: NOW, conv: 'cv', sent, tree: 't1', plan: { files: [{ path: 'a.js', note: 'x' }, { path: 'b.js' }], index: 1, status: 'running', got: ['a.js', 'zzz'] }, cont: { path: 'a.js', rounds: 2, waiting: true }, ...over });

test('저장 모양: 지문 · 경로만, 계획은 목록 · 위치 · 받은 경로, 한도', () => {
  const r = rec();
  assert.deepEqual(r.sent, [['a.js', 'h1', 10], ['gone.js', null]]);
  assert.deepEqual(r.plan, { files: [{ path: 'a.js', note: 'x' }, { path: 'b.js', note: '' }], index: 1, status: 'running', got: ['a.js'] });
  assert.deepEqual(r.cont, { path: 'a.js', rounds: 2, waiting: true });
  assert.ok(!JSON.stringify(r).includes('function'));
  const big = PS.packPanel({ run: 'R', sent: new Map(Array.from({ length: 5000 }, (_, i) => [`f${i}.js`, { hash: 'h', lines: 1 }])), plan: { files: Array.from({ length: 500 }, (_, i) => ({ path: `p${i}` })), index: 9999 } });
  assert.equal(big.sent.length, PS.MAX_SENT);
  assert.equal(big.plan.files.length, PS.MAX_PLAN_FILES);
  assert.equal(big.plan.index, PS.MAX_PLAN_FILES);
  assert.equal(big.plan.status, 'paused');
  const s = PS.packSession(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p${i}`, rec({ at: NOW - i })])));
  assert.equal(Object.keys(s.panels).length, PS.MAX_PANELS);
  assert.ok(s.panels.p0 && !s.panels.p19); // 최근 것부터
});

test('되살리기: 같은 실행은 패널 세대가 같을 때만, 다른 실행은 같은 대화 주소면 바로 · 아니면 기다림, 오래된 것 · 깨진 것은 버림', () => {
  const saved = PS.packSession({
    same: rec(),
    cleared: rec(),
    other: rec({ run: 'R0' }),
    reopened: rec({ run: 'R0', conv: 'match' }),
    old: rec({ run: 'R0', at: NOW - PS.MAX_AGE_MS - 1 }),
    empty: PS.packPanel({ run: 'R0', at: NOW }),
  });
  saved.panels.broken = { sent: 'x' };
  const { active, pending } = PS.restorePlan(JSON.parse(JSON.stringify(saved)), {
    runId: 'R1',
    epochOf: (id) => (id === 'cleared' ? '1' : '0'),
    convOf: (id) => (id === 'reopened' ? 'match' : null),
    now: NOW,
  });
  assert.deepEqual([...active.keys()].sort(), ['reopened', 'same']);
  assert.deepEqual([...pending.keys()], ['other']);
  assert.equal(active.get('same').sentMap.get('a.js').hash, 'h1');
  assert.equal(active.get('same').sentMap.get('gone.js'), null);
  assert.deepEqual(PS.describe(active.get('same')), { sent: 2, plan: { at: 2, total: 2, done: false }, cont: 'a.js' });
  assert.equal(PS.restorePlan(null, { runId: 'R1' }).active.size, 0);
  assert.equal(PS.restorePlan({ v: 99, panels: saved.panels }, { runId: 'R1' }).active.size, 0);
});

test('바 쌓기: 줄 수 0~2, 예전 true/false도', () => {
  assert.equal(L.barRows(true), 1);
  assert.equal(L.barRows(false), 0);
  assert.equal(L.barRows(2), 2);
  assert.equal(L.barRows(5), 2);
  assert.equal(L.barRows(-1), 0);
  assert.equal(L.barRows('2'), 2);
  assert.equal(L.barRows('x'), 0);
  assert.equal(L.barRows(1.5), 0);
});

test('바 쌓기 연결: 화면은 두 바를 세어 알리고, 본체 · 확장은 줄 수 × BAR_H만큼 웹페이지를 줄인다, 제안 바는 변경 바 위로', () => {
  const r = read('src/renderer/renderer.js');
  assert.match(r, /const rows = \(offer \? 1 : 0\) \+ \(change \? 1 : 0\)/);
  assert.match(r, /host\.setPanelBar\(id, rows\)/);
  const main = read('src/main/main.js');
  assert.match(main, /const bar = \(barIds\.get\(id\) \|\| 0\) \* BAR_H/);
  assert.match(main, /barRows\(rows === undefined \? !!on : rows\)/);
  const host = read('extension/host.js');
  assert.match(host, /const bar = \(barIds\.get\(id\) \|\| 0\) \* BAR_H/);
  assert.match(host, /MLA\.layout\.barRows\(rows\)/);
  assert.match(read('src/preload/preload.js'), /setPanelBar: \(id, rows\) => ipcRenderer\.send\('layout:bar', \{ id, on: !!rows, rows: Number\(rows\) \|\| 0 \}\)/);
  const css = read('src/renderer/styles.css');
  assert.match(css, /\.panel\.bars-2 \.offer-bar \{ bottom: 34px; \}/);
  assert.doesNotMatch(css, /has-offer \.change-bar:not\(\.offer-bar\) \{ display: none/); // 더는 가리지 않는다
});

test('이어 하기 연결: 저장할 때 ctx, 읽을 때 되살림, 새 대화 · 패널 닫기에서 버림, 읽는 순서', () => {
  const pj = read('src/renderer/project.js');
  assert.match(pj, /ctx: P\.sessionState \? P\.sessionState\(\) : null/);
  assert.match(pj, /P\.restoreSession\(s\.ctx\)/);
  assert.match(pj, /await P\.afterRestore\(\)/);
  assert.match(pj, /P\.dropPending\(id\); \/\/ 앱을 다시 켜기 전의 기록도 버린다/);
  assert.match(pj, /P\.dropPending\?\.\(id\); \/\/ 닫은 패널/);
  assert.match(read('src/renderer/renderer.js'), /window\.onPanelUrl\?\.\(id, url\)/);
  const html = read('src/renderer/index.html');
  const order = ['../shared/project-session.js', 'project-changes.js', 'project-mix.js', 'project-commit.js', 'project-restore.js', 'project-editor.js'].map((n) => html.indexOf(`<script src="${n}">`));
  assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), order.join(','));
  const app = read('extension/app.html');
  for (const n of ['lib/shared/mix-select.js', 'lib/shared/commit-msg.js', 'lib/shared/project-session.js', 'lib/renderer/project-mix.js', 'lib/renderer/project-restore.js']) assert.ok(app.includes(n), n);
  // 파일 내용은 저장하지 않는다: 저장 칸은 지문 · 경로 · 위치만
  const restore = read('src/renderer/project-restore.js');
  assert.doesNotMatch(restore, /changes: \[\.\.\.run\.changes\.values/);
});
