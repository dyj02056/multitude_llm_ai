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
// mode: 답변 탭의 보기 방식 (v0.32.0) 'columns'(나란히, 기본) · 'align'(문단 맞추기) · 'code'(코드만) · 'table'(표 비교) — shared/compare-modes.js
const compareView = { tab: 'answers', diff: false, mode: 'columns', base: null, answers: [], analysis: null, pending: null, error: null };
try {
  const saved = JSON.parse(localStorage.getItem(COMPARE_PREFS_KEY) || '{}');
  if (saved.tab === 'analysis') compareView.tab = 'analysis';
  compareView.diff = saved.diff === true;
  compareView.mode = MLA.compareModes.normalizeMode(saved.mode);
} catch {}
const saveCompareView = () => {
  try {
    localStorage.setItem(COMPARE_PREFS_KEY, JSON.stringify({ tab: compareView.tab, diff: compareView.diff, mode: compareView.mode }));
  } catch {}
};

/** 답변 비교 화면: 마지막 질문과 각 AI의 최신 답변(또는 분석 결과)을 보여 줍니다. */
async function renderCompare() {
  const { question, answers, analysis, analyses, chain, debates, factchecks } = await host.getAnswers();
  $('#compareQuestion').textContent = question || t('ui.compare.noQuestion');
  compareView.answers = answers;
  compareView.analysis = analysis || null;
  compareView.analyses = analyses || []; // 이번 질문의 분석 전부 (v0.26.0 다시 분석 비교)
  compareView.chain = chain || []; // 이어 묻기 · 토론 (v0.26.0)
  compareView.debates = debates || [];
  compareView.factchecks = factchecks || []; // 사실 확인 결과 (v0.33.0)
  compareView.question = question;
  renderCompareTabs();
  renderCompareAnswers();
  renderCompareAnalysis();
  renderCompareChain();
  window.renderCompareFact?.();
}

/** 이어 묻기 · 토론 탭 (v0.26.0, chain-views.js chainBlock) */
function renderCompareChain() {
  $('#chainView').replaceChildren(chainBlock(compareView.chain || [], compareView.debates || []));
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
  tab.textContent = n?.ok ? t('ui.compare.analysisTabCount', { n: n.disagreements.length }) : t('ui.compare.analysisTab');
  const count = (compareView.chain || []).length + (compareView.debates || []).length;
  window.renderCompareFact?.(); // 사실 확인 탭 이름의 개수도 맞춘다
  document.querySelector('#compareTabs [data-ctab="chain"]').textContent = count ? t('compare.chainTabCount', { n: count }) : t('compare.chainTab');
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
      opt.textContent = t('ui.compare.baseOption', { name: a.name });
      return opt;
    }),
  );
  select.value = compareView.base || '';
  select.hidden = !compareView.diff || withText.length < 2;
  const toggle = $('#diffToggle');
  toggle.classList.toggle('active', compareView.diff);
  toggle.setAttribute('aria-pressed', String(compareView.diff));
  toggle.disabled = withText.length < 2;

  // 보기 방식 (v0.32.0): 나란히가 아니면 같은 답변 글을 다르게 나눠 보여 준다. 기준 답변 고르기는 문단 맞추기 · 코드 차이에도 쓴다
  const mode = MLA.compareModes.normalizeMode(compareView.mode);
  $('#compareMode').value = mode;
  select.hidden = withText.length < 2 || !(compareView.diff || mode === 'align' || mode === 'code');
  const base = compareView.diff && withText.length >= 2 ? answers.find((a) => a.id === compareView.base) : null;
  const cols = $('#compareCols');
  if (window.renderCompareMode(cols, answers, compareView.base, compareView.diff)) return;
  cols.style.gridTemplateColumns = `repeat(${Math.max(answers.length, 1)}, minmax(0, 1fr))`;
  cols.replaceChildren(
    ...answers.map((a) => {
      if (!base || !a.text) return answerColumn(a);
      if (a.id === base.id) return answerColumn({ ...a, badge: t('ui.compare.baseBadge') });
      const marks = AN.diffMarks(base.text, a.text);
      return answerColumn({ ...a, marks, badge: t('ui.compare.newBadge', { n: Math.round(AN.changedRatio(marks) * 100) }) });
    }),
  );
}

/** 분석 탭: 분석 결과(없으면 안내와 분석 요청 버튼) */
function renderCompareAnalysis() {
  const box = $('#analysisView');
  const run = $('#analysisRun');
  run.disabled = !!compareView.pending || compareView.answers.filter((a) => a.text).length < 2;
  run.textContent = compareView.analysis ? t('ui.analysis.rerun') : t('ui.analysis.run');
  const pending = compareView.pending
    ? [span('analysis-note pending', t('ui.analysis.pending', { name: compareView.pending }))]
    : compareView.error
      ? [span('analysis-note', compareView.error)] // 지난 분석 요청이 실패한 이유 (시간 초과 · 답변 없음 등)
      : [];
  if (!compareView.analysis) {
    const empty = document.createElement('div');
    empty.className = 'analysis-empty';
    const judge = state.services.find((s) => s.id === $('#synthTarget').value)?.name || t('ui.analysis.judgeFallback');
    empty.append(
      span('analysis-empty-title', t('ui.analysis.emptyTitle')),
      span('muted-label', t('ui.analysis.emptyBody', { judge })),
    );
    return box.replaceChildren(...pending, empty);
  }
  // 다시 분석했으면(분석 2개 이상) 두 분석을 골라 나란히 비교할 수 있다 (v0.26.0, chain-views.js)
  const list = compareView.analyses?.length ? compareView.analyses : [compareView.analysis];
  if (list.length >= 2) return box.replaceChildren(...pending, analysisCompareBlock(list, { onJump: jumpToAnswer, sources: compareView.answers }));
  box.replaceChildren(...pending, analysisBlock(compareView.analysis, { onJump: jumpToAnswer, sources: compareView.answers }));
}

/**
 * 이견 표에서 AI 이름을 누르면: 답변 탭으로 가서 그 AI 칸으로 이동하고 잠깐 빛나게.
 * query(쟁점 · 그 AI의 입장 글)가 있으면 그 답변에서 가장 관련 있는 문단을 강조하고 그 문단으로 스크롤 (v0.26.0)
 */
function jumpToAnswer(name, query) {
  const svc = state.services.find((s) => s.name === name);
  if (!svc) return;
  compareView.tab = 'answers';
  saveCompareView();
  renderCompareTabs();
  const idx = compareView.answers.findIndex((a) => a.id === svc.id);
  const col = $('#compareCols').children[idx];
  if (!col) return;
  flashColumn(col, compareView.answers[idx]?.text, query);
}

/** 답변 칸으로 이동 · 잠깐 빛나기 · 관련 문단 강조 (비교 화면 · 기록 화면 공용) */
function flashColumn(col, text, query) {
  const hit = query && text ? highlightRelated(col, text, query) : null;
  (hit || col).scrollIntoView({ block: hit ? 'center' : 'nearest', inline: 'center', behavior: 'smooth' });
  col.classList.remove('jump-flash');
  void col.offsetWidth; // 애니메이션을 다시 시작하려고
  col.classList.add('jump-flash');
}

/**
 * 분석 결과 하나를 그립니다 (비교 화면 · 기록 화면 공용).
 * entry: { judge, at, md, text, names }, onJump(name, query): 이견 · 근거 부족의 AI 이름을 눌렀을 때 (query: 관련 문단을 찾을 글)
 * unique: 다시 분석 비교에서 이 분석에만 있는 이견 쟁점 번호(Set) — 그 줄을 강조 (v0.26.0)
 * sources: [{ name, text }] 답변들 — 있으면 거기 나온 링크를 모아 "출처" 칸을 더한다 (v0.32.0)
 */
function analysisBlock(entry, { onJump, unique, sources } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'analysis';
  const raw = entry.md || entry.text || '';
  const names = entry.names || [];
  const res = AN.parseAnalysis(raw, { names });

  const head = document.createElement('div');
  head.className = 'analysis-head';
  const meta = span('muted-label', t('ui.analysis.meta', { judge: entry.judge, time: fmtTime(entry.at) }));
  head.append(
    meta,
    button(t('ui.analysis.copy'), t('ui.analysis.copyTitle'), async () => {
      await host.copyText(raw);
      flash(meta, t('ui.copied'));
    }),
  );
  // 합의율 (v0.32.0): 공통 의견 + 이견 줄의 "같은 입장 AI 비율"의 평균. 겹침으로 어림한 값이라고 알린다
  const agree = res.ok ? AN.agreementSummary(res, names) : null;
  if (agree && agree.rate !== null) {
    const chip = span('an-rate', t('analysis.rate', { n: agree.rate }));
    chip.title = t('analysis.rateTitle', { common: agree.common, disputed: agree.disputed });
    head.insertBefore(chip, head.children[1] || null);
  }
  wrap.append(head);

  if (!res.ok) {
    const note = span('analysis-note', t('ui.analysis.unparsed', { reason: res.reason }));
    const body = document.createElement('div');
    body.className = 'analysis-raw';
    body.textContent = raw || t('ui.analysis.emptyAnswer');
    wrap.append(note, body);
    return wrap;
  }

  const colorOf = (name) => state.services.find((s) => s.name === name)?.color || 'var(--muted)';
  const nameChip = (name, query) => {
    const b = button(name, t('ui.analysis.jumpTitle', { name }), () => onJump?.(name, query));
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
  const common = section(t('ui.analysis.common'), res.common.length);
  common.append(res.common.length ? list(res.common, (li, t) => (li.textContent = t)) : span('muted-label', t('ui.analysis.noCommon')));

  // 이견 표: 쟁점 | AI별 입장 | 판단
  const dis = section(t('ui.analysis.disagreements'), res.disagreements.length);
  dis.classList.add('an-disagree');
  if (!res.disagreements.length) dis.append(span('an-agree', t('ui.analysis.noDisagreements')));
  else {
    const cols = [...new Set([...names, ...res.disagreements.flatMap((d) => d.positions.map((p) => p.name))])];
    const hasText = res.disagreements.some((d) => d.positions.some((p) => p.text));
    const table = document.createElement('table');
    table.className = 'an-table';
    const tr = document.createElement('tr');
    for (const label of [t('ui.analysis.issue'), ...(hasText ? cols : [t('ui.analysis.mentionedBy')]), t('ui.analysis.verdict')]) {
      const th = document.createElement('th');
      if (hasText && cols.includes(label)) th.append(nameChip(label));
      else th.textContent = label;
      tr.append(th);
    }
    const thead = document.createElement('thead');
    thead.append(tr);
    const tbody = document.createElement('tbody');
    res.disagreements.forEach((d, di) => {
      const row = document.createElement('tr');
      const ag = agree.rows[di]; // 같은 입장인 AI 수 (입장 글이 없는 줄은 null)
      const td = (text, cls) => {
        const c = document.createElement('td');
        if (cls) c.className = cls;
        c.textContent = text;
        return c;
      };
      const topic = td(d.topic, 'an-topic');
      if (ag) {
        const b = span('an-agree-badge', t('analysis.agreeBadge', { agree: ag.agree, of: ag.of }));
        b.title = t('analysis.agreeTitle', { agree: ag.agree, of: ag.of, spoke: ag.spoke });
        topic.append(' ', b);
      }
      if (unique?.has(di)) {
        row.classList.add('an-unique'); // 다시 분석 비교: 이 분석에만 있는 쟁점
        topic.append(' ', span('an-unique-badge', t('analysis.onlyHere')));
      }
      row.append(topic);
      if (hasText) {
        for (const name of cols) {
          const p = d.positions.find((x) => x.name === name);
          const c = td(p?.text && p.text !== '-' ? p.text : '—', p?.text && p.text !== '-' ? '' : 'an-blank');
          if (p && onJump && state.services.some((s) => s.name === name)) {
            c.classList.add('an-jump');
            c.title = t('analysis.jumpTitle', { name });
            const jump = () => onJump(name, `${d.topic} ${p.text || ''}`); // 쟁점 + 그 AI 입장으로 관련 문단 찾기
            c.addEventListener('click', jump);
            keyClick(c, jump); // 키보드: Tab으로 칸에 닿아 Enter (v0.30.0)
          }
          row.append(c);
        }
      } else {
        const c = document.createElement('td');
        c.append(...d.positions.map((p) => nameChip(p.name, d.topic)));
        row.append(c);
      }
      row.append(td(d.verdict || '—', d.verdict ? 'an-verdict' : 'an-blank'));
      tbody.append(row);
    });
    table.append(thead, tbody);
    const scroller = document.createElement('div');
    scroller.className = 'an-table-wrap';
    scroller.append(table);
    dis.append(scroller);
  }

  // 근거 부족
  const weak = section(t('ui.analysis.unsupported'), res.unsupported.length);
  weak.append(
    res.unsupported.length
      ? list(res.unsupported, (li, u) => {
          if (u.name) li.append(nameChip(u.name, u.text), ' ');
          li.append(u.text);
        })
      : span('muted-label', t('ui.analysis.noUnsupported')),
  );

  // 최종 답변
  const fin = section(t('ui.analysis.final'));
  fin.classList.add('an-final');
  const finBody = document.createElement('div');
  finBody.className = 'analysis-raw';
  finBody.textContent = res.final;
  const copyFinal = button(t('ui.copy'), t('ui.analysis.copyFinal'), async () => {
    await host.copyText(res.final);
    flash(meta, t('ui.analysis.finalCopied'));
  });
  fin.querySelector('h3').append(copyFinal);
  fin.append(finBody);

  // 출처 (v0.32.0): 답변 · 분석에 나온 링크를 주소별로 모은다. 앱에서는 링크를 열지 않고 복사만 한다 (패널 밖으로 나가는 이동을 만들지 않음)
  const srcItems = [...(sources || []).map((a) => ({ name: a.name, text: a.text })), { name: entry.judge, text: raw }];
  const found = AN.extractSources(srcItems);
  const src = section(t('analysis.sources'), found.length);
  src.classList.add('an-sources');
  src.append(
    found.length
      ? list(found, (li, s) => {
          li.append(span('an-src-host', s.host), ' ');
          const link = span('an-src-url', s.title || s.url);
          link.title = s.url;
          li.append(link, ' ');
          for (const n of s.names) li.append(nameChip(n, s.url), ' ');
          li.append(
            button(t('ui.copy'), t('analysis.copyLink'), async (e) => {
              await host.copyText(s.url);
              flash(e.target, t('ui.copied'));
            }),
          );
        })
      : span('muted-label', t('analysis.noSources')),
  );

  const grid = document.createElement('div');
  grid.className = 'analysis-grid';
  grid.append(dis, common, weak, fin, src);
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
  const count = span('muted-label', a.text ? t('preview.chars', { n: a.text.length.toLocaleString() }) : a.note || t('ui.answerState.noAnswer'));
  const copy = button(t('ui.copy'), t('ui.answer.copyTitle', { name: a.name }), async () => {
    await host.copyText(a.md || a.text); // Markdown이 있으면 서식(표·코드)을 살려 복사
    flash(count, t('ui.copied'));
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
  } else body.textContent = a.text || a.emptyText || t('ui.answer.none');
  body.classList.toggle('empty', !a.text);
  col.append(head, body);
  return col;
}

// 내보내기: 지금 비교 화면의 질문 · 답변 · 이번 질문의 분석
const compareDoc = () =>
  EX.docFromCompare({ question: compareView.question, answers: compareView.answers, analysis: compareView.analysis, chain: compareView.chain, debates: compareView.debates });
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
$('#compareMode').addEventListener('change', (e) => {
  compareView.mode = MLA.compareModes.normalizeMode(e.target.value);
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
    $('#analysisView').prepend(span('analysis-note', r?.error || t('ui.analysis.requestFailed')));
  }
});

$('#compareBtn').addEventListener('click', () => host.setView(state.chatView === 'compare' ? 'panels' : 'compare'));
$('#changesBtn').addEventListener('click', () => host.setView(state.chatView === 'changes' ? 'panels' : 'changes'));
$('#changesClose').addEventListener('click', () => host.setView('panels'));
$('#historyBtn').addEventListener('click', () => host.setView(state.chatView === 'history' ? 'panels' : 'history'));
$('#compareClose').addEventListener('click', () => host.setView('panels'));
$('#compareRefresh').addEventListener('click', renderCompare);

// ---------- 질문·답변 기록 ----------
// 기록 화면(목록 · 거르기 · 대화 줄기 · 상세)은 history-view.js (v0.27.0). 여기에는 비교 화면과 같이 쓰는 것만 둔다.

const fmtTime = (ms) =>
  new Date(ms).toLocaleString(MLA.i18n.getLang() === 'en' ? 'en-US' : 'ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// 글 없이 첨부만 보낸 기록의 질문 자리 (언어를 바꾸면 그때 글로)
Object.defineProperty(window, 'NO_TEXT', { get: () => t('ui.noText') });
const filesLine = (files) => files.map((f) => `${f.name} (${fmtSize(f.size)})`).join(' · ');

// 기록 하나(질문 + 각 AI 답변 + 종합 · 분석)를 Markdown 글 하나로 엮습니다 (복사 · 내보내기 — shared/export.js).
const EX = MLA.exporter;
const recordToMarkdown = (rec) => EX.toMarkdown(EX.docFromRecord(rec));

/** 내보내기: 문서를 Markdown 또는 HTML 파일로 저장 (앱은 저장 창, 크롬 확장은 다운로드) → 결과를 el에 잠깐 보여 준다 */
async function exportDoc(doc, kind, el) {
  const text = kind === 'html' ? EX.toHtml(doc) : EX.toMarkdown(doc);
  const r = await host.saveFile({ name: EX.fileName(doc, kind), text, kind }).catch((err) => ({ ok: false, error: err.message }));
  if (r?.ok) flash(el, t('ui.saved', { name: String(r.path).split(/[\\/]/).pop() }));
  else if (!r?.cancelled) flash(el, r?.error || t('ui.saveFailed'));
}

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
// 화면 언어 (v0.30.0): 본체가 검사해 저장하고, 돌아오는 state.uiLang을 보고 화면을 다시 그린다 (renderer-compose.js relocalize)
$('#langSelect').addEventListener('change', (e) => host.setSettings({ lang: e.target.value }));

// 기록 최대 개수 (v0.24.0): 줄여서 지워지는 기록이 있으면 먼저 묻는다
$('#historyMaxSelect').addEventListener('change', async (e) => {
  const n = Number(e.target.value);
  const count = (await host.history.list('').catch(() => [])).filter((r) => r.source !== 'side').length;
  if (count > n && !confirm(t(state.historyArchive ? 'settings.historyMaxShrinkArchive' : 'settings.historyMaxShrink', { n, drop: count - n }))) {
    e.target.value = String(state.historyMax);
    return;
  }
  host.setSettings({ historyMax: n });
});

// 넘친 기록 보관 (v0.35.0): 켜면 최대 개수를 넘은 기록을 지우지 않고 달별 보관 파일로 옮긴다
$('#historyArchiveToggle').addEventListener('change', (e) => host.setSettings({ historyArchive: e.target.checked }));

/** 설정의 보관 설명 뒤에 지금 보관된 기록 수를 붙인다 */
async function refreshArchiveNote() {
  const note = $('#historyArchiveNote');
  note.textContent = t('settings.historyArchiveNote');
  const info = await host.history.archiveInfo?.().catch(() => null);
  if (info?.total) note.textContent += ' ' + t('settings.historyArchiveCount', { n: info.total, m: info.months.length });
}

$('#sendPreviewToggle').addEventListener('change', (e) => host.setSettings({ sendPreview: e.target.checked }));
$('#retryOnceToggle').addEventListener('change', (e) => host.setSettings({ retryOnce: e.target.checked })); // v0.26.0
$('#autoRecommendToggle').addEventListener('change', (e) => host.setSettings({ autoRecommend: e.target.checked })); // v0.27.0
$('#recommendOrderSelect').addEventListener('change', (e) => host.setSettings({ recommendOrder: e.target.value })); // 추천 줄 세우기 기준 (v0.35.0)
$('#commitOfferToggle').addEventListener('change', (e) => host.setSettings({ commitOffer: e.target.checked })); // v0.28.0 (Windows 앱)
for (const box of document.querySelectorAll('[data-notify]')) {
  box.addEventListener('change', () => host.setSettings({ notify: { [box.dataset.notify]: box.checked } }));
}

const REMOTE_SOURCE = {
  get builtin() { return t('ui.remote.builtin'); },
  get cache() { return t('ui.remote.cache'); },
  get remote() { return t('ui.remote.remote'); },
};

// 설정 화면의 "사이트 셀렉터 원격 갱신" 상태 글
function renderRemoteStatus() {
  const r = state.remote || {};
  const parts = [
    `${t('ui.remote.using', { source: REMOTE_SOURCE[r.source] || r.source })}${r.version ? ` (${t('ui.remote.version', { v: r.version })}${r.updated ? `, ${r.updated}` : ''})` : ''}`,
  ];
  if (r.services?.length) parts.push(t('ui.remote.changed', { list: r.services.join(', ') }));
  if (r.ignored?.length) parts.push(t('ui.remote.ignored', { list: r.ignored.slice(0, 6).join(', ') + (r.ignored.length > 6 ? t('ui.remote.more') : '') }));
  if (r.checkedAt) parts.push(t('ui.remote.checked', { time: fmtTime(r.checkedAt) }));
  if (r.error) parts.push(t('ui.remote.checkFailed', { error: r.error }));
  $('#remoteStatus').textContent =
    t('ui.remote.status', { parts: parts.join(' · ') });
  $('#remoteToggle').checked = !!state.remoteSelectors;
  $('#remoteRefresh').disabled = !state.remoteSelectors;
}

$('#remoteToggle').addEventListener('change', (e) => host.setSettings({ remoteSelectors: e.target.checked }));
// 로컬 LLM 설정 (v0.16.0). 크롬 확장은 켤 때 이 PC 주소 권한(localhost)을 그때 묻는다 (host.local.setPrefs가 처리)
$('#localEnabled').addEventListener('change', async (e) => {
  const r = await host.local.setPrefs({ enabled: e.target.checked });
  if (!r?.ok) {
    e.target.checked = false;
    $('#localStatus').textContent = r?.error || t('ui.local.enableFailed');
  }
  renderLocalSettings();
  if (r?.ok && r.local.enabled) refreshLocalModels();
});
$('#localBase').addEventListener('change', async (e) => {
  const r = await host.local.setPrefs({ baseUrl: e.target.value });
  $('#localStatus').textContent = r?.ok ? t('ui.local.urlSaved') : r?.error || t('ui.saveFailed');
  if (!r?.ok) e.target.value = state.local?.baseUrl || '';
});
$('#localModel').addEventListener('change', (e) => host.local.setPrefs({ model: e.target.value }));
$('#localCheck').addEventListener('click', () => refreshLocalModels($('#localCheck')));
$('#localCtx').addEventListener('change', (e) => host.local.setPrefs({ contextTokens: Number(e.target.value) })); // 컨텍스트 한도 (v0.29.0)

$('#remoteRefresh').addEventListener('click', async () => {
  $('#remoteRefresh').disabled = true;
  await host.refreshRemote();
  $('#remoteRefresh').disabled = false;
});

// ---------- 응답 통계 (v0.13.0) ----------
// 기록에 남은 숫자(보내기 성공 · 완료 · 실패 · 시간 · 글자 수)로 AI별 표를 그린다. 정확도는 재지 않는다.
const fmtSec = (ms) => (ms == null ? '–' : ms >= 60000 ? t('ui.time.minSec', { m: Math.floor(ms / 60000), s: Math.round((ms % 60000) / 1000) }) : t('ui.time.sec', { s: (ms / 1000).toFixed(1) }));
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
  const cols = ['service', 'asked', 'done', 'timeout', 'sendFail', 'limit', 'first', 'doneTime', 'chars', 'satisfaction'].map((k) => t(`ui.stats.${k}`));
  if (apply) cols.push(t('ui.stats.applied'));
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
    cell(String(r.timeout + r.noAnswer), t('ui.stats.timeoutTitle', { timeout: r.timeout, none: r.noAnswer }));
    cell(String(r.sendFail));
    const lim = cell(String(r.limit));
    if (r.limit) lim.dataset.state = 'warn';
    cell(fmtSec(r.firstMedianMs));
    cell(fmtSec(r.doneMedianMs));
    cell(r.charsAvg == null ? '–' : r.charsAvg.toLocaleString());
    cell(fmtSatisfaction(r), t('ui.stats.satisfactionTitle'));
    if (apply) {
      const a = apply[svc?.name || r.name];
      cell(a ? `${a.applied} · ${a.reverted}` : '–', t('ui.stats.appliedTitle'));
    }
    return tr;
  });
  const empty = Object.assign(document.createElement('tr'), { textContent: t('ui.history.empty') });
  table.replaceChildren(head, ...(rows.length ? rows : [empty]));
  $('#statsNote').textContent = st?.records
    ? t('ui.stats.note', { n: st.records, since: fmtTime(st.since) })
    : '';
}

// 저장 방식 안내 (v0.22.1): Windows 앱은 이 Windows 계정에 묶인 암호화, 크롬 확장은 암호화하지 않음
function renderStorage() {
  const s = state?.storage;
  const el = $('#storageStatus');
  if (!el || !s) return;
  el.textContent = s.extension
    ? t('ui.storage.extension')
    : s.encrypted
      ? t('ui.storage.encrypted')
      : t('ui.storage.plain');
}
function renderSettings() {
  renderRemoteStatus();
  renderUpdate();
  renderStorage();
  renderDiagTable();
  renderStatsTable();
  renderLocalSettings();
  $('#langSelect').value = state.lang || 'auto';
  const select = $('#timeoutSelect');
  select.replaceChildren(
    ...state.timeoutChoices.map((m) => Object.assign(document.createElement('option'), { value: m, textContent: t('ui.minutes', { n: m }) })),
  );
  select.value = String(state.answerTimeoutMin);
  const maxSel = $('#historyMaxSelect');
  maxSel.replaceChildren(
    ...(state.historyMaxChoices || []).map((n) =>
      Object.assign(document.createElement('option'), { value: n, textContent: t('settings.historyMaxOption', { n }) }),
    ),
  );
  maxSel.value = String(state.historyMax);
  $('#historyArchiveToggle').checked = !!state.historyArchive;
  refreshArchiveNote();
  // 보내기 전 미리보기 · OS 알림 종류별 켜기 (v0.25.0)
  $('#sendPreviewToggle').checked = !!state.sendPreview;
  $('#retryOnceToggle').checked = state.retryOnce !== false;
  $('#autoRecommendToggle').checked = !!state.autoRecommend; // v0.27.0
  $('#recommendOrderSelect').value = state.recommendOrder || 'completion';
  // 적용 후 커밋 제안 (v0.28.0): git이 있는 Windows 앱에서만 보인다
  for (const id of ['#commitOfferRow', '#commitOfferNote']) $(id).hidden = !host.git?.commit;
  $('#commitOfferToggle').checked = state.commitOffer !== false;
  renderRecommendTable(); // 질문 종류별 추천 (v0.27.0, recommend-ui.js)
  for (const box of document.querySelectorAll('[data-notify]')) box.checked = state.notify?.[box.dataset.notify] !== false;
}

/** 설정·단축키(?) 화면: 대기 시간 고르기, 원격 갱신 상태, 단축키 표 */
async function renderHelp() {
  renderSettings();
  const rows = await host.shortcuts();
  // 표 머리줄 (v0.30.0 접근성): 화면에는 안 보이고 화면 읽기 프로그램만 읽는다
  const helpHead = document.createElement('thead');
  helpHead.className = 'sr-only';
  const helpHeadRow = document.createElement('tr');
  for (const key of ['ui.a11y.helpKeys', 'ui.a11y.helpAction']) helpHeadRow.append(Object.assign(document.createElement('th'), { textContent: t(key), scope: 'col' }));
  helpHead.append(helpHeadRow);
  $('#helpTable').replaceChildren(
    helpHead,
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
