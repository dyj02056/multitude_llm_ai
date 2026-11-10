'use strict';
// 이어서 받기 (v0.17.1) 단위 테스트:  npm test
// [쉽게 말하면]
//   - 끊긴 파일의 마지막(잘렸을 수 있는) 줄은 버리고, 그 앞 줄을 기준으로 이어 받은 코드를 겹쳐 붙이는지
//   - 겹치는 곳이 맞지 않으면 붙이지 않는지 (엉뚱하게 이어 붙여 코드를 망가뜨리지 않게)
//   - 찾기/바꾸기는 끝난 블록을 두고 남은 블록만 더하는지, 또 잘리면 다시 이어 받을 수 있는지
const test = require('node:test');
const assert = require('node:assert/strict');
const PX = require('../src/shared/patch');

const FULL = Array.from({ length: 12 }, (_, i) => `line ${i + 1};`).join('\n') + '\n';
const cut = (n, partial = '') => ({ path: 'src/a.js', type: 'full', content: FULL.split('\n').slice(0, n).join('\n') + (partial ? `\n${partial}` : ''), truncated: true });
const next = (content, truncated) => ({ path: 'src/a.js', type: 'full', content, ...(truncated ? { truncated: true } : {}) });

test('이어 받기 정보: 마지막 줄은 잘렸을 수 있어 버리고, 그 앞 줄이 기준 줄', () => {
  const c = PX.continuationOf(cut(5, 'line 6')); // "line 6;"이 "line 6"에서 잘림
  assert.equal(c.kind, 'full');
  assert.equal(c.anchor, 'line 5;');
  assert.equal(c.dropped, 'line 6');
  assert.equal(c.head.length, 5);
  assert.equal(PX.continuationOf({ path: 'x', type: 'diff', hunks: [] }), null); // diff는 다시 요청으로
  assert.equal(PX.continuationOf({ path: 'x', type: 'diff', isDelete: true }), null);
});

test('이어 붙이기: 기준 줄을 한 번 더 쓴 답 → 겹친 줄은 한 번만', () => {
  const c = PX.continuationOf(cut(5, 'line 6'));
  const r = PX.stitchContinuation(c, next(['line 5;', ...FULL.split('\n').slice(5)].join('\n')));
  assert.equal(r.change.content.replace(/\n*$/, '\n'), FULL);
  assert.equal(r.change.truncated, undefined);
  const plan = PX.planChange(r.change, FULL.replace('line 3;', 'line 3 old;'));
  assert.equal(plan.ok, true);
  assert.equal(plan.suspect, undefined);
});

test('이어 붙이기: 잘린 줄을 마저 쓴 답 · 기준 줄이 몇 줄 뒤에 있는 답도 받는다', () => {
  const c = PX.continuationOf(cut(5, 'line 6'));
  const completesDropped = PX.stitchContinuation(c, next(FULL.split('\n').slice(5).join('\n'))); // "line 6;"부터 시작
  assert.equal(completesDropped.change.content.replace(/\n*$/, '\n'), FULL);
  const repeatsMore = PX.stitchContinuation(c, next(FULL.split('\n').slice(3).join('\n'))); // line 4; line 5; line 6; …
  assert.equal(repeatsMore.change.content.replace(/\n*$/, '\n'), FULL);
});

test('이어 붙이기: 첫 줄이 끊긴 곳과 맞지 않으면 붙이지 않는다, 다른 형식이어도', () => {
  const c = PX.continuationOf(cut(5, 'line 6'));
  assert.match(PX.stitchContinuation(c, next('function other() {}\nmore();')).error, /맞지 않아 붙이지 않았습니다/);
  assert.match(PX.stitchContinuation(c, null).error, /찾지 못했습니다/);
  assert.match(PX.stitchContinuation(c, { path: 'src/a.js', type: 'edit', edits: [] }).error, /코드 블록 형식이 아닙니다/);
});

test('이어 붙이기: 또 잘렸으면 truncated가 남아 한 번 더 이어 받을 수 있다', () => {
  let c = PX.continuationOf(cut(4, 'li'));
  const first = PX.stitchContinuation(c, next('line 4;\nline 5;\nline 6;\nline 7', true));
  assert.equal(first.change.truncated, true);
  c = PX.continuationOf(first.change);
  assert.equal(c.anchor, 'line 6;');
  const second = PX.stitchContinuation(c, next(['line 6;', ...FULL.split('\n').slice(6)].join('\n')));
  assert.equal(second.change.content.replace(/\n*$/, '\n'), FULL);
});

test('찾기/바꾸기 이어 받기: 끝난 블록은 두고 남은 블록만 더한다', () => {
  const md = '파일: src/a.js\n```js\n<<<<<<< 찾기\nline 1;\n=======\nLINE 1;\n>>>>>>> 바꾸기\n<<<<<<< 찾기\nline 2;\n=======\nLI';
  const [change] = PX.extractChanges(md);
  assert.equal(change.truncated, true);
  const c = PX.continuationOf(change);
  assert.equal(c.edits.length, 1);
  assert.match(PX.continuePrompt(c), /2번째부터 남은 찾기\/바꾸기만/);
  const [more] = PX.extractChanges('파일: src/a.js (이어서)\n```js\n<<<<<<< 찾기\nline 2;\n=======\nLINE 2;\n>>>>>>> 바꾸기\n```');
  assert.equal(more.path, 'src/a.js'); // "(이어서)"가 붙어도 같은 파일
  const r = PX.stitchContinuation(c, more);
  const plan = PX.planChange(r.change, FULL);
  assert.equal(plan.ok, true, plan.error);
  assert.ok(plan.after.startsWith('LINE 1;\nLINE 2;\nline 3;'));
});

test('부탁 글 · 이어 받을 만한지: 기준 줄을 보여 주고, 잘림 · 끝이 잘린 의심만', () => {
  const c = PX.continuationOf(cut(5, 'line 6'));
  const p = PX.continuePrompt(c);
  assert.match(p, /```\nline 5;\n```/);
  assert.match(p, /"파일: src\/a.js \(이어서\)"/);
  assert.equal(PX.wantsContinue({ change: cut(5), plan: { truncated: true } }), true);
  assert.equal(PX.wantsContinue({ change: next(FULL), plan: { ok: true, suspect: '끝이 잘린 것 같습니다 (괄호 1개가 닫히지 않음)' } }), true);
  assert.equal(PX.wantsContinue({ change: next(FULL), plan: { ok: true, suspect: '코드를 줄인 표시가 있습니다 ("// ...")' } }), false); // 생략은 다시 요청이 맞다
  assert.equal(PX.wantsContinue({ change: next(FULL), plan: { ok: true } }), false);
  assert.equal(PX.MAX_CONTINUE, 3);
});

test('자동 이어받기 (v0.22.0): 같은 파일 · 같은 횟수에는 한 번만, 이어 받을 때마다 열쇠가 바뀐다', () => {
  const X = require('../src/shared/patch');
  assert.equal(X.autoContinueKey('src/a.js', null), 'src/a.js#0');
  assert.equal(X.autoContinueKey('src/a.js', { path: 'src/a.js', rounds: 2 }), 'src/a.js#2');
  assert.equal(X.autoContinueKey('src/b.js', { path: 'src/a.js', rounds: 2 }), 'src/b.js#0'); // 다른 파일은 처음부터
  assert.notEqual(X.autoContinueKey('src/a.js', { path: 'src/a.js', rounds: 1 }), X.autoContinueKey('src/a.js', { path: 'src/a.js', rounds: 2 }));
  assert.ok(X.MAX_CONTINUE >= 1); // 자동이어도 이 횟수를 넘지 않는다 (continueFile)
});
