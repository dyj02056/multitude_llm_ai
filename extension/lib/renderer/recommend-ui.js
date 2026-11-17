// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/renderer/recommend-ui.js)
// 질문 종류별 추천 조합 화면 (v0.27.0): 모델 고르기 화면의 "이런 질문에는 보통: A · B · C", 설정 › 응답 통계 아래의 종류별 표,
// 설정에서 켰을 때 입력창 위의 [추천 조합으로 바꾸기] 제안 칩. 계산은 본체(host.history.recommend → shared/recommend.js).
//
// [쉽게 말하면] 내 기록으로 센 사실 숫자(끝까지 답한 비율 · 걸린 시간 · 내가 준 평가)로 "코드 질문엔 보통 이 AI들"을 보여 줍니다.
// 정확도는 재지 않고, 보낼 대상은 저절로 바꾸지 않습니다 — 칩을 눌러야만 바뀝니다.

const RCU = MLA.recommend;
const RECOMMEND_TTL_MS = 30 * 1000; // 기록이 자주 바뀌지 않으므로 잠깐 모아 둔다
let recommendData = null;
let recommendAt = 0;
let recommendOrderUsed = '';

/** 추천 숫자 가져오기 (TTL 안이면 모아 둔 것, 줄 세우는 기준이 바뀌면 다시) */
async function loadRecommend(force = false) {
  const order = state?.recommendOrder || 'completion';
  if (!force && recommendData && recommendOrderUsed === order && Date.now() - recommendAt < RECOMMEND_TTL_MS) return recommendData;
  recommendData = (await host.history.recommend?.(order).catch(() => null)) || null;
  recommendOrderUsed = order;
  recommendAt = Date.now();
  return recommendData;
}

/** 만족도 글: 83% (좋음 5 · 별로 1 · ★ 2) — 표가 없으면 — */
function satText(r) {
  if (r.satisfaction == null) return '—';
  const star = r.starred ? ' · ★' + r.starred : '';
  return `${fmtPct(r.satisfaction)} (${r.good}/${r.good + r.bad}${star})`;
}

const svcName = (id) => state?.services?.find((s) => s.id === id)?.name || id;
const fmtPct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

/** 한 AI의 숫자 설명 (툴팁 · 표) */
function recommendRowTip(r) {
  return t('recommend.rowTip', {
    name: svcName(r.id),
    answers: r.answers,
    completion: fmtPct(r.completion),
    time: fmtSec(r.doneMedianMs),
    sat: satText(r),
  });
}

/** 종류 하나의 추천: { kind, picks, rows, records } → 줄 글과 툴팁 */
function recommendLine(kind, k) {
  const names = k.picks.map(svcName).join(' · ');
  const tip = k.rows.filter((r) => k.picks.includes(r.id)).map(recommendRowTip).join('\n');
  return { text: t('recommend.line', { kind: t(`kind.${kind}`), names }), tip };
}

// ---------- 모델 고르기 화면 ----------

async function renderPickRecommend() {
  const box = $('#pickRecommend');
  const data = await loadRecommend();
  const kinds = RCU.KINDS.filter((k) => data?.[k]?.picks?.length);
  box.hidden = !kinds.length;
  if (!kinds.length) return box.replaceChildren();
  const title = span('muted-label', t('recommend.title'));
  title.title = t('recommend.note', { min: RCU.MIN_SAMPLE });
  const lines = kinds.map((kind) => {
    const { text, tip } = recommendLine(kind, data[kind]);
    const row = document.createElement('div');
    row.className = 'rec-line';
    const label = span('rec-text', text);
    label.title = tip;
    // 모델 고르기 칸에서 추천 AI만 체크한다 (열기는 사용자가 누른다)
    const pick = button(t('recommend.pick'), tip, () => {
      const want = new Set(data[kind].picks);
      for (const box of document.querySelectorAll('#modelList input')) box.checked = want.has(box.value);
      updatePickLimit();
    });
    row.append(label, pick);
    return row;
  });
  box.replaceChildren(title, ...lines);
}

// ---------- 설정 › 질문 종류별 추천 표 ----------

async function renderRecommendTable() {
  const box = $('#recommendTable');
  if (!box) return;
  $('#recommendNote').textContent = t('recommend.note', { min: RCU.MIN_SAMPLE });
  const data = await loadRecommend(true);
  const blocks = RCU.KINDS.map((kind) => {
    const k = data?.[kind] || { records: 0, picks: [], rows: [] };
    const det = document.createElement('details');
    det.className = 'rec-kind';
    const head = k.picks.length ? recommendLine(kind, k).text : t('recommend.none', { kind: t(`kind.${kind}`), min: RCU.MIN_SAMPLE });
    det.append(Object.assign(document.createElement('summary'), { textContent: `${head} · ${t('recommend.records', { n: k.records })}` }));
    if (k.rows.length) det.append(recommendRowsTable(k));
    return det;
  });
  box.replaceChildren(...blocks);
  renderSpeedTable();
}

// ---------- 설정 › 시간대별 응답 속도 (v0.35.0) ----------

async function renderSpeedTable() {
  const table = $('#speedTable');
  if (!table) return;
  const data = await host.history.speed?.().catch(() => null);
  $('#speedNote').textContent = t('recommend.speedNote', { min: RCU.MIN_SPEED_SAMPLE });
  const head = document.createElement('tr');
  head.append(Object.assign(document.createElement('th'), { textContent: t('recommend.colService') }));
  for (const b of data?.buckets || RCU.BUCKETS.map((x) => x.id)) head.append(Object.assign(document.createElement('th'), { textContent: t(`recommend.bucket.${b}`) }));
  const rows = (data?.rows || []).map((r) => {
    const tr = document.createElement('tr');
    tr.append(Object.assign(document.createElement('td'), { textContent: `${svcName(r.id)} (${r.total})` }));
    for (const c of r.cells) {
      const td = Object.assign(document.createElement('td'), { textContent: c.medianMs == null ? (c.n ? `· (${c.n})` : '—') : `${fmtSec(c.medianMs)} (${c.n})` });
      if (c.medianMs == null) td.className = 'rec-few';
      tr.append(td);
    }
    return tr;
  });
  table.replaceChildren(head, ...rows);
  if (!rows.length) $('#speedNote').textContent += ` ${t('recommend.speedEmpty')}`;
}

/** 종류 하나의 AI별 숫자 표 (추천에 든 AI는 굵게, 표본이 모자란 AI는 흐리게) */
function recommendRowsTable(k) {
  const table = document.createElement('table');
  table.className = 'diag-table stats-table';
  const head = document.createElement('tr');
  for (const key of ['recommend.colService', 'recommend.colAnswers', 'recommend.colCompletion', 'recommend.colTime', 'recommend.colSat']) {
    head.append(Object.assign(document.createElement('th'), { textContent: t(key) }));
  }
  const rows = k.rows.map((r) => {
    const tr = document.createElement('tr');
    if (k.picks.includes(r.id)) tr.className = 'rec-pick';
    else if (!r.enough) tr.className = 'rec-few';
    const cells = [
      `${svcName(r.id)}${r.enough ? '' : ` (${t('recommend.few')})`}`,
      String(r.answers),
      `${fmtPct(r.completion)} (${r.done}/${r.answers})`,
      fmtSec(r.doneMedianMs),
      satText(r),
    ];
    for (const c of cells) tr.append(Object.assign(document.createElement('td'), { textContent: c }));
    return tr;
  });
  table.append(head, ...rows);
  return table;
}

// ---------- 입력창: [추천 조합으로 바꾸기] (설정에서 켰을 때만) ----------

/** 지금 입력창 질문의 종류 (첨부 수 · 프로젝트 맥락 포함 여부까지) */
function draftKind() {
  const projectOn = !$('#projectChip').hidden && $('#projectInclude').checked;
  return RCU.classifyQuestion({ text: $('#prompt').value, files: attachments.map((a) => ({ name: a.file.name })), project: projectOn ? { name: 'project' } : null });
}

let recommendSuggest = null; // { kind, ids } — 칩을 누르면 이 대상으로 바꾼다

window.renderRecommendChip = async () => {
  const chip = $('#recommendChip');
  if (!state?.autoRecommend || state.mode !== 'chat' || !$('#prompt').value.trim()) {
    chip.hidden = true;
    return;
  }
  const data = await loadRecommend();
  const kind = draftKind();
  const open = (state.rects || []).map((r) => r.id);
  const s = RCU.suggestTargets(data?.[kind]?.picks, open, [...targets]);
  chip.hidden = !s.differs;
  if (!s.differs) return;
  recommendSuggest = { kind, ids: s.ids };
  const names = s.ids.map(svcName).join(' · ');
  chip.textContent = t('recommend.switch');
  chip.title = t('recommend.switchTitle', { kind: t(`kind.${kind}`), names });
};

$('#recommendChip').addEventListener('click', () => {
  if (!recommendSuggest) return;
  targets.clear();
  for (const id of recommendSuggest.ids) targets.add(id);
  $('#sendHint').textContent = t('recommend.switched', { names: recommendSuggest.ids.map(svcName).join(' · ') });
  recommendSuggest = null;
  renderTargets(); // 칩도 다시 본다 (이제 같으므로 숨는다)
});

let recommendTimer = null;
$('#prompt').addEventListener('input', () => {
  clearTimeout(recommendTimer);
  recommendTimer = setTimeout(() => window.renderRecommendChip(), 300);
});
