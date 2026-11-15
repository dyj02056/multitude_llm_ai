'use strict';

// 앱 화면 — 이어 묻기 · 토론 기록 보기, 이견 → 관련 문단 강조, 다시 분석 비교 (v0.26.0, Windows 앱과 크롬 확장이 똑같이 씀).
// renderer-views.js 다음, renderer-compose.js 앞에 읽힌다. 감싸지 않은 보통 스크립트라 앞 파일의 이름($, span, button, t, AN …)을 그대로 쓰고,
// 여기 함수(chainBlock · highlightRelated · analysisCompareBlock)는 renderer-views.js가 화면을 그릴 때 부른다.
//
// [쉽게 말하면] 비교 · 기록 화면에 "누가 누구에게 넘겨 무엇을 받았는지", "토론 라운드별 답", "두 분석의 차이"를 그려 주는 파일입니다.

// ---------- 이어 묻기 · 토론 기록 ----------

const chainTime = (ms) => (Number.isFinite(ms) ? fmtTime(ms) : '');

/** 글 하나를 접었다 펼 수 있는 칸으로 (처음엔 앞부분만 보이게 접어 둔다) */
function chainText(name, text, color) {
  const box = document.createElement('details');
  box.className = 'chain-answer';
  if (color) box.style.setProperty('--svc', color);
  const sum = document.createElement('summary');
  sum.append(span('name', name), span('muted-label', text ? `${text.length.toLocaleString()}자` : t('chain.noText')));
  const copy = button(t('chain.copy'), t('chain.copyTitle', { name }), async (e) => {
    e.preventDefault();
    await host.copyText(text);
    flash(copy, t('chain.copied'));
  });
  copy.disabled = !text;
  sum.append(copy);
  const body = document.createElement('div');
  body.className = 'chain-body';
  body.textContent = text || t('chain.noText');
  box.append(sum, body);
  return box;
}

const svcColor = (idOrName) => state.services.find((s) => s.id === idOrName || s.name === idOrName)?.color || 'var(--muted)';

/** chain 한 줄 → 카드 */
function chainCard(c) {
  const card = document.createElement('article');
  card.className = `chain-card chain-${c.kind}`;
  const head = document.createElement('div');
  head.className = 'chain-head';
  if (c.kind === 'debate') {
    head.append(span('chain-kind', t('chain.debateRound', { round: c.round, rounds: c.rounds || c.round })), span('muted-label', chainTime(c.at)));
    card.append(head);
    for (const a of c.answers || []) {
      const note = a.state && a.state !== 'done' ? ` · ${ANSWER_STATE_TEXT[a.state] || a.state}` : '';
      card.append(chainText(`${a.name}${note}`, a.md || a.text || '', svcColor(a.id)));
    }
    return card;
  }
  const what = c.kind === 'handoff' ? t(`handoff.intent.${c.intent}`) : t('chain.fallback');
  head.append(
    span('chain-kind', what),
    span('chain-route', t('chain.route', { from: c.fromName || c.from, to: c.toName || c.to })),
    span('muted-label', chainTime(c.at)),
  );
  const body = chainText(c.toName || c.to, c.md || c.text || '', svcColor(c.to));
  body.open = true; // 받은 답 하나뿐이라 펼쳐 둔다 (토론 라운드는 접어 둠)
  card.append(head, body);
  return card;
}

/**
 * 이어 묻기 · 토론 목록 (비교 화면의 탭 · 기록 화면 아래). chain: 기록의 chain, debates: 토론 결론(synth mode 'debate')
 * 일어난 순서(시각)대로, 토론 결론은 그 시각 자리에 "토론 결론" 카드로.
 */
function chainBlock(chain, debates) {
  const wrap = document.createElement('div');
  wrap.className = 'chain';
  const items = [
    ...(chain || []).map((c) => ({ at: c.at || 0, el: () => chainCard(c) })),
    ...(debates || []).map((d) => ({
      at: d.at || 0,
      el: () => {
        const card = document.createElement('article');
        card.className = 'chain-card chain-result';
        const head = document.createElement('div');
        head.className = 'chain-head';
        head.append(span('chain-kind', t('chain.debateResult')), span('chain-route', d.judge || ''), span('muted-label', chainTime(d.at)));
        const text = chainText(d.judge || '', d.md || d.text || '', svcColor(d.judge));
        text.open = true;
        card.append(head, text);
        return card;
      },
    })),
  ].sort((x, y) => x.at - y.at);
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'analysis-empty';
    empty.append(span('analysis-empty-title', t('chain.emptyTitle')), span('muted-label', t('chain.emptyBody')));
    wrap.append(empty);
    return wrap;
  }
  const h = document.createElement('h3');
  h.className = 'chain-title';
  h.textContent = t('chain.section');
  wrap.append(h, ...items.map((it) => it.el()));
  return wrap;
}

// ---------- 이견 → 관련 문단 강조 ----------

/**
 * 답변 칸(col)의 글을 문단으로 다시 그려, query와 가장 관련 있는 문단을 <mark class="an-hit">로 표시한다 (shared/analysis.js relatedParagraphs).
 * → 첫 강조 문단 요소 | null (관련 문단이 없으면 칸은 그대로)
 */
function highlightRelated(col, text, query) {
  const body = col.querySelector('.compare-body');
  if (!body) return null;
  const hits = AN.relatedParagraphs(query, text, { max: 2 }).sort((x, y) => x.start - y.start);
  if (!hits.length) return null;
  body.classList.remove('diffing');
  body.replaceChildren();
  let at = 0;
  let first = null;
  for (const h of hits) {
    if (h.start > at) body.append(document.createTextNode(text.slice(at, h.start)));
    const mark = document.createElement('mark');
    mark.className = 'an-hit';
    mark.textContent = text.slice(h.start, h.end);
    body.append(mark);
    first = first || mark;
    at = h.end;
  }
  if (at < text.length) body.append(document.createTextNode(text.slice(at)));
  return first;
}

// ---------- 다시 분석 비교 ----------

const analysisLabel = (a, i) => t('analysis.pickLabel', { n: i + 1, judge: a.judge || '?', time: chainTime(a.at) });

/**
 * 분석이 여러 개일 때(다시 분석): 둘을 골라 나란히. 한쪽에만 있는 이견 쟁점은 강조 (shared/analysis.js compareAnalyses).
 * 처음엔 가장 최근 분석과 그 바로 앞 분석. 하나만 보기로 돌아갈 수도 있다.
 */
function analysisCompareBlock(list, { onJump } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'an-compare';
  const pick = { a: list.length - 2, b: list.length - 1, side: true };
  const bar = document.createElement('div');
  bar.className = 'an-compare-bar';
  const select = (key) => {
    const s = document.createElement('select');
    s.setAttribute('aria-label', t(key === 'a' ? 'analysis.pickA' : 'analysis.pickB'));
    list.forEach((a, i) => s.append(Object.assign(document.createElement('option'), { value: String(i), textContent: analysisLabel(a, i) })));
    s.value = String(pick[key]);
    s.addEventListener('change', () => {
      pick[key] = Number(s.value);
      draw();
    });
    return s;
  };
  const selA = select('a');
  const selB = select('b');
  const toggle = button(t('analysis.compareOff'), t('analysis.compareOffTitle'), () => {
    pick.side = !pick.side;
    toggle.textContent = t(pick.side ? 'analysis.compareOff' : 'analysis.compareOn');
    draw();
  });
  bar.append(span('muted-label', t('analysis.compareTitle', { n: list.length })), selA, span('muted-label', '↔'), selB, toggle);
  const out = document.createElement('div');
  wrap.append(bar, out);

  function draw() {
    selA.disabled = !pick.side;
    if (!pick.side) return out.replaceChildren(analysisBlock(list[pick.b], { onJump }));
    const A = list[pick.a];
    const B = list[pick.b];
    const pa = AN.parseAnalysis(A.md || A.text, { names: A.names || [] });
    const pb = AN.parseAnalysis(B.md || B.text, { names: B.names || [] });
    const diff = AN.compareAnalyses(pa, pb);
    const grid = document.createElement('div');
    grid.className = 'an-compare-grid';
    const note = pa.ok && pb.ok ? t('analysis.compareNote', { a: diff.onlyA.length, b: diff.onlyB.length, same: diff.same.length }) : t('analysis.compareBroken');
    grid.append(analysisBlock(A, { onJump, unique: new Set(diff.onlyA) }), analysisBlock(B, { onJump, unique: new Set(diff.onlyB) }));
    out.replaceChildren(span('analysis-note', note), grid);
  }
  draw();
  return wrap;
}
