// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/renderer/project-devtest.js)
'use strict';

// 프로젝트 모드 — 미리보기 창의 검사 실행 (test · lint · typecheck · build, Windows 앱 전용: host.devtest).
// v0.31.0에서 project-changes.js에서 떼어 냈다. project-runs.js 다음, project-collect.js 앞에 읽힌다.
// 실행 중인지(testState.running)는 project-changes.js와 함께 본다 — 창을 닫으면 그쪽에서 실행을 멈춘다.
//
// [쉽게 말하면] 수정안을 적용하기 전에 "적용 전 · 적용 후"로 테스트를 돌려 나란히 보여 주는 버튼과 결과 화면입니다.
(() => {
  const P = MLA.projectUI;
  const { testState } = P; // project-changes.js

  // ---------- 검사 실행 (test · lint · typecheck · build, Windows 앱) ----------

  let testChecks = null; // 지난번 고른 검사 이름 (창을 다시 열어도 유지, 처음은 test만)

  /** 창 아래 검사 체크 칸: package.json에 있는 스크립트만 보인다. 고른 이름을 돌려주는 함수를 돌려준다 */
  function renderCheckBoxes(info) {
    const box = $('#patchChecks');
    const checks = info?.ok && Array.isArray(info.checks) ? info.checks : [];
    if (!testChecks) testChecks = new Set(checks.some((c) => c.name === 'test') ? ['test'] : checks.slice(0, 1).map((c) => c.name));
    box.replaceChildren(
      ...checks.map((c) => {
        const l = document.createElement('label');
        l.className = 'check-label patch-check';
        l.title = [c.pre && `pre${c.name}: ${c.pre}`, `${c.name}: ${c.script}`, c.post && `post${c.name}: ${c.post}`].filter(Boolean).join('\n');
        const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: testChecks.has(c.name) });
        cb.dataset.check = c.name;
        cb.addEventListener('change', () => (cb.checked ? testChecks.add(c.name) : testChecks.delete(c.name)));
        l.append(cb, span('', c.name));
        return l;
      }),
    );
    box.hidden = checks.length < 2; // test 하나뿐이면 예전처럼 체크 칸 없이
    return () => checks.map((c) => c.name).filter((n) => testChecks.has(n));
  }

  /** 창의 [테스트 실행]: 체크한 수정안을 잠깐 쓰고 고른 검사를 적용 전 · 후로 돌려 나란히 보여 준다. getChosen() → 적용할 plan 목록 */
  function setupTestRun(getChosen) {
    if (!host.devtest) return;
    const btn = $('#patchTest');
    btn.hidden = false;
    btn.textContent = t('devtest.run');
    let picked = () => ['test'];
    host.devtest.info().then((info) => {
      if ($('#patchModal').hidden || btn.hidden) return;
      picked = renderCheckBoxes(info);
    }).catch(() => {});
    btn.onclick = async () => {
      if (testState.running) {
        btn.disabled = true;
        await host.devtest.stop();
        return;
      }
      const chosen = getChosen();
      if (!chosen.length) return ($('#patchStatus').textContent = t('project.test.pick'));
      const scripts = picked();
      if (!scripts.length) return ($('#patchStatus').textContent = t('devtest.pickScript'));
      testState.running = true;
      btn.textContent = t('project.test.stop');
      $('#patchApply').disabled = true;
      const out = $('#patchTestOut');
      out.hidden = false;
      out.replaceChildren(span('muted-label', t('devtest.running', { names: scripts.join(' · ') })));
      try {
        const r = await host.devtest.trial(chosen.map((p) => ({ path: p.path, after: p.op === 'delete' ? null : p.after })), scripts);
        renderTestResult(out, r);
      } catch (err) {
        renderTestResult(out, { ok: false, error: err.message });
      } finally {
        testState.running = false;
        btn.disabled = false;
        btn.textContent = t('project.test.rerun');
        $('#patchApply').disabled = false;
      }
    };
  }

  const fmtMs = (ms) => (ms >= 60000 ? t('project.test.minSec', { m: Math.floor(ms / 60000), s: Math.round((ms % 60000) / 1000) }) : t('project.test.sec', { s: (ms / 1000).toFixed(1) }));

  /**
   * 검사 결과: 스크립트마다 한 줄 머리(이름 · 판정)와 적용 전 | 적용 후를 나란히 (상태 · 통과/실패 수 · 걸린 시간 · 출력).
   * v0.28.0: r.results에 고른 스크립트(test · lint · typecheck · build)가 차례로 온다. 예전 모양(r.before · r.after)도 받는다.
   */
  function renderTestResult(box, r) {
    if (!r?.ok) {
      box.replaceChildren(span(r?.cancelled ? 'muted-label' : 'test-err', r?.error || t('project.test.failedToRun')));
      return;
    }
    const col = (title, x) => {
      const c = document.createElement('div');
      c.className = 'test-col';
      const head = document.createElement('div');
      head.className = 'test-col-head';
      head.append(span('', title));
      if (!x) {
        head.append(span('test-badge skip', t('project.test.notRun')));
        c.append(head);
        return c;
      }
      const [cls, label] = x.stopped
        ? ['skip', t('project.test.stopped')]
        : x.timedOut
          ? ['bad', t('project.test.timeout')]
          : x.error
            ? ['bad', t('project.test.runError')]
            : x.ok
              ? ['good', t('project.test.pass')]
              : ['bad', t('project.test.fail', { code: x.code })];
      head.append(span(`test-badge ${cls}`, label));
      if (x.summary) head.append(span('muted-label', t('project.test.summary', { pass: x.summary.pass, fail: x.summary.fail })));
      if (x.ms) head.append(span('muted-label', fmtMs(x.ms)));
      c.append(head);
      if (x.error) c.append(span('test-err', x.error));
      const pre = document.createElement('pre');
      pre.className = 'test-output';
      pre.textContent = x.output || t('project.test.noOutput');
      c.append(pre);
      requestAnimationFrame(() => (pre.scrollTop = pre.scrollHeight)); // 요약이 있는 끝부분부터 보이게
      return c;
    };
    const verdictOf = (x) =>
      x.before?.ok && x.after && !x.after.ok
        ? ['bad', t('devtest.verdictBreaks', { name: x.name })]
        : !x.before?.ok && x.after?.ok
          ? ['good', t('devtest.verdictFixes', { name: x.name })]
          : x.after?.ok
            ? ['good', t('devtest.verdictPasses', { name: x.name })]
            : ['skip', t('devtest.verdictNeither', { name: x.name })];
    const results = Array.isArray(r.results) && r.results.length ? r.results : [{ name: 'test', script: r.script, before: r.before, after: r.after }];
    const head = document.createElement('div');
    head.className = 'test-head';
    const bad = results.filter((x) => verdictOf(x)[0] === 'bad').length;
    head.append(
      span('muted-label', results.map((x) => x.name).join(' · ')),
      span(`test-badge ${bad ? 'bad' : results.every((x) => x.after?.ok) ? 'good' : 'skip'}`, bad ? t('devtest.sumBad', { n: bad }) : t('devtest.sumOk', { n: results.length })),
      span('muted-label', t('project.test.restored')),
    );
    const restoreFailed = r.restoreFailed || r.after?.restoreFailed;
    const blocks = results.map((x) => {
      const b = document.createElement('div');
      b.className = 'test-script';
      const h = document.createElement('div');
      h.className = 'test-script-head';
      const v = verdictOf(x);
      h.append(span('test-name', x.name === 'test' ? 'npm test' : `npm run ${x.name}`), span('muted-label', x.script ? `(${x.script})` : ''), span(`test-badge ${v[0]}`, v[1]));
      const cols = document.createElement('div');
      cols.className = 'test-cols';
      cols.append(col(t('project.test.before'), x.before), col(t('project.test.after'), x.after));
      b.append(h, cols);
      return b;
    });
    box.replaceChildren(head, ...(restoreFailed?.length ? [span('test-err', t('project.test.restoreFailed', { list: restoreFailed.join(', ') }))] : []), ...blocks);
  }

  Object.assign(P, { setupTestRun });
})();
