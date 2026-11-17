// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/renderer/project-related.js)
'use strict';

// 프로젝트 사이드바 — 관련 파일 찾기 (v0.34.0) — Windows 앱과 크롬 확장이 똑같이 씀. project.js 다음에 읽힌다.
// 고른 파일이 import / require / from … import로 부르는 프로젝트 안의 파일을 깊이 2까지 따라가(shared/import-graph.js), 함께 보낼 만한 파일을
// 목록으로 제안한다. 체크 상자로 골라 [선택한 파일 추가]를 누르면 보낼 파일에 더한다 (비밀 정보 확인은 파일을 직접 고를 때와 같다).
// JS · TS · Python만, 별칭(@/…)이나 동적으로 만든 경로는 찾지 못한다.
//
// [쉽게 말하면] "이 파일이 부르는 다른 파일도 같이 보낼까요?"를 제안하는 부분입니다.

(() => {
  const P = MLA.projectUI;
  const IG = MLA.importGraph;
  const FILE_READ_MAX = 300000;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const fmtBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
  const closeButton = (box) => button(t('project.related.close'), t('project.related.close'), () => (box.hidden = true));

  function draw(box, found) {
    const { project } = P;
    if (!found.length) return box.replaceChildren(el('p', 'muted small', t('project.related.none')), closeButton(box));
    const rows = found.map((f) => {
      const label = el('label', 'check-label related-row');
      const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true });
      cb.dataset.path = f.path;
      const size = project.scan.entries.find((e) => e.path === f.path)?.size;
      label.append(cb, el('span', 'related-path', f.path), el('span', 'muted-label', `${t('project.related.depth', { n: f.depth })}${size ? ` · ${fmtBytes(size)}` : ''}`));
      label.title = t('project.related.from', { path: f.from });
      return label;
    });
    const add = button(t('project.related.add'), t('project.related.addTitle'), async () => {
      add.disabled = true;
      let n = 0;
      for (const cb of box.querySelectorAll('input[type="checkbox"]:checked')) {
        const entry = P.entryOf(cb.dataset.path);
        if (!entry || project.checked.has(entry.path)) continue;
        await P.toggleFile(entry, true); // 비밀 정보 확인 · 읽을 수 없는 파일 안내는 직접 고를 때와 같다
        if (project.checked.has(entry.path)) n++;
      }
      box.hidden = true;
      P.notice(t('project.related.added', { n }));
    });
    const actions = el('div', 'related-actions');
    actions.append(add, closeButton(box));
    box.replaceChildren(el('p', 'muted small', t('project.related.note', { n: found.length })), ...rows, actions);
  }

  async function find() {
    if (!P.has()) return;
    const { project } = P;
    const box = $('#psRelatedBox');
    const selected = [...project.checked];
    if (!selected.length) return P.notice(t('project.related.pickFirst'));
    const btn = $('#psRelated');
    btn.disabled = true;
    box.hidden = false;
    box.replaceChildren(el('p', 'muted small', t('project.related.searching')));
    try {
      const paths = new Set(P.sendablePaths());
      const readText = async (p) => {
        const r = await host.project.readFile(p, { maxBytes: FILE_READ_MAX }).catch(() => null);
        return r && typeof r.text === 'string' ? r.text : null;
      };
      const found = (await IG.relatedFiles({ selected, paths, readText })).filter((f) => !project.checked.has(f.path));
      draw(box, found);
    } catch (err) {
      box.replaceChildren(el('p', 'test-err', err.message));
    } finally {
      btn.disabled = false;
    }
  }

  $('#psRelated').addEventListener('click', find);
})();
