// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/renderer/renderer-views.js)
'use strict';

// 앱 화면 — 답변 비교 · 질문·답변 기록 · 단축키 · 설정 · 응답 통계 화면 (Windows 앱과 크롬 확장이 똑같이 씀).
// renderer.js 다음, renderer-compose.js 앞에 읽힌다 (v0.24.0에서 renderer.js를 셋으로 나눔).
// 세 파일은 감싸지 않은 보통 스크립트라 맨 위에 둔 이름($, state, panels, button, t …)을 서로 그대로 쓴다.
// 주의: 파일을 읽는 순간 바로 부르는 코드는 앞 파일의 것만 쓸 수 있다 (뒤 파일의 함수는 아직 없음).
//
// [쉽게 말하면] 패널 말고 따로 뜨는 화면들(비교 · 기록 · 설정)을 그리는 파일입니다.

// ---------- 답변 비교 ----------

// 답변 비교 화면에는 탭이 두 개 있습니다.
//   답변: AI마다 최신 답변을 나란히 (차이 강조를 켜면 기준 답변과 다른 문장만 표시)
//   분석: 판정 AI(종합 담당)가 공통 의견 · 이견 표 · 근거 부족 · 최종 답변으로 정리한 결과 (shared/analysis.js가 읽음)
const AN = MLA.analysis;
const COMPARE_PREFS_KEY = 'mla-compare-view';
const compareView = { tab: 'answers', diff: false, base: null, answers: [], analysis: null, pending: null, error: null };
try {
  const saved = JSON.parse(localStorage.getItem(COMPARE_PREFS_KEY) || '{}');
  if (saved.tab === 'analysis') compareView.tab = 'analysis';
  compareView.diff = saved.diff === true;
} catch {}
const saveCompareView = () => {
  try {
    localStorage.setItem(COMPARE_PREFS_KEY, JSON.stringify({ tab: compareView.tab, diff: compareView.diff }));
  } catch {}
};

/** 답변 비교 화면: 마지막 질문과 각 AI의 최신 답변(또는 분석 결과)을 보여 줍니다. */
async function renderCompare() {
  const { question, answers, analysis } = await host.getAnswers();
  $('#compareQuestion').textContent = question || '(아직 공통 입력창으로 보낸 질문이 없습니다)';
  compareView.answers = answers;
  compareView.analysis = analysis || null;
  compareView.question = question;
  renderCompareTabs();
  renderCompareAnswers();
  renderCompareAnalysis();
}

function renderCompareTabs() {
  $('#compare').dataset.ctab = compareView.tab;
  for (const b of document.querySelectorAll('#compareTabs [data-ctab]')) {
    const on = b.dataset.ctab === compareView.tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  }
  const n = compareView.analysis ? AN.parseAnalysis(compareView.analysis.md || compareView.analysis.text, { names: compareView.analysis.names }) : null;
  const tab = document.querySelector('#compareTabs [data-ctab="analysis"]');
  tab.textContent = n?.ok ? `분석 · 이견 ${n.disagreements.length}` : '분석';
}

/** 답변 탭: 칸마다 답변. 차이 강조를 켜면 기준 답변(diffBase)과 다른 문장을 표시합니다. */
function renderCompareAnswers() {
  const answers = compareView.answers;
  const withText = answers.filter((a) => a.text);
  if (!withText.some((a) => a.id === compareView.base)) compareView.base = withText[0]?.id || null;
  const select = $('#diffBase');
  select.replaceChildren(
    ...withText.map((a) => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = `기준: ${a.name}`;
      return opt;
    }),
  );
  select.value = compareView.base || '';
  select.hidden = !compareView.diff || withText.length < 2;
  const toggle = $('#diffToggle');
  toggle.classList.toggle('active', compareView.diff);
  toggle.setAttribute('aria-pressed', String(compareView.diff));
  toggle.disabled = withText.length < 2;

  const base = compareView.diff && withText.length >= 2 ? answers.find((a) => a.id === compareView.base) : null;
  const cols = $('#compareCols');
  cols.style.gridTemplateColumns = `repeat(${Math.max(answers.length, 1)}, minmax(0, 1fr))`;
  cols.replaceChildren(
    ...answers.map((a) => {
      if (!base || !a.text) return answerColumn(a);
      if (a.id === base.id) return answerColumn({ ...a, badge: '기준' });
      const marks = AN.diffMarks(base.text, a.text);
      return answerColumn({ ...a, marks, badge: `새 내용 ${Math.round(AN.changedRatio(marks) * 100)}%` });
    }),
  );
}

/** 분석 탭: 분석 결과(없으면 안내와 분석 요청 버튼) */
function renderCompareAnalysis() {
  const box = $('#analysisView');
  const run = $('#analysisRun');
  run.disabled = !!compareView.pending || compareView.answers.filter((a) => a.text).length < 2;
  run.textContent = compareView.analysis ? '다시 분석' : '분석 요청';
  const pending = compareView.pending
    ? [span('analysis-note pending', `${compareView.pending}이(가) 분석하는 중입니다… 끝나면 여기에 표로 나옵니다`)]
    : compareView.error
      ? [span('analysis-note', compareView.error)] // 지난 분석 요청이 실패한 이유 (시간 초과 · 답변 없음 등)
      : [];
  if (!compareView.analysis) {
    const empty = document.createElement('div');
    empty.className = 'analysis-empty';
    const judge = state.services.find((s) => s.id === $('#synthTarget').value)?.name || '종합 담당 AI';
    empty.append(
      span('analysis-empty-title', '아직 분석 결과가 없습니다'),
      span('muted-label', `분석 요청을 누르면 ${judge}에게 답변들의 공통 의견 · 이견 · 근거 부족 · 최종 답변을 정해진 형식으로 정리해 달라고 보냅니다. 판정 AI는 입력창 아래 종합 담당에서 고릅니다.`),
    );
    return box.replaceChildren(...pending, empty);
  }
  box.replaceChildren(...pending, analysisBlock(compareView.analysis, { onJump: jumpToAnswer }));
}

/** 이견 표에서 AI 이름을 누르면: 답변 탭으로 가서 그 AI 칸으로 이동하고 잠깐 빛나게 */
function jumpToAnswer(name) {
  const svc = state.services.find((s) => s.name === name);
  if (!svc) return;
  compareView.tab = 'answers';
  saveCompareView();
  renderCompareTabs();
  const idx = compareView.answers.findIndex((a) => a.id === svc.id);
  const col = $('#compareCols').children[idx];
  if (!col) return;
  col.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  col.classList.remove('jump-flash');
  void col.offsetWidth; // 애니메이션을 다시 시작하려고
  col.classList.add('jump-flash');
}

/**
 * 분석 결과 하나를 그립니다 (비교 화면 · 기록 화면 공용).
 * entry: { judge, at, md, text, names }, onJump(name): 이견 · 근거 부족의 AI 이름을 눌렀을 때
 */
function analysisBlock(entry, { onJump } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'analysis';
  const raw = entry.md || entry.text || '';
  const names = entry.names || [];
  const res = AN.parseAnalysis(raw, { names });

  const head = document.createElement('div');
  head.className = 'analysis-head';
  const meta = span('muted-label', `판정 ${entry.judge} · ${fmtTime(entry.at)}`);
  head.append(
    meta,
    button('분석 복사', '분석 답변을 Markdown 그대로 복사', async () => {
      await host.copyText(raw);
      flash(meta, '복사했습니다');
    }),
  );
  wrap.append(head);

  if (!res.ok) {
    const note = span('analysis-note', `정해진 형식이 아니라서 글 그대로 보여 줍니다 (${res.reason})`);
    const body = document.createElement('div');
    body.className = 'analysis-raw';
    body.textContent = raw || '(빈 답변)';
    wrap.append(note, body);
    return wrap;
  }

  const colorOf = (name) => state.services.find((s) => s.name === name)?.color || 'var(--muted)';
  const nameChip = (name) => {
    const b = button(name, `${name} 답변으로 이동`, () => onJump?.(name));
    b.className = 'an-chip';
    b.style.setProperty('--svc', colorOf(name));
    b.disabled = !onJump || !state.services.some((s) => s.name === name);
    return b;
  };
  const section = (title, count) => {
    const sec = document.createElement('section');
    sec.className = 'analysis-sec';
    const h = document.createElement('h3');
    h.append(span('', title));
    if (count !== undefined) h.append(span('an-count', String(count)));
    sec.append(h);
    return sec;
  };
  const list = (items, render) => {
    const ul = document.createElement('ul');
    for (const it of items) {
      const li = document.createElement('li');
      render(li, it);
      ul.append(li);
    }
    return ul;
  };

  // 공통 의견
  const common = section('공통 의견', res.common.length);
  common.append(res.common.length ? list(res.common, (li, t) => (li.textContent = t)) : span('muted-label', '정리된 공통 의견이 없습니다'));

  // 이견 표: 쟁점 | AI별 입장 | 판단
  const dis = section('이견', res.disagreements.length);
  dis.classList.add('an-disagree');
  if (!res.disagreements.length) dis.append(span('an-agree', '이견이 없습니다 — 답변들이 같은 방향입니다'));
  else {
    const cols = [...new Set([...names, ...res.disagreements.flatMap((d) => d.positions.map((p) => p.name))])];
    const hasText = res.disagreements.some((d) => d.positions.some((p) => p.text));
    const table = document.createElement('table');
    table.className = 'an-table';
    const tr = document.createElement('tr');
    for (const label of ['쟁점', ...(hasText ? cols : ['언급한 AI']), '판단']) {
      const th = document.createElement('th');
      if (hasText && cols.includes(label)) th.append(nameChip(label));
      else th.textContent = label;
      tr.append(th);
    }
    const thead = document.createElement('thead');
    thead.append(tr);
    const tbody = document.createElement('tbody');
    for (const d of res.disagreements) {
      const row = document.createElement('tr');
      const td = (text, cls) => {
        const c = document.createElement('td');
        if (cls) c.className = cls;
        c.textContent = text;
        return c;
      };
      row.append(td(d.topic, 'an-topic'));
      if (hasText) {
        for (const name of cols) {
          const p = d.positions.find((x) => x.name === name);
          const c = td(p?.text && p.text !== '-' ? p.text : '—', p?.text && p.text !== '-' ? '' : 'an-blank');
          if (p && onJump && state.services.some((s) => s.name === name)) {
            c.classList.add('an-jump');
            c.title = `${name} 답변으로 이동`;
            c.addEventListener('click', () => onJump(name));
          }
          row.append(c);
        }
      } else {
        const c = document.createElement('td');
        c.append(...d.positions.map((p) => nameChip(p.name)));
        row.append(c);
      }
      row.append(td(d.verdict || '—', d.verdict ? 'an-verdict' : 'an-blank'));
      tbody.append(row);
    }
    table.append(thead, tbody);
    const scroller = document.createElement('div');
    scroller.className = 'an-table-wrap';
    scroller.append(table);
    dis.append(scroller);
  }

  // 근거 부족
  const weak = section('근거 부족', res.unsupported.length);
  weak.append(
    res.unsupported.length
      ? list(res.unsupported, (li, u) => {
          if (u.name) li.append(nameChip(u.name), ' ');
          li.append(u.text);
        })
      : span('muted-label', '근거가 부족하다고 짚은 내용이 없습니다'),
  );

  // 최종 답변
  const fin = section('최종 답변');
  fin.classList.add('an-final');
  const finBody = document.createElement('div');
  finBody.className = 'analysis-raw';
  finBody.textContent = res.final;
  const copyFinal = button('복사', '최종 답변 복사', async () => {
    await host.copyText(res.final);
    flash(meta, '최종 답변을 복사했습니다');
  });
  fin.querySelector('h3').append(copyFinal);
  fin.append(finBody);

  const grid = document.createElement('div');
  grid.className = 'analysis-grid';
  grid.append(dis, common, weak, fin);
  wrap.append(grid);
  return wrap;
}

/** 답변 한 칸 (비교 화면·기록 화면 공용). a: { name, color, text, md?, note?, emptyText?, marks?, badge? } */
function answerColumn(a) {
  const col = document.createElement('article');
  col.className = 'compare-col';
  col.style.setProperty('--svc', a.color);
  const head = document.createElement('div');
  head.className = 'compare-col-head';
  const count = span('muted-label', a.text ? `${a.text.length.toLocaleString()}자` : a.note || '답변 없음');
  const copy = button('복사', `${a.name} 답변 복사`, async () => {
    await host.copyText(a.md || a.text); // Markdown이 있으면 서식(표·코드)을 살려 복사
    flash(count, '복사했습니다');
  });
  copy.disabled = !a.text;
  head.append(span('dot ready'), span('name', a.name));
  if (a.badge) head.append(span('diff-badge', a.badge));
  head.append(count, copy);
  const body = document.createElement('div');
  body.className = 'compare-body';
  if (a.marks) {
    // 차이 강조: 기준 답변에 없는 문장만 <mark>로 표시 (글자는 textContent로만 넣는다)
    body.classList.add('diffing');
    for (const m of a.marks) {
      if (!m.changed) body.append(document.createTextNode(m.text));
      else {
        const mark = document.createElement('mark');
        mark.className = 'diff-add';
        mark.textContent = m.text;
        body.append(mark);
      }
    }
  } else body.textContent = a.text || a.emptyText || '이 패널에는 아직 답변이 없습니다.';
  body.classList.toggle('empty', !a.text);
  col.append(head, body);
  return col;
}

// 내보내기: 지금 비교 화면의 질문 · 답변 · 이번 질문의 분석
const compareDoc = () => EX.docFromCompare({ question: compareView.question, answers: compareView.answers, analysis: compareView.analysis });
$('#compareExportMd').addEventListener('click', () => exportDoc(compareDoc(), 'md', $('#compareQuestion')));
$('#compareExportHtml').addEventListener('click', () => exportDoc(compareDoc(), 'html', $('#compareQuestion')));

$('#compareTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-ctab]')?.dataset.ctab;
  if (!tab || tab === compareView.tab) return;
  compareView.tab = tab;
  saveCompareView();
  renderCompareTabs();
});
$('#diffToggle').addEventListener('click', () => {
  compareView.diff = !compareView.diff;
  saveCompareView();
  renderCompareAnswers();
});
$('#diffBase').addEventListener('change', (e) => {
  compareView.base = e.target.value;
  renderCompareAnswers();
});
$('#analysisRun').addEventListener('click', async () => {
  $('#analysisRun').disabled = true;
  const r = await host.runSynth($('#synthTarget').value || state.synthTarget, 'analysis');
  if (!r?.ok) {
    renderCompareAnalysis();
    $('#analysisView').prepend(span('analysis-note', r?.error || '분석을 요청하지 못했습니다'));
  }
});

$('#compareBtn').addEventListener('click', () => host.setView(state.chatView === 'compare' ? 'panels' : 'compare'));
$('#changesBtn').addEventListener('click', () => host.setView(state.chatView === 'changes' ? 'panels' : 'changes'));
$('#changesClose').addEventListener('click', () => host.setView('panels'));
$('#historyBtn').addEventListener('click', () => host.setView(state.chatView === 'history' ? 'panels' : 'history'));
$('#compareClose').addEventListener('click', () => host.setView('panels'));
$('#compareRefresh').addEventListener('click', renderCompare);

// ---------- 질문·답변 기록 ----------

const ANSWER_STATE_TEXT = { timeout: '시간 초과', 'no-answer': '답변 없음', error: '보내기 실패' };
let historySelected = null;

const fmtTime = (ms) =>
  new Date(ms).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 기록 화면 왼쪽: 보낸 질문 목록 (검색어가 있으면 걸러서) */
async function renderHistoryList() {
  const query = $('#historySearch').value;
  const items = await host.history.list(query);
  const list = $('#historyList');
  if (!items.length) {
    list.replaceChildren(span('history-empty', query ? '찾는 기록이 없습니다' : '아직 기록이 없습니다'));
    $('#historyDetail').replaceChildren();
    return;
  }
  if (!items.some((it) => it.id === historySelected)) historySelected = items[0].id;
  list.replaceChildren(
    ...items.map((it) => {
      const row = document.createElement('button');
      row.className = 'history-item';
      row.classList.toggle('active', it.id === historySelected);
      const meta =
        `${fmtTime(it.at)} · 답변 ${it.answered}/${it.targets}` +
        `${it.files ? ` · 첨부 ${it.files}` : ''}${it.synth ? ` · 종합 ${it.synth}` : ''}${it.analysis ? ` · 분석 ${it.analysis}` : ''}` +
        `${it.source === 'side' ? ' · side' : ''}`; // 사이드탭에서 보낸 질문 (v0.21.0)
      row.append(span('history-q', it.question || NO_TEXT), span('history-meta', meta));
      row.addEventListener('click', () => {
        historySelected = it.id;
        renderHistoryList();
      });
      return row;
    }),
  );
  renderHistoryDetail();
}

const NO_TEXT = '(글 없이 첨부 파일만 보냄)';
const filesLine = (files) => files.map((f) => `${f.name} (${fmtSize(f.size)})`).join(' · ');

// 기록 하나(질문 + 각 AI 답변 + 종합 · 분석)를 Markdown 글 하나로 엮습니다 (복사 · 내보내기 — shared/export.js).
const EX = MLA.exporter;
const recordToMarkdown = (rec) => EX.toMarkdown(EX.docFromRecord(rec));

/** 내보내기: 문서를 Markdown 또는 HTML 파일로 저장 (앱은 저장 창, 크롬 확장은 다운로드) → 결과를 el에 잠깐 보여 준다 */
async function exportDoc(doc, kind, el) {
  const text = kind === 'html' ? EX.toHtml(doc) : EX.toMarkdown(doc);
  const r = await host.saveFile({ name: EX.fileName(doc, kind), text, kind }).catch((err) => ({ ok: false, error: err.message }));
  if (r?.ok) flash(el, `저장했습니다: ${String(r.path).split(/[\\/]/).pop()}`);
  else if (!r?.cancelled) flash(el, r?.error || '저장하지 못했습니다');
}

/** 기록 화면 오른쪽: 고른 기록의 질문과 답변 전체 */
async function renderHistoryDetail() {
  const rec = await host.history.get(historySelected);
  const box = $('#historyDetail');
  if (!rec) return box.replaceChildren();

  const head = document.createElement('div');
  head.className = 'history-detail-head';
  const time = span('muted-label', fmtTime(rec.at));
  head.append(
    time,
    button('질문 다시 쓰기', '이 질문을 입력창에 넣습니다', () => {
      $('#prompt').value = rec.question;
      host.setView('panels');
      $('#prompt').focus();
    }),
    button('Markdown 복사', '질문과 답변을 Markdown으로 복사', async () => {
      await host.copyText(recordToMarkdown(rec));
      flash(time, '복사했습니다');
    }),
    button('MD 저장', '이 기록(질문 · 답변 · 종합 · 분석)을 Markdown 파일로 저장합니다', () => exportDoc(EX.docFromRecord(rec), 'md', time)),
    button('HTML 저장', '이 기록을 밝은 문서 모양 HTML 파일로 저장합니다 (브라우저에서 인쇄하면 PDF)', () => exportDoc(EX.docFromRecord(rec), 'html', time)),
    button('삭제', '이 기록을 지웁니다', async () => {
      await host.history.remove(rec.id);
      historySelected = null;
      renderHistoryList();
    }),
  );

  const question = document.createElement('div');
  question.className = 'history-question';
  question.textContent = rec.question || NO_TEXT;
  if (rec.files?.length) question.append(document.createElement('br'), span('history-files', `[+] ${filesLine(rec.files)}`));

  const cols = document.createElement('div');
  cols.className = 'compare-cols';
  const columns = rec.targets.map((id) => {
    const a = rec.answers[id];
    const svc = state.services.find((s) => s.id === id);
    return {
      name: a?.name || svc?.name || id,
      color: svc?.color || 'var(--muted)',
      text: a?.text || '',
      md: a?.md,
      note: a ? ANSWER_STATE_TEXT[a.state] : '기다리는 중',
      emptyText: a ? '저장된 답변이 없습니다.' : '답변을 기다리는 중이거나, 앱이 닫혀 저장되지 않았습니다.',
    };
  });
  for (const sy of rec.synth) {
    if (sy.mode !== 'analysis') columns.push({ name: `종합 · ${sy.judge}`, color: 'var(--accent)', text: sy.text, md: sy.md });
  }
  cols.style.gridTemplateColumns = `repeat(${Math.max(columns.length, 1)}, minmax(0, 1fr))`;
  cols.replaceChildren(...columns.map(answerColumn));
  // 분석 결과(최신 것)는 답변 칸 위에 표로. AI 이름을 누르면 그 답변 칸으로 이동
  const analyses = rec.synth.filter((sy) => sy.mode === 'analysis');
  const jump = (name) => {
    const idx = columns.findIndex((c) => c.name === name);
    const col = cols.children[idx];
    if (!col) return;
    col.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    col.classList.remove('jump-flash');
    void col.offsetWidth;
    col.classList.add('jump-flash');
  };
  const extra = analyses.length ? [analysisBlock(analyses[analyses.length - 1], { onJump: jump })] : [];
  box.replaceChildren(head, question, ...extra, cols);
}

let searchTimer = null;
$('#historySearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderHistoryList, 200);
});
$('#historyClose').addEventListener('click', () => host.setView('panels'));
$('#historyClear').addEventListener('click', async () => {
  if (!confirm('저장된 질문·답변 기록을 모두 지울까요? 되돌릴 수 없습니다.')) return;
  await host.history.clear();
  renderHistoryList();
});

// ---------- 단축키 ----------

// 본체가 "이 단축키가 눌렸어"라고 알려 오면 그에 맞는 버튼을 대신 누릅니다.
host.on('shortcut', (action) => {
  if (action === 'focus-composer') return $('#prompt').focus();
  if (action.startsWith('target:')) {
    const chip = document.querySelectorAll('#targetChips .chip')[Number(action.slice(7)) - 1];
    return chip?.click();
  }
  const click = { 'newchat-all': '#newChatAll', synth: '#synthBtn', 'copy-all': '#copyAll', 'reload-all': '#reloadAll' }[action];
  if (click) $(click).click();
});

$('#timeoutSelect').addEventListener('change', (e) => host.setSettings({ answerTimeoutMin: Number(e.target.value) }));

// 기록 최대 개수 (v0.24.0): 줄여서 지워지는 기록이 있으면 먼저 묻는다
$('#historyMaxSelect').addEventListener('change', async (e) => {
  const n = Number(e.target.value);
  const count = (await host.history.list('').catch(() => [])).filter((r) => r.source !== 'side').length;
  if (count > n && !confirm(t('settings.historyMaxShrink', { n, drop: count - n }))) {
    e.target.value = String(state.historyMax);
    return;
  }
  host.setSettings({ historyMax: n });
});

const REMOTE_SOURCE = { builtin: '앱에 들어 있는 셀렉터', cache: '저장해 둔 원격 셀렉터', remote: '원격 셀렉터' };

// 설정 화면의 "사이트 셀렉터 원격 갱신" 상태 글
function renderRemoteStatus() {
  const r = state.remote || {};
  const parts = [
    `지금 쓰는 것: ${REMOTE_SOURCE[r.source] || r.source}${r.version ? ` (버전 ${r.version}${r.updated ? `, ${r.updated}` : ''})` : ''}`,
  ];
  if (r.services?.length) parts.push(`바뀐 서비스: ${r.services.join(', ')}`);
  if (r.ignored?.length) parts.push(`보안상 무시한 항목: ${r.ignored.slice(0, 6).join(', ')}${r.ignored.length > 6 ? ' 외' : ''} (앱 업데이트로만 바뀜)`);
  if (r.checkedAt) parts.push(`마지막 확인 ${fmtTime(r.checkedAt)}`);
  if (r.error) parts.push(`확인 실패: ${r.error}`);
  $('#remoteStatus').textContent =
    `서비스 화면이 바뀌어 입력창·답변을 못 찾을 때, 앱을 다시 설치하지 않고 GitHub에서 고친 셀렉터를 받아 씁니다. ${parts.join(' · ')}`;
  $('#remoteToggle').checked = !!state.remoteSelectors;
  $('#remoteRefresh').disabled = !state.remoteSelectors;
}

$('#remoteToggle').addEventListener('change', (e) => host.setSettings({ remoteSelectors: e.target.checked }));
// 로컬 LLM 설정 (v0.16.0). 크롬 확장은 켤 때 이 PC 주소 권한(localhost)을 그때 묻는다 (host.local.setPrefs가 처리)
$('#localEnabled').addEventListener('change', async (e) => {
  const r = await host.local.setPrefs({ enabled: e.target.checked });
  if (!r?.ok) {
    e.target.checked = false;
    $('#localStatus').textContent = r?.error || '켜지 못했습니다';
  }
  renderLocalSettings();
  if (r?.ok && r.local.enabled) refreshLocalModels();
});
$('#localBase').addEventListener('change', async (e) => {
  const r = await host.local.setPrefs({ baseUrl: e.target.value });
  $('#localStatus').textContent = r?.ok ? '주소를 저장했습니다 — 연결 확인을 누르세요' : r?.error || '저장하지 못했습니다';
  if (!r?.ok) e.target.value = state.local?.baseUrl || '';
});
$('#localModel').addEventListener('change', (e) => host.local.setPrefs({ model: e.target.value }));
$('#localCheck').addEventListener('click', () => refreshLocalModels($('#localCheck')));

$('#remoteRefresh').addEventListener('click', async () => {
  $('#remoteRefresh').disabled = true;
  await host.refreshRemote();
  $('#remoteRefresh').disabled = false;
});

// ---------- 응답 통계 (v0.13.0) ----------
// 기록에 남은 숫자(보내기 성공 · 완료 · 실패 · 시간 · 글자 수)로 AI별 표를 그린다. 정확도는 재지 않는다.
const fmtSec = (ms) => (ms == null ? '–' : ms >= 60000 ? `${Math.floor(ms / 60000)}분 ${Math.round((ms % 60000) / 1000)}초` : `${(ms / 1000).toFixed(1)}초`);
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '–');

// 만족도 (v0.23): "75% (3/4)" — 평가가 하나도 없으면 "—"
const fmtSatisfaction = (r) => {
  const good = Number.isFinite(r?.good) ? r.good : 0;
  const n = good + (Number.isFinite(r?.bad) ? r.bad : 0);
  return n ? `${Math.round((good / n) * 100)}% (${good}/${n})` : '—';
};

async function renderStatsTable() {
  const st = await host.history.stats?.().catch(() => null);
  const table = $('#statsTable');
  if (!table) return;
  const apply = window.projectApplyStats?.() || null; // 이 프로젝트의 적용 기록 { AI 이름: { applied, reverted } }
  const cols = ['서비스', '질문', '답변 완료', '시간 초과 · 답 없음', '보내기 실패', '사용 한도', '첫 응답 (중앙값)', '완료까지 (중앙값)', '평균 글자 수', '만족도'];
  if (apply) cols.push('수정안 적용 · 되돌림');
  const head = document.createElement('tr');
  for (const t of cols) head.append(Object.assign(document.createElement('th'), { textContent: t }));
  const rows = (st?.rows || []).map((r) => {
    const svc = state.services.find((s) => s.id === r.id);
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.append(span('dot ready'), ` ${svc?.name || r.name}`);
    name.style.setProperty('--svc', svc?.color || 'var(--muted)');
    tr.append(name);
    const cell = (text, title) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (title) td.title = title;
      tr.append(td);
      return td;
    };
    cell(String(r.asked));
    cell(`${r.done} (${pct(r.done, r.asked)})`);
    cell(String(r.timeout + r.noAnswer), `시간 초과 ${r.timeout} · 답변 없음 ${r.noAnswer}`);
    cell(String(r.sendFail));
    const lim = cell(String(r.limit));
    if (r.limit) lim.dataset.state = 'warn';
    cell(fmtSec(r.firstMedianMs));
    cell(fmtSec(r.doneMedianMs));
    cell(r.charsAvg == null ? '–' : r.charsAvg.toLocaleString());
    cell(fmtSatisfaction(r), '패널 머리줄의 [+1] 좋았음 / [-1] 별로였음으로 센 만족도: 좋았음 / (좋았음 + 별로였음)');
    if (apply) {
      const a = apply[svc?.name || r.name];
      cell(a ? `${a.applied} · ${a.reverted}` : '–', '이 프로젝트의 적용 기록에서 센 수 (적용 · 그중 되돌린 것)');
    }
    return tr;
  });
  const empty = Object.assign(document.createElement('tr'), { textContent: '아직 기록이 없습니다' });
  table.replaceChildren(head, ...(rows.length ? rows : [empty]));
  $('#statsNote').textContent = st?.records
    ? `기록 ${st.records}개 기준 (${fmtTime(st.since)}부터). 기록을 지우면 통계도 함께 지워집니다. 정확도는 재지 않습니다 — 보내기 · 완료 · 시간 · 글자 수만 셉니다. v0.13.0 이전 기록에는 시간 정보가 없어 –로 나옵니다.`
    : '';
}

// 저장 방식 안내 (v0.22.1): Windows 앱은 이 Windows 계정에 묶인 암호화, 크롬 확장은 암호화하지 않음
function renderStorage() {
  const s = state?.storage;
  const el = $('#storageStatus');
  if (!el || !s) return;
  el.textContent = s.extension
    ? '기록 · 설정 · 라이브러리는 크롬 프로필의 확장 저장소에 암호화 없이 저장됩니다. 크롬 확장에는 OS 열쇠 보관소가 없어 암호화해도 열쇠를 데이터 옆에 둘 수밖에 없기 때문입니다. 필요하면 기록 화면의 "기록 전체 삭제"로 지우세요.'
    : s.encrypted
      ? '기록 · 설정 · 라이브러리 · 프로젝트 상태(되돌리기용 원본 포함)를 이 PC의 앱 데이터 폴더에 암호화해 저장합니다 (Windows DPAPI — 같은 Windows 계정에서만 풀림). 파일만 복사해 가거나 다른 계정에서는 읽을 수 없고, 같은 계정에서 도는 프로그램까지 막지는 못합니다.'
      : '이 환경에서는 암호화를 쓸 수 없어 기록 · 설정을 평문으로 저장합니다.';
}
function renderSettings() {
  renderRemoteStatus();
  renderUpdate();
  renderStorage();
  renderDiagTable();
  renderStatsTable();
  renderLocalSettings();
  const select = $('#timeoutSelect');
  select.replaceChildren(
    ...state.timeoutChoices.map((m) => Object.assign(document.createElement('option'), { value: m, textContent: `${m}분` })),
  );
  select.value = String(state.answerTimeoutMin);
  const maxSel = $('#historyMaxSelect');
  maxSel.replaceChildren(
    ...(state.historyMaxChoices || []).map((n) =>
      Object.assign(document.createElement('option'), { value: n, textContent: t('settings.historyMaxOption', { n }) }),
    ),
  );
  maxSel.value = String(state.historyMax);
}

/** 설정·단축키(?) 화면: 대기 시간 고르기, 원격 갱신 상태, 단축키 표 */
async function renderHelp() {
  renderSettings();
  const rows = await host.shortcuts();
  $('#helpTable').replaceChildren(
    ...rows.map((r) => {
      const tr = document.createElement('tr');
      const k = document.createElement('td');
      k.append(...r.keys.split(' ').map((part) => Object.assign(document.createElement('kbd'), { textContent: part })));
      const d = document.createElement('td');
      d.textContent = r.label;
      tr.append(k, d);
      return tr;
    }),
  );
}

$('#helpBtn').addEventListener('click', () => host.setView(state.chatView === 'help' ? 'panels' : 'help'));
$('#helpClose').addEventListener('click', () => host.setView('panels'));
