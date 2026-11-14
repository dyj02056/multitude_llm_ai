'use strict';
// 프로젝트 모드 v0.23.0 기능 단위 테스트:  npm test
//   - 증분 전송: 바뀐 파일만 다시 올리고 나머지는 "앞서 보낸 그대로" 목록으로 알림 (내용 지문 hashText)
//   - 이어지는 질문에 지난 파일 목록 붙이기 (followList)
//   - 적용 트랜잭션: 여러 파일 중 하나라도 쓰기 실패하면 이미 쓴 파일을 원래대로 되돌림
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/shared/project-context');
const U = require('../src/shared/project-upload');

const BUDGET = { files: 10, bytes: 50 * 1024 * 1024, fileBytes: 25 * 1024 * 1024 };
const known = (files) => new Map(files.map((f) => [f.path, C.sentEntry(f.text)]));

test('내용 지문: 같은 내용은 같고, 한 글자만 달라도 다름, 줄바꿈 차이는 무시', () => {
  assert.equal(C.hashText('a\nb\n'), C.hashText('a\nb\n'));
  assert.equal(C.hashText('a\r\nb\r\n'), C.hashText('a\nb\n'));
  assert.notEqual(C.hashText('a\nb\n'), C.hashText('a\nc\n'));
  assert.notEqual(C.hashText(''), C.hashText(' '));
  assert.equal(C.hashText(null), null);
  assert.match(C.hashText('한글 내용'), /^[0-9a-z]+\.[0-9a-z]+$/);
  assert.equal(C.lineCount('a\nb\n'), 2);
  assert.equal(C.lineCount(''), 0);
  assert.deepEqual(C.sentEntry(null), null);
});

test('증분 전송: 바뀌지 않은 파일은 빼고 목록으로, 바뀐 파일만 올림', () => {
  const sent = [
    { path: 'a.js', text: 'A\n' },
    { path: 'b.js', text: 'B\n' },
    { path: 'c.js', text: 'C\n' },
  ];
  const now = [
    { path: 'a.js', text: 'A\n', checked: true },
    { path: 'b.js', text: 'B2\n', checked: true },
    { path: 'c.js', text: 'C\r\n', checked: true }, // 줄바꿈만 다름 → 그대로
  ];
  const tree = C.hashText('tree');
  const plan = C.planIncremental({
    ids: ['gpt'],
    files: now,
    knownById: new Map([['gpt', known(sent)]]),
    treeById: new Map([['gpt', tree]]),
    treeHash: tree,
  });
  assert.equal(plan.allFresh, false);
  assert.equal(plan.includeTree, false);
  assert.deepEqual(plan.union.map((f) => f.path), ['b.js']);
  assert.deepEqual(plan.byId.gpt.same.map((f) => f.path), ['a.js', 'c.js']);
  assert.equal(plan.byId.gpt.plain, false);

  const pack = U.packIncremental({ project: { name: 'demo', paths: ['a.js', 'b.js', 'c.js'] }, files: plan.union, same: plan.byId.gpt.same, request: '고쳐 줘', budget: BUDGET });
  assert.equal(pack.attachments.length, 1);
  assert.equal(pack.attachments[0].name, 'changed-files.md');
  assert.match(pack.attachments[0].text, /\[파일: b\.js\]/);
  assert.doesNotMatch(pack.attachments[0].text, /\[파일: a\.js\]/);
  assert.match(pack.text, /앞서 보낸 그대로/);
  assert.match(pack.text, /- a\.js\n- c\.js/);
  assert.match(pack.text, /고쳐 줘/);
  assert.match(pack.text, /\[답변 규칙\]/);
});

test('증분 전송: 아무것도 안 바뀌면 첨부 없이 질문과 목록만 (plain)', () => {
  const files = [{ path: 'a.js', text: 'A\n', checked: true }];
  const tree = C.hashText('t');
  const plan = C.planIncremental({ ids: ['gpt'], files, knownById: new Map([['gpt', known(files)]]), treeById: new Map([['gpt', tree]]), treeHash: tree });
  assert.equal(plan.byId.gpt.plain, true);
  assert.equal(plan.union.length, 0);
  const pack = U.packIncremental({ project: { name: 'demo', paths: ['a.js'] }, files: [], same: plan.byId.gpt.same, request: '왜?', budget: BUDGET });
  assert.equal(pack.attachments.length, 0);
  assert.match(pack.text, /- a\.js/);
});

test('증분 전송: 처음 받는 패널이 있으면 그 패널 몫은 전부, 구조도 다시', () => {
  const files = [
    { path: 'a.js', text: 'A\n', checked: true },
    { path: 'b.js', text: 'B\n', checked: true },
  ];
  const tree = C.hashText('t');
  const plan = C.planIncremental({
    ids: ['gpt', 'claude'],
    files,
    knownById: new Map([['gpt', known(files)]]),
    treeById: new Map([['gpt', tree]]),
    treeHash: tree,
  });
  assert.equal(plan.allFresh, false);
  assert.equal(plan.byId.gpt.plain, true); // gpt는 다 안다 → 질문만
  assert.equal(plan.byId.claude.fresh, true);
  assert.deepEqual(plan.union.map((f) => f.path), ['a.js', 'b.js']);
  assert.equal(plan.includeTree, true);
  // 모두 처음이면 예전 방식(packContext)으로 보낸다
  const fresh = C.planIncremental({ ids: ['gpt'], files, knownById: new Map(), treeById: new Map(), treeHash: tree });
  assert.equal(fresh.allFresh, true);
  // 구조가 바뀌면 구조만 다시 (파일은 그대로)
  const moved = C.planIncremental({ ids: ['gpt'], files, knownById: new Map([['gpt', known(files)]]), treeById: new Map([['gpt', tree]]), treeHash: C.hashText('t2') });
  assert.equal(moved.byId.gpt.plain, false);
  assert.equal(moved.includeTree, true);
  assert.equal(moved.union.length, 0);
  const pack = U.packIncremental({ project: { name: 'demo', paths: ['a.js', 'b.js'] }, files: [], same: moved.byId.gpt.same, includeTree: true, budget: BUDGET });
  assert.equal(pack.attachments[0].name, 'project-context.md');
  assert.match(pack.attachments[0].text, /\[프로젝트 구조\]/);
});

test('같은 첨부를 여러 패널에: 첨부 내용은 패널마다 같다 (본문 목록만 다름)', () => {
  const p = { name: 'demo', paths: ['a.js', 'b.js'] };
  const files = [{ path: 'b.js', text: 'B\n' }];
  const one = U.packIncremental({ project: p, files, same: [{ path: 'a.js', lines: 1 }], includeTree: true, first: false, budget: BUDGET });
  const two = U.packIncremental({ project: p, files, same: [], includeTree: true, first: true, budget: BUDGET });
  assert.deepEqual(one.attachments, two.attachments);
  assert.notEqual(one.text, two.text);
});

test('바뀐 파일만 보내기를 끄면(planIncremental을 쓰지 않음) 예전처럼 고른 파일을 모두 올림', () => {
  const files = [
    { path: 'a.js', text: 'A\n' },
    { path: 'b.js', text: 'B\n' },
  ];
  const pack = U.packContext({ project: { name: 'demo', paths: ['a.js', 'b.js'] }, files, request: 'q', budget: BUDGET });
  assert.equal(pack.attachments[0].name, 'project-context.md');
  assert.match(pack.attachments[0].text, /\[파일: a\.js\][\s\S]*\[파일: b\.js\]/);
  assert.doesNotMatch(pack.text, /앞서 보낸 그대로/);
});

test('지난 파일 목록 붙이기: 고른 파일이 없어도 지난번에 보낸 파일 목록(줄 수)과 바뀐 것은 다시', () => {
  const before = [
    { path: 'a.js', text: 'A\nA\n' },
    { path: 'b.js', text: 'B\n' },
    { path: 'gone.js', text: 'G\n' },
  ];
  const now = [
    { path: 'a.js', text: 'A\nA\n', checked: false },
    { path: 'b.js', text: 'B\nB\nB\n', checked: false },
  ];
  const tree = C.hashText('t');
  const args = { ids: ['gpt'], files: now, knownById: new Map([['gpt', known(before)]]), treeById: new Map([['gpt', tree]]), treeHash: tree, missing: ['gone.js'] };
  // 꺼져 있으면 고른 파일만 본다 → 보낼 것도 목록도 없음
  const off = C.planIncremental(args);
  assert.equal(off.byId.gpt.plain, true);
  assert.deepEqual(off.byId.gpt.same, []);
  assert.deepEqual(off.byId.gpt.gone, []);
  // 켜면 지난번에 보낸 파일도 후보: 바뀐 b.js는 다시, a.js는 목록으로, 지워진 파일도 알림
  const on = C.planIncremental({ ...args, followList: true });
  assert.deepEqual(on.union.map((f) => f.path), ['b.js']);
  assert.deepEqual(on.byId.gpt.same, [{ path: 'a.js', lines: 2 }]);
  assert.deepEqual(on.byId.gpt.gone, ['gone.js']);
  const pack = U.packIncremental({ project: { name: 'demo', paths: ['a.js', 'b.js'] }, files: on.union, same: on.byId.gpt.same, gone: on.byId.gpt.gone, showLines: true, budget: BUDGET });
  assert.match(pack.text, /- a\.js \(2줄\)/);
  assert.match(pack.text, /\[지워진 파일\][\s\S]*- gone\.js/);
  assert.match(pack.attachments[0].text, /\[파일: b\.js\]/);
});

// ---------- 적용 트랜잭션 ----------

/** 메모리 위의 가짜 폴더. failOn: 그 경로(n번째 쓰기)에서 실패 */
function memFs(init, { failWriteAt } = {}) {
  const files = new Map(Object.entries(init));
  let writes = 0;
  return {
    files,
    io: {
      read: async (p) => (files.has(p) ? files.get(p) : null),
      write: async (p, t) => {
        writes++;
        if (failWriteAt && writes === failWriteAt) throw new Error('디스크가 가득 찼습니다');
        files.set(p, t);
      },
      remove: async (p) => {
        if (!files.has(p)) throw new Error('ENOENT: not found');
        files.delete(p);
      },
    },
  };
}

test('적용 트랜잭션: 4개 중 3번째 쓰기가 실패하면 쓴 것·지운 것·새로 만든 것을 모두 원래대로', async () => {
  const fs = memFs({ 'a.js': 'A0', 'old.js': 'OLD', 'c.js': 'C0' }, { failWriteAt: 2 });
  const ops = [
    { path: 'a.js', op: 'write', after: 'A1' }, // 쓰기 1
    { path: 'old.js', op: 'delete' }, // 지우기
    { path: 'new.js', op: 'write', after: 'N1' }, // 쓰기 2 — 새 파일, 3번째 작업에서 실패
    { path: 'c.js', op: 'write', after: 'C1' },
  ];
  const r = await C.applyTransaction(ops, fs.io);
  assert.equal(r.ok, false);
  assert.equal(r.failed.path, 'new.js');
  assert.deepEqual(r.restored, ['a.js', 'old.js']);
  assert.deepEqual(r.restoreFailed, []);
  assert.deepEqual(Object.fromEntries(fs.files), { 'a.js': 'A0', 'old.js': 'OLD', 'c.js': 'C0' });
  assert.equal(C.transactionMessage(r).split('\n')[0], 'new.js 쓰기 실패 — 같이 적용한 2개 파일을 원래대로 되돌렸습니다');
});

test('적용 트랜잭션: 새로 만든 파일은 지우고, 4번째 쓰기 실패 때 앞의 3개를 되돌림', async () => {
  const fs = memFs({ 'a.js': 'A0', 'b.js': 'B0', 'd.js': 'D0' }, { failWriteAt: 4 });
  const ops = [
    { path: 'a.js', op: 'write', after: 'A1', before: 'A0' },
    { path: 'new.js', op: 'write', after: 'N1', before: null },
    { path: 'b.js', op: 'write', after: 'B1', before: 'B0' },
    { path: 'd.js', op: 'write', after: 'D1', before: 'D0' },
  ];
  const r = await C.applyTransaction(ops, fs.io);
  assert.equal(r.ok, false);
  assert.equal(r.failed.path, 'd.js');
  assert.deepEqual(r.restored, ['a.js', 'new.js', 'b.js']);
  assert.deepEqual(Object.fromEntries(fs.files), { 'a.js': 'A0', 'b.js': 'B0', 'd.js': 'D0' });
  assert.match(C.transactionMessage(r), /^d\.js 쓰기 실패 — 같이 적용한 3개 파일을 원래대로 되돌렸습니다/);
});

test('적용 트랜잭션: 되돌리기도 실패한 파일은 따로 알림', async () => {
  const fs = memFs({ 'a.js': 'A0', 'b.js': 'B0' });
  let n = 0;
  const io = {
    ...fs.io,
    write: async (p, t) => {
      n++;
      if (n === 2) throw new Error('잠김'); // b.js 쓰기 실패
      if (n >= 3 && p === 'a.js') throw new Error('읽기 전용'); // a.js 되돌리기 실패
      fs.files.set(p, t);
    },
  };
  const r = await C.applyTransaction(
    [
      { path: 'a.js', op: 'write', after: 'A1' },
      { path: 'b.js', op: 'write', after: 'B1' },
    ],
    io,
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.restored, []);
  assert.deepEqual(r.restoreFailed.map((f) => f.path), ['a.js']);
  assert.match(C.transactionMessage(r), /되돌리지 못한 파일[\s\S]*a\.js: 읽기 전용/);
});

test('적용 트랜잭션: 성공하면 모두 쓰고 원본을 돌려줌 (되돌리기 기록용)', async () => {
  const fs = memFs({ 'a.js': 'A0', 'old.js': 'OLD' });
  const r = await C.applyTransaction(
    [
      { path: 'a.js', op: 'write', after: 'A1' },
      { path: 'n.js', op: 'write', after: 'N1' },
      { path: 'old.js', op: 'delete' },
    ],
    fs.io,
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.done, [
    { path: 'a.js', before: 'A0', after: 'A1' },
    { path: 'n.js', before: null, after: 'N1' },
    { path: 'old.js', before: 'OLD', after: null },
  ]);
  assert.deepEqual(Object.fromEntries(fs.files), { 'a.js': 'A1', 'n.js': 'N1' });
  assert.equal(C.transactionMessage(r), '');
});
