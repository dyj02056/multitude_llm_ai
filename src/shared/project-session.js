// 프로젝트 작업 이어 하기 (v0.28.0): 패널마다 "AI가 이미 받은 파일" 기록 · 파일별로 받기 진행 · 이어 받기 상태를
// 프로젝트 상태(Windows 앱 main/project.js saveState · 크롬 확장 project-fs.js saveState)에 넣고 꺼내는 계산만 한다.
// 파일 내용은 넣지 않는다 (지문 · 줄 수 · 경로만). 패널 수 · 경로 수 · 길이에 한도를 둔다.
//
// 되살리는 규칙
//   - 같은 실행(앱을 끄지 않음)에서 프로젝트를 다시 열면: 패널 세대(새 대화 · 패널 닫기에서 오름)가 같은 패널만 되살린다
//   - 앱을 다시 켠 뒤: 패널은 새 대화로 열리므로 바로 되살리지 않고 "기다림"으로 둔다. 패널이 지난번과 같은 대화 주소를 열면
//     (주소 지문이 같으면) 저절로 되살리고, 사용자가 [이어 쓰기]를 누르면 지금 대화로 되살린다. 새 대화 · 패널 닫기면 버린다
// Electron 앱(require)과 크롬 확장 · 화면(전역 MLA.projectSession)이 같이 쓴다.
//
// [쉽게 말하면] 앱을 껐다 켜거나 프로젝트를 다시 열어도 "어디까지 했는지"를 잊지 않게 적어 두는 메모장 규칙입니다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).projectSession = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 1;
  const MAX_PANELS = 12;
  const MAX_SENT = 3000; // 패널 하나가 기억하는 파일 수
  const MAX_PLAN_FILES = 200; // 파일별로 받기 목록
  const MAX_PATH = 1000;
  const MAX_NOTE = 300;
  const MAX_AGE_MS = 14 * 24 * 3600e3; // 앱을 다시 켠 뒤 기다리는 기록은 2주까지
  const STATUSES = ['offer', 'running', 'paused'];

  const str = (v, max) => (typeof v === 'string' && v && v.length <= max ? v : null);

  /**
   * 대화 주소 → 비교용 열쇠 (호스트 + 경로). 대화 id처럼 보이는 경로 조각이 없거나 처음 주소(homes)와 같으면 null.
   * 예: https://chatgpt.com/c/6720f1c2-…?model=x → "chatgpt.com/c/6720f1c2-…", https://claude.ai/new → null
   */
  function convKey(url, homes = []) {
    let u;
    try {
      u = new URL(String(url || ''));
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const key = (x) => `${x.host}${x.pathname.replace(/\/+$/, '')}`;
    const k = key(u);
    for (const h of homes) {
      try {
        if (h && key(new URL(h)) === k) return null;
      } catch {}
    }
    // 대화 id: 숫자가 섞인 12자 이상 조각 (uuid · 긴 영숫자)
    const looksId = u.pathname.split('/').some((s) => s.length >= 12 && /\d/.test(s) && /^[A-Za-z0-9_-]+$/.test(s));
    return looksId ? k : null;
  }

  /**
   * 패널 하나의 기록 만들기 (저장용, 한도 적용).
   * sent: Map(경로 → { hash, lines } | null) · tree: 구조 목록 지문 · plan: 파일별로 받기 { files, index, status, got }
   * cont: 이어 받기 { path, rounds, waiting }
   */
  function packPanel({ run, epoch, at, conv = null, sent = null, tree = null, plan = null, cont = null }) {
    const files = [];
    for (const [p, e] of entriesOf(sent)) {
      if (files.length >= MAX_SENT) break;
      if (!str(p, MAX_PATH)) continue;
      files.push(e && typeof e.hash === 'string' ? [p, e.hash, Number(e.lines) || 0] : [p, null]);
    }
    return {
      run: String(run || ''),
      epoch: String(epoch || '0'),
      at: Number(at) || 0,
      conv: str(conv, 200),
      sent: files,
      tree: str(tree, 200),
      plan: cleanPlan(plan),
      cont: cleanCont(cont),
    };
  }

  /** 받은 파일 기록: Map(경로 → { hash, lines } | null) 또는 저장된 모양 [[경로, 지문, 줄 수] | [경로, null]] → [[경로, 값]] */
  function entriesOf(sent) {
    if (!sent) return [];
    if (sent instanceof Map) return [...sent];
    if (!Array.isArray(sent)) return [];
    return sent.filter(Array.isArray).map((f) => [f[0], typeof f[1] === 'string' ? { hash: f[1], lines: Number(f[2]) || 0 } : null]);
  }

  function cleanPlan(p) {
    if (!p || !Array.isArray(p.files)) return null;
    const files = p.files
      .slice(0, MAX_PLAN_FILES)
      .filter((f) => f && str(f.path, MAX_PATH))
      .map((f) => ({ path: f.path, note: typeof f.note === 'string' ? f.note.slice(0, MAX_NOTE) : '' }));
    if (!files.length) return null;
    const index = Math.max(0, Math.min(files.length, Math.floor(Number(p.index) || 0)));
    const got = (Array.isArray(p.got) ? p.got : []).filter((x) => files.some((f) => f.path === x));
    return { files, index, status: STATUSES.includes(p.status) ? p.status : 'paused', got };
  }

  function cleanCont(c) {
    if (!c || !str(c.path, MAX_PATH)) return null;
    return { path: c.path, rounds: Math.max(0, Math.min(10, Math.floor(Number(c.rounds) || 0))), waiting: c.waiting === true };
  }

  /** 저장된 패널 기록 하나 검사 → 정리한 기록 | null */
  function cleanPanel(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sent)) return null;
    const sent = new Map();
    for (const f of raw.sent) {
      if (!Array.isArray(f) || !str(f[0], MAX_PATH) || sent.size >= MAX_SENT) continue;
      sent.set(f[0], typeof f[1] === 'string' ? { hash: f[1], lines: Number(f[2]) || 0 } : null);
    }
    return { ...packPanel({ ...raw, sent }), sentMap: sent };
  }

  /** 저장할 모양: { v, panels: { id: 기록 } } — 최근 것부터 MAX_PANELS개 */
  function packSession(panels) {
    const list = Object.entries(panels || {})
      .filter(([id, rec]) => str(id, 100) && rec)
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
      .slice(0, MAX_PANELS);
    return { v: VERSION, panels: Object.fromEntries(list.map(([id, rec]) => [id, packPanel(rec)])) };
  }

  /**
   * 저장된 것 → { active: Map(id → 기록), pending: Map(id → 기록) }
   * runId: 지금 실행 id, epochOf(id): 지금 패널 세대, convOf(id): 지금 그 패널 주소의 열쇠 지문 | null, now
   */
  function restorePlan(saved, { runId, epochOf = () => '0', convOf = () => null, now = Date.now() } = {}) {
    const active = new Map();
    const pending = new Map();
    if (!saved || saved.v !== VERSION || !saved.panels || typeof saved.panels !== 'object') return { active, pending };
    for (const [id, raw] of Object.entries(saved.panels).slice(0, MAX_PANELS)) {
      const rec = cleanPanel(raw);
      if (!rec || !isUseful(rec)) continue;
      if (rec.run === runId) {
        if (rec.epoch === String(epochOf(id))) active.set(id, rec);
        continue; // 같은 실행에서 새 대화를 열었거나 패널을 닫았다 → 버림
      }
      if (now - rec.at > MAX_AGE_MS) continue;
      if (rec.conv && convOf(id) === rec.conv) active.set(id, rec); // 지난번과 같은 대화를 열고 있다
      else pending.set(id, rec);
    }
    return { active, pending };
  }

  const isUseful = (rec) => rec.sent.length > 0 || !!rec.tree || !!rec.plan || !!rec.cont;

  /** 안내용 숫자: { sent: 기억한 파일 수, plan: { at: 다음 파일 번호, total } | null, cont: 이어 받던 경로 | null } */
  function describe(rec) {
    return {
      sent: rec.sent.length,
      plan: rec.plan ? { at: Math.min(rec.plan.index + 1, rec.plan.files.length), total: rec.plan.files.length, done: rec.plan.index >= rec.plan.files.length } : null,
      cont: rec.cont ? rec.cont.path : null,
    };
  }

  return { VERSION, MAX_PANELS, MAX_SENT, MAX_PLAN_FILES, MAX_AGE_MS, convKey, packPanel, cleanPanel, packSession, restorePlan, describe };
});
