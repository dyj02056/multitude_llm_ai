'use strict';
// 답변 감시(watch.js) 단위 테스트:  npm test
// [쉽게 말하면]
//   - 페이지를 계속 못 읽어도(null) 시간이 지나면 'no-answer' / 'timeout'으로 끝나는지 (무한 감시 방지)
//   - 정상적으로 글이 늘다가 멈추면 'done'과 글자 수를 알리는지
// 실제 시간을 기다리지 않도록 node:test의 가짜 시계(setTimeout, Date)를 쓴다.
const test = require('node:test');
const assert = require('node:assert/strict');
const { watchAnswer } = require('../src/shared/watch');

const LATE_EXTRA_MS = 60 * 60 * 1000;

// 가짜 시계를 조금씩 돌리면서 감시가 끝날 때까지 기다린다. (끝나지 않으면 실패)
async function drive(t, promise, { stepMs = 700, maxSteps = 5000 } = {}) {
  let finished = false;
  promise.then(() => (finished = true));
  const flush = () => new Promise((r) => setImmediate(r)); // setImmediate는 가짜 시계 대상이 아니다
  for (let i = 0; i < maxSteps && !finished; i++) {
    await flush();
    t.mock.timers.tick(stepMs);
    await flush();
  }
  assert.ok(finished, '감시가 끝나지 않았다 (무한 감시)');
  return promise;
}

test('답변 시작 전 페이지를 계속 못 읽으면 startMs 뒤 no-answer로 끝난다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const states = [];
  let polls = 0;
  const p = watchAnswer(
    async () => (polls++, null),
    { count: 0, text: '' },
    () => true,
    (s) => states.push(s),
    { startMs: 5000, maxMs: 20000 }
  );
  await drive(t, p);
  assert.deepEqual(states, ['no-answer']);
  assert.ok(polls >= 7 && polls <= 9, `polls=${polls}`); // 5초 / 0.7초 언저리에서 끝난다
});

test('답변 시작 뒤 페이지를 계속 못 읽으면 timeout 한 번, 그 뒤 늦은 감시 시간이 지나면 끝난다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const states = [];
  let first = true;
  const getSnap = async () => {
    if (first) {
      first = false;
      return { stop: true, count: 1, text: '' };
    }
    return null;
  };
  const p = watchAnswer(getSnap, { count: 0, text: '' }, () => true, (s) => states.push(s), { startMs: 5000, maxMs: 10000 });
  await drive(t, p, { stepMs: 3000, maxSteps: (LATE_EXTRA_MS + 20000) / 3000 + 50 });
  assert.deepEqual(states, ['answering', 'timeout']);
  assert.ok(Date.now() > 10000 + LATE_EXTRA_MS); // maxMs + LATE_EXTRA_MS가 지나서야 끝난다
});

test('답변 시작 뒤 못 읽다가 isCurrent가 false가 되면 바로 끝난다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const states = [];
  let current = true;
  let first = true;
  const getSnap = async () => (first ? ((first = false), { stop: true, count: 1, text: '' }) : null);
  const p = watchAnswer(getSnap, { count: 0, text: '' }, () => current, (s) => {
    states.push(s);
    if (s === 'timeout') current = false; // 시간 초과를 받고 패널을 닫은 상황
  }, { startMs: 5000, maxMs: 10000 });
  await drive(t, p);
  assert.deepEqual(states, ['answering', 'timeout']);
});

test('정상: 글이 늘다가 멈추면 done과 글자 수를 알린다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const frames = [
    { stop: true, count: 1, text: '안' },
    { stop: true, count: 1, text: '안녕' },
    { stop: true, count: 1, text: '안녕하세요' },
    { stop: false, count: 1, text: '안녕하세요.' },
  ];
  let i = 0;
  const getSnap = async () => frames[Math.min(i++, frames.length - 1)];
  const calls = [];
  const p = watchAnswer(getSnap, { count: 0, text: '' }, () => true, (s, info) => calls.push([s, info]), { startMs: 5000, maxMs: 60000 });
  await drive(t, p);
  assert.deepEqual(calls, [['answering', undefined], ['done', { chars: '안녕하세요.'.length, late: false }]]);
});
