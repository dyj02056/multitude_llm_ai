// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/renderer/history-view.js)
// 질문·답변 기록 화면 (v0.27.0에서 renderer-views.js에서 옮기고 늘림):
// 왼쪽 목록(검색 · 거르기 · 대화 줄기로 묶기 · 여러 개 골라 내보내기), 오른쪽 상세(기록 하나 · 대화 줄기 전체, 즐겨찾기 · 태그).
// 거르기 계산은 본체(host.history.list → shared/history-search.js), 내보내기 글은 shared/export.js가 만든다.
//
// [쉽게 말하면] "hist" 화면입니다. 지난 질문을 기간 · AI · 평가 · 태그로 골라 보고, 같은 대화로 이어진 질문을 한 줄기로 묶어 보고,
// 여러 기록을 골라 문서 하나로 저장할 수 있습니다. 별표(★)와 태그는 기록마다 이 PC에만 저장됩니다.

const HSU = MLA.historySearch;
const HISTORY_VIEW_KEY = 'mla-history-view'; // 묶는 방식(기록 하나씩 · 대화 줄기)만 기억한다
const ANSWER_STATE_TEXT = {
  get timeout() { return t('ui.answerState.timeout'); },
  get 'no-answer'() { return t('ui.answerState.noAnswer'); },
  get error() { return t('ui.answerState.error'); },
};
// historySelected: 고른 기록 id 또는 대화 줄기 'thread:<id>'. picked: 내보내기로 고른 기록 id
const historyView = { filters: HSU.cleanFilters({}), group: 'records', picked: new Set(), items: [], archive: false }; // archive: 보관된 기록도 찾기 (v0.35.0, 껐다 켜면 꺼짐)
let historySelected = null;

try {
  const saved = JSON.parse(localStorage.getItem(HISTORY_VIEW_KEY) || '{}');
  if (saved.group === 'threads') historyView.group = 'threads';
} catch {}

const kindLabel = (kind) => t(`kind.${kind}`);

/** 목록 한 줄의 작은 설명 (시각 · 답변 수 · 첨부 · 종합 · 분석 · 이어 묻기 · 토론 · 보낸 곳 · 프로젝트 · 태그) */
function historyMeta(it) {
  return (
    `${fmtTime(it.at)} · ${t('ui.history.metaAnswered', { n: it.answered, total: it.targets })}` +
    `${it.files ? ` · ${t('ui.history.metaFiles', { n: it.files })}` : ''}${it.synth ? ` · ${t('ui.history.metaSynth', { n: it.synth })}` : ''}${it.analysis ? ` · ${t('ui.history.metaAnalysis', { n: it.analysis })}` : ''}` +
    `${it.chain ? ` · ${t('history.chainCount', { n: it.chain })}` : ''}${it.debate ? ` · ${t('history.debateCount', { n: it.debate })}` : ''}` +
    `${it.source === 'side' ? ' · side' : ''}${it.archived ? ` · ${t('history.archivedBadge')}` : ''}${it.project ? ` · ${t('history.projectBadge', { name: it.project })}` : ''}` +
    `${it.tags?.length ? ` · #${it.tags.join(' #')}` : ''}`
  );
}

/** 목록 한 줄: [고르기 칸] [★] 질문 + 설명. ids: 고르기 칸이 고르는 기록들 (대화 줄기면 그 줄기에서 보인 기록 전부) */
function historyRow({ key, question, meta, star, ids }) {
  const row = document.createElement('div');
  row.className = 'history-item';
  row.classList.toggle('active', key === historySelected);
  row.tabIndex = 0;
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'history-pick';
  box.title = t('history.select');
  box.checked = ids.every((id) => historyView.picked.has(id));
  box.addEventListener('click', (e) => e.stopPropagation());
  box.addEventListener('change', () => {
    for (const id of ids) box.checked ? historyView.picked.add(id) : historyView.picked.delete(id);
    renderPickedBar();
  });
  const text = document.createElement('div');
  text.className = 'history-text';
  text.append(span('history-q', `${star ? '★ ' : ''}${question || NO_TEXT}`), span('history-meta', meta));
  row.append(box, text);
  const open = () => {
    historySelected = key;
    renderHistoryList();
  };
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => e.key === 'Enter' && open());
  return row;
}

/** 기록 화면 왼쪽: 검색어 · 거르기에 맞는 기록 (또는 대화 줄기) 목록 */
async function renderHistoryList() {
  const query = $('#historySearch').value;
  const items = await host.history.list(query, historyView.filters, historyView.archive ? { archive: true } : undefined);
  historyView.items = items;
  renderFilterBadge();
  const list = $('#historyList');
  const filtered = query || HSU.activeCount(historyView.filters) || historyView.archive;
  if (!items.length) {
    list.replaceChildren(span('history-empty', filtered ? t('history.emptyFiltered') : t('ui.history.empty')));
    $('#historyDetail').replaceChildren();
    renderPickedBar();
    return;
  }
  const rows = historyView.group === 'threads' ? threadRows(items) : items.map(recordRowSpec);
  if (!rows.some((r) => r.key === historySelected)) historySelected = rows[0].key;
  list.replaceChildren(...rows.map(historyRow));
  renderPickedBar();
  const sel = rows.find((r) => r.key === historySelected);
  if (sel.threadId) renderThreadDetail(sel.threadId, sel.ids[0]);
  else renderHistoryDetail(sel.ids[0]);
}

const recordRowSpec = (it) => ({ key: it.id, question: it.question, meta: historyMeta(it), star: it.star, ids: [it.id] });

/** 대화 줄기로 묶은 목록 줄: 질문이 둘 이상이면 가장 최근 질문 + "대화 줄기 · 질문 N개" */
function threadRows(items) {
  return HSU.groupThreads(items).map((g) => {
    const top = g.items[0];
    if (g.items.length < 2 || !g.threadId) return { ...recordRowSpec(top), threadId: g.items.length > 1 ? g.threadId : null };
    return {
      key: `thread:${g.threadId}`,
      threadId: g.threadId,
      question: top.question,
      meta: `${t('history.threadMeta', { n: g.items.length })} · ${historyMeta(top)}`,
      star: g.items.some((x) => x.star),
      ids: g.items.map((x) => x.id),
    };
  });
}

// ---------- 거르기 ----------

/** 거르기 칸을 지금 값으로 채운다 (AI 칩 · 태그 고르기는 그때그때 만든다) */
async function renderHistoryFilters() {
  const f = historyView.filters;
  $('#hfPeriod').value = f.period;
  $('#hfRange').hidden = f.period !== 'range';
  $('#hfArchive').checked = historyView.archive;
  $('#hfFrom').value = f.from;
  $('#hfTo').value = f.to;
  $('#hfRating').value = f.rating;
  $('#hfSource').value = f.source;
  $('#hfSourceRow').hidden = !state?.storage?.extension && f.source === ''; // 사이드탭은 크롬 확장에만 있다
  for (const box of document.querySelectorAll('[data-hf]')) {
    const k = box.dataset.hf;
    box.checked = k === 'star' || k === 'project' ? f[k] : f.has.includes(k);
  }
  const chips = (state?.services || []).map((svc) => {
    const chip = button(svc.name, t('history.services'), () => {
      const on = new Set(historyView.filters.services);
      on.has(svc.id) ? on.delete(svc.id) : on.add(svc.id);
      setHistoryFilters({ services: [...on] });
    });
    chip.className = 'chip';
    chip.style.setProperty('--svc', svc.color);
    chip.classList.toggle('on', f.services.includes(svc.id));
    return chip;
  });
  $('#hfServices').replaceChildren(...chips);
  const tags = await host.history.tags?.().catch(() => []) || [];
  const sel = $('#hfTag');
  sel.replaceChildren(
    Object.assign(document.createElement('option'), { value: '', textContent: t('history.tagAny') }),
    ...tags.map((x) => Object.assign(document.createElement('option'), { value: x.tag, textContent: `#${x.tag} (${x.n})` })),
  );
  if (f.tag && !tags.some((x) => x.tag.toLowerCase() === f.tag.toLowerCase())) sel.append(Object.assign(document.createElement('option'), { value: f.tag, textContent: `#${f.tag}` }));
  sel.value = f.tag;
}

/** 거르기 값 일부를 바꾸고 목록을 다시 그린다 */
function setHistoryFilters(patch) {
  historyView.filters = HSU.cleanFilters({ ...historyView.filters, ...patch });
  renderHistoryFilters();
  renderHistoryList();
}

function renderFilterBadge() {
  const n = HSU.activeCount(historyView.filters) + (historyView.archive ? 1 : 0);
  const btn = $('#historyFilterBtn');
  btn.textContent = n ? t('history.filtersOn', { n }) : t('history.filters');
  btn.classList.toggle('on', n > 0);
  for (const b of document.querySelectorAll('#historyGroup button')) b.classList.toggle('active', b.dataset.group === historyView.group);
}

$('#historyFilterBtn').addEventListener('click', () => {
  const box = $('#historyFilters');
  box.hidden = !box.hidden;
  if (!box.hidden) renderHistoryFilters();
});
$('#hfPeriod').addEventListener('change', (e) => setHistoryFilters({ period: e.target.value }));
$('#hfFrom').addEventListener('change', (e) => setHistoryFilters({ from: e.target.value }));
$('#hfTo').addEventListener('change', (e) => setHistoryFilters({ to: e.target.value }));
$('#hfRating').addEventListener('change', (e) => setHistoryFilters({ rating: e.target.value }));
$('#hfSource').addEventListener('change', (e) => setHistoryFilters({ source: e.target.value }));
$('#hfArchive').addEventListener('change', (e) => {
  historyView.archive = e.target.checked;
  renderHistoryList();
});
$('#hfTag').addEventListener('change', (e) => setHistoryFilters({ tag: e.target.value }));
for (const box of document.querySelectorAll('[data-hf]')) {
  box.addEventListener('change', () => {
    const k = box.dataset.hf;
    if (k === 'star' || k === 'project') return setHistoryFilters({ [k]: box.checked });
    const has = new Set(historyView.filters.has);
    box.checked ? has.add(k) : has.delete(k);
    setHistoryFilters({ has: [...has] });
  });
}
$('#hfReset').addEventListener('click', () => {
  historyView.archive = false;
  historyView.filters = HSU.cleanFilters({});
  renderHistoryFilters();
  renderHistoryList();
});
for (const b of document.querySelectorAll('#historyGroup button')) {
  b.addEventListener('click', () => {
    historyView.group = b.dataset.group === 'threads' ? 'threads' : 'records';
    try {
      localStorage.setItem(HISTORY_VIEW_KEY, JSON.stringify({ group: historyView.group }));
    } catch {}
    renderHistoryList();
  });
}

// ---------- 여러 기록 골라 내보내기 ----------

function renderPickedBar() {
  const n = historyView.picked.size;
  $('#historyPicked').hidden = !n;
  $('#historyPickedCount').textContent = t('history.selectedCount', { n });
}

/** 고른 기록들을 문서 하나로 (목록에 보이는 순서 = 최근 것부터 → 문서는 오래된 것부터) */
async function exportPicked(kind) {
  const ids = [...historyView.picked];
  const recs = (await Promise.all(ids.map((id) => host.history.get(id)))).filter(Boolean).sort((a, b) => (a.at || 0) - (b.at || 0));
  if (!recs.length) return;
  await exportDoc(EX.docFromRecords(recs), kind, $('#historyPickedCount'));
}
$('#historyPickMd').addEventListener('click', () => exportPicked('md'));
$('#historyPickHtml').addEventListener('click', () => exportPicked('html'));
$('#historyPickClear').addEventListener('click', () => {
  historyView.picked.clear();
  renderHistoryList();
});

// ---------- 오른쪽: 기록 하나 ----------

/** 즐겨찾기 · 태그 줄 (사이드탭 기록은 사이드탭이 쓰는 칸이라 바꾸지 않는다) */
function historyMarks(rec, archived = false) {
  const box = document.createElement('div');
  box.className = 'history-marks';
  if (rec.source === 'side') {
    box.append(span('muted-label', t('history.tagsSideNote')));
    return box;
  }
  if (archived) {
    box.append(span('muted-label', t('history.archivedNote'))); // 보관된 기록은 보기 · 지우기만 (v0.35.0)
    return box;
  }
  const star = button(rec.star ? '★' : '☆', rec.star ? t('history.starOn') : t('history.starOff'), async () => {
    const v = await host.history.setStar(rec.id, !rec.star);
    if (v !== null && v !== undefined) renderHistoryList();
  });
  star.className = `star-btn${rec.star ? ' on' : ''}`;
  const tags = Array.isArray(rec.tags) ? rec.tags : [];
  const save = async (next) => {
    const got = await host.history.setTags(rec.id, next);
    if (Array.isArray(got)) renderHistoryList();
  };
  const chips = tags.map((tag) => {
    const chip = button(`#${tag} ✕`, t('history.tagRemove', { tag }), () => save(tags.filter((x) => x !== tag)));
    chip.className = 'tag-chip';
    return chip;
  });
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tag-input';
  input.placeholder = t('history.tagsPlaceholder');
  input.maxLength = 200;
  input.hidden = tags.length >= HSU.MAX_TAGS;
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || !input.value.trim()) return;
    save([...tags, ...HSU.cleanTags(input.value)]);
  });
  box.append(star, span('muted-label', t('history.tags')), ...chips, input);
  if (rec.kind || rec.project) box.append(span('kind-badge', rec.project ? t('history.projectBadge', { name: rec.project.name }) : kindLabel(rec.kind)));
  return box;
}

/** 기록 하나의 답변 칸들 (+ 종합 · 토론 결론) */
function recordColumns(rec) {
  const columns = (rec.targets || []).map((id) => {
    const a = rec.answers?.[id];
    const svc = state.services.find((s) => s.id === id);
    return {
      name: a?.name || svc?.name || id,
      color: svc?.color || 'var(--muted)',
      text: a?.text || '',
      md: a?.md,
      note: a ? ANSWER_STATE_TEXT[a.state] : t('ui.history.waiting'),
      emptyText: a ? t('ui.history.noSavedAnswer') : t('ui.history.answerPending'),
    };
  });
  for (const sy of rec.synth || []) {
    if (sy.mode === 'debate') columns.push({ name: t('chain.debateResultCol', { judge: sy.judge }), color: 'var(--ok)', text: sy.text, md: sy.md });
    else if (sy.mode !== 'analysis') columns.push({ name: t('ui.history.synthColumn', { judge: sy.judge }), color: 'var(--accent)', text: sy.text, md: sy.md });
  }
  const cols = document.createElement('div');
  cols.className = 'compare-cols';
  cols.style.gridTemplateColumns = `repeat(${Math.max(columns.length, 1)}, minmax(0, 1fr))`;
  cols.replaceChildren(...columns.map(answerColumn));
  return { cols, columns };
}

function questionBox(rec) {
  const question = document.createElement('div');
  question.className = 'history-question';
  question.textContent = rec.question || NO_TEXT;
  if (rec.files?.length) question.append(document.createElement('br'), span('history-files', `[+] ${filesLine(rec.files)}`));
  return question;
}

/** 기록 화면 오른쪽: 고른 기록의 질문과 답변 전체 */
async function renderHistoryDetail(id) {
  const rec = await host.history.get(id);
  const box = $('#historyDetail');
  if (!rec) return box.replaceChildren();

  const head = document.createElement('div');
  head.className = 'history-detail-head';
  const time = span('muted-label', fmtTime(rec.at));
  head.append(
    time,
    button(t('ui.history.reuse'), t('ui.history.reuseTitle'), () => {
      $('#prompt').value = rec.question;
      host.setView('panels');
      $('#prompt').focus();
    }),
    button(t('ui.history.copyMd'), t('ui.history.copyMdTitle'), async () => {
      await host.copyText(recordToMarkdown(rec));
      flash(time, t('ui.copied'));
    }),
    button(t('ui.history.saveMd'), t('ui.history.saveMdTitle'), () => exportDoc(EX.docFromRecord(rec), 'md', time)),
    button(t('ui.history.saveHtml'), t('ui.history.saveHtmlTitle'), () => exportDoc(EX.docFromRecord(rec), 'html', time)),
    button(t('ui.delete'), t('ui.history.deleteTitle'), async () => {
      await host.history.remove(rec.id);
      historyView.picked.delete(rec.id);
      historySelected = null;
      renderHistoryList();
    }),
  );

  const { cols, columns } = recordColumns(rec);
  // 분석 결과(최신 것)는 답변 칸 위에 표로. AI 이름을 누르면 그 답변 칸으로 이동
  const analyses = (rec.synth || []).filter((sy) => sy.mode === 'analysis');
  const jump = (name, query) => {
    const idx = columns.findIndex((c) => c.name === name);
    const col = cols.children[idx];
    if (col) flashColumn(col, columns[idx].text, query);
  };
  // 분석이 2개 이상이면 둘을 골라 나란히 비교 (v0.26.0)
  const sources = columns.map((c) => ({ name: c.name, text: c.text })); // 출처 칸 (v0.32.0)
  const extra = analyses.length >= 2 ? [analysisCompareBlock(analyses, { onJump: jump, sources })] : analyses.length ? [analysisBlock(analyses[0], { onJump: jump, sources })] : [];
  // 이어 묻기 · 토론 (v0.26.0): 답변 칸 아래에 일어난 순서대로 — 답변 칸을 가리지 않게 접어 둔다 (누르면 펼침)
  const chain = Array.isArray(rec.chain) ? rec.chain : [];
  const after = [];
  if (chain.length) {
    const det = document.createElement('details');
    det.className = 'history-chain';
    det.append(Object.assign(document.createElement('summary'), { textContent: t('compare.chainTabCount', { n: chain.length }) }), chainBlock(chain, []));
    after.push(det);
  }
  const archived = historyView.items.some((x) => x.id === rec.id && x.archived);
  box.replaceChildren(head, historyMarks(rec, archived), questionBox(rec), ...extra, cols, ...after);
}

// ---------- 오른쪽: 대화 줄기 ----------

/** 대화 줄기 전체: 질문을 오래된 것부터, 질문마다 답변 칸. 한 줄기에 기록이 하나뿐이면 기록 하나로 보여 준다 */
async function renderThreadDetail(threadId, fallbackId) {
  const recs = (await host.history.thread?.(threadId).catch(() => [])) || [];
  if (recs.length < 2) return renderHistoryDetail(fallbackId);
  const box = $('#historyDetail');
  const head = document.createElement('div');
  head.className = 'history-detail-head';
  const title = span('muted-label', t('history.threadHead', { n: recs.length }));
  head.append(
    title,
    button(t('history.threadExportMd'), t('history.threadExportTitle'), () => exportDoc(EX.docFromThread(recs), 'md', title)),
    button(t('history.threadExportHtml'), t('history.threadExportTitle'), () => exportDoc(EX.docFromThread(recs), 'html', title)),
  );
  const rounds = recs.map((rec, i) => {
    const sec = document.createElement('section');
    sec.className = 'thread-round';
    const cap = document.createElement('div');
    cap.className = 'thread-cap';
    cap.append(span('thread-n', t('history.threadRound', { n: i + 1 })), span('muted-label', fmtTime(rec.at)));
    const open = button(t('history.openRecord'), t('history.openRecordTitle'), () => {
      historyView.group = 'records';
      historySelected = rec.id;
      renderHistoryList();
    });
    cap.append(open);
    sec.append(cap, questionBox(rec), recordColumns(rec).cols);
    return sec;
  });
  const list = document.createElement('div');
  list.className = 'thread-list';
  list.append(...rounds);
  box.replaceChildren(head, list);
}

let searchTimer = null;
$('#historySearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderHistoryList, 200);
});
$('#historyClose').addEventListener('click', () => host.setView('panels'));
$('#historyClear').addEventListener('click', async () => {
  if (!confirm(t('ui.history.clearConfirm'))) return;
  await host.history.clear();
  historyView.picked.clear();
  renderHistoryList();
});
