// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/renderer/project-collect.js)
'use strict';

// 프로젝트 모드 — 파일 모아보기: 답변의 파일 코드를 새 파일 · 수정 · 삭제로 모아 복사하기 좋게 보여 준다 (파일은 쓰지 않는다).
// v0.31.0에서 project-changes.js에서 떼어 냈다. project-devtest.js 다음, project-mix.js 앞에 읽힌다.
// 창(modal) · 지금 파일 읽기(currentText) · diff 그리기(diffPre)는 project-changes.js의 것을 P에서 꺼내 쓴다.
//
// [쉽게 말하면] 프로젝트 폴더를 열지 않아도, 답변에 든 코드를 파일별로 모아 한 번에 복사할 수 있게 해 주는 창입니다.
(() => {
  const P = MLA.projectUI;
  const { project, has, answerMd, listLines } = P;
  const { currentText, modal, diffPre } = P; // project-changes.js
const PX = MLA.patch;

  // ---------- 파일 모아보기 ----------
  // 답변에서 찾은 파일 수정안을 "경로 + 전체 코드"로 모아, 직접 복사해 붙여 넣기 좋게 보여 준다. 파일은 쓰지 않는다.
  // 프로젝트를 열지 않아도 쓴다. 그때는 새 파일·수정을 구분하지 못하고, diff는 전체 코드로 바꾸지 못해 diff 그대로 보여 준다.

  // 화면 이름 — 부를 때 사전에서. 순서가 모아보기 요약 순서다.
  const COLLECT_OP = Object.fromEntries(['create', 'modify', 'full', 'diff', 'edit', 'same', 'delete'].map((op) => [op, null]));
  for (const op of Object.keys(COLLECT_OP)) Object.defineProperty(COLLECT_OP, op, { get: () => t(`project.collect.op.${op}`), enumerable: true });

  const hunkText = (change) => change.hunks.map((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join('\n')).join('\n');

  /** 답변 → [{ path, op, code, note }]. 프로젝트가 열려 있으면 지금 파일과 비교해 새 파일·수정을 나누고 diff는 전체 코드로 바꾼다 */
  async function collectItems(md) {
    const items = [];
    for (const change of PX.extractChanges(md)) {
      const { path } = change;
      if (change.isDelete) {
        items.push({ path, op: 'delete', code: '' });
        continue;
      }
      let before; // undefined: 모름 (프로젝트가 없거나 읽지 못함)
      if (has()) before = await currentText(path).catch(() => undefined);
      if (change.type === 'full') {
        const same = typeof before === 'string' && before.replace(/\r\n/g, '\n').trimEnd() === change.content.replace(/\r\n/g, '\n').trimEnd();
        // 잘린 답변이면 코드는 보여 주되 뒷부분이 없다고 알린다 (그대로 붙여 넣으면 나머지가 사라짐)
        const note = change.truncated ? t('project.collect.truncatedFull') : undefined;
        items.push({ path, op: before === undefined ? 'full' : before === null ? 'create' : same ? 'same' : 'modify', code: change.content, note });
        continue;
      }
      let note = t('project.collect.openForFull');
      if (before !== undefined || change.isNew) {
        const plan = PX.planChange(change, before ?? null);
        if (plan.ok) {
          items.push({ path, op: plan.op, code: plan.after.replace(/\r\n/g, '\n') });
          continue;
        }
        note = t('project.collect.mergeFailed', { error: plan.error });
      }
      if (change.type === 'edit') {
        // 찾기/바꾸기 블록 (v0.17.0): 프로젝트가 없으면 전체 코드로 합칠 수 없어 블록 그대로 보여 준다
        const code = change.edits.map((e) => `<<<<<<< 찾기\n${e.search}\n=======\n${e.replace}\n>>>>>>> 바꾸기`).join('\n\n');
        items.push({ path, op: 'edit', code, note: change.truncated ? t('project.collect.truncatedEdit') : note });
        continue;
      }
      items.push({ path, op: 'diff', code: hunkText(change), note });
    }
    return items;
  }

  /** 답변이 끝나면 수정안 개수를 세어 패널 머리줄 버튼을 띄운다 (눈에 띄게 잠깐 움직임) */
  async function showCollectBtn(id, md) {
    const p = panels.get(id);
    if (!p) return;
    const changes = PX.extractChanges(md);
    p.collectBtn.hidden = !changes.length;
    p.collectBtn.classList.remove('attn');
    if (!changes.length) return;
    p.collectBtn.textContent = t('project.collect.count', { n: changes.length });
    p.collectBtn.title = t('project.collect.countTitle', { list: listLines(changes, (c) => `- ${c.path}`) });
    void p.collectBtn.offsetWidth; // 애니메이션을 처음부터 다시 돌린다
    p.collectBtn.classList.add('attn');
  }

  const fenceFor = (code) => '`'.repeat(Math.max(3, ...[...code.matchAll(/`{3,}/g)].map((m) => m[0].length + 1)));
  const langOf = (path) => (/\.([\w]+)$/.exec(path)?.[1] || '').toLowerCase();

  /** 전체 복사용 Markdown: 파일 목록 + 파일마다 "파일: 경로" 와 코드 블록, 지울 파일은 DELETE_FILES */
  function collectMarkdown(items) {
    const out = items.map((it) => `- [${COLLECT_OP[it.op]}] ${it.path}`);
    for (const it of items.filter((x) => x.op !== 'delete')) {
      const fence = fenceFor(it.code);
      out.push('', `파일: ${it.path} (${COLLECT_OP[it.op]})`, `${fence}${it.op === 'diff' ? 'diff' : langOf(it.path)}`, it.code.replace(/\n$/, ''), fence);
    }
    const del = items.filter((x) => x.op === 'delete').map((x) => x.path);
    if (del.length) out.push('', `DELETE_FILES: ${del.join(', ')}`);
    return out.join('\n');
  }

  async function copyWithFeedback(btn, text, label) {
    await host.copyText(text);
    btn.textContent = t('project.collect.copied');
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = label;
      btn.classList.remove('copied');
    }, 1200);
  }

  window.onCollectClick = async (id) => {
    const p = panels.get(id);
    p?.collectBtn.classList.remove('attn');
    const name = state.services.find((s) => s.id === id)?.name || id;
    const items = await collectItems(await answerMd(id).catch(() => ''));
    const counts = Object.entries(COLLECT_OP)
      .map(([op, label]) => [label, items.filter((x) => x.op === op).length])
      .filter(([, n]) => n)
      .map(([label, n]) => `${label} ${n}`)
      .join(' · ');
    modal.show(
      t('project.collect.title', { name, n: items.length }),
      t('project.collect.note', { counts, base: has() ? t('project.collect.base', { name: project.info.name }) : t('project.collect.noBase') }),
    );
    $('#patchBody').replaceChildren(
      ...(items.length
        ? items.map((it) => {
            const pf = document.createElement('div');
            pf.className = 'pf collect';
            const head = document.createElement('div');
            head.className = 'pf-head';
            const tag = span(`op ${it.op}`, COLLECT_OP[it.op]);
            if (it.op === 'full') tag.title = t('project.collect.fullTitle');
            head.append(tag, span('path', it.path));
            if (it.note) head.append(span('muted-label', it.note));
            const pathBtn = button(t('project.collect.copyPath'), t('project.collect.copyPathTitle'), () => copyWithFeedback(pathBtn, it.path, t('project.collect.copyPath')));
            head.append(pathBtn);
            if (it.op !== 'delete') {
              const codeBtn = button(t('project.collect.copyCode'), t('project.collect.copyCodeTitle'), () => copyWithFeedback(codeBtn, it.code, t('project.collect.copyCode')));
              codeBtn.className = 'primary';
              head.append(codeBtn);
            }
            pf.append(head);
            if (it.op === 'diff') pf.append(diffPre(it.code));
            else if (it.op !== 'delete') {
              const pre = document.createElement('pre');
              pre.className = 'code';
              pre.textContent = it.code;
              pf.append(pre);
            } else pf.append(span('muted-label collect-del', t('project.collect.deleteReq')));
            return pf;
          })
        : [span('change-empty', t('project.collect.empty'))]),
    );
    $('#patchAll').hidden = true;
    $('#patchApply').hidden = !items.length;
    $('#patchApply').textContent = t('project.collect.copyAll');
    $('#patchApply').onclick = async () => {
      await host.copyText(collectMarkdown(items));
      $('#patchStatus').textContent = t('project.collect.copiedAll', { n: items.length });
    };
  };

  Object.assign(P, { showCollectBtn });
})();
