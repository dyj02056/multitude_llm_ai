'use strict';

// 셀렉터 점검 도구(npm run selectors:probe, v0.25.0)의 계산 부분 — Electron 없이 테스트할 수 있게 나눴다.
// 인자 읽기, 서비스마다 살펴볼 셀렉터 모으기, 페이지에서 받은 결과 정리, 요약 글, remote/selectors.json 고칠 틀, --fake용 가짜 페이지.
//
// [쉽게 말하면] 사이트를 열어 "입력창 · 보내기 버튼 · 답변 · 로그아웃 표시를 지금 셀렉터로 찾는지" 본 결과를
// 사람이 읽는 표와 JSON으로 만들고, 못 찾은 서비스에는 selectors.json에 넣을 빈칸 틀을 보여 주는 곳입니다.

const PARTS = ['input', 'send', 'stop', 'response'];

/**
 * 명령 인자 → { ids, fake, out, waitMs, show, remote, help }
 *   서비스 id 여러 개(없으면 전부), --fake(가짜 페이지), --out <파일>, --wait <초>, --show(창 보이기), --remote <파일>, --builtin(원격 셀렉터 안 씀)
 */
function parseArgs(argv, knownIds) {
  const o = { ids: [], fake: false, out: null, waitMs: 15000, show: false, remote: null, builtin: false, help: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fake') o.fake = true;
    else if (a === '--show') o.show = true;
    else if (a === '--builtin') o.builtin = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--out') o.out = argv[++i] || null;
    else if (a === '--remote') o.remote = argv[++i] || null;
    else if (a === '--wait') {
      const s = Number(argv[++i]);
      if (Number.isFinite(s) && s > 0) o.waitMs = Math.min(120, s) * 1000;
    } else if (a.startsWith('-') || a.endsWith('.js')) continue; // electron이 넘기는 것
    else if (knownIds.includes(a)) o.ids.push(a);
    else o.unknown.push(a);
  }
  if (!o.ids.length) o.ids = [...knownIds];
  o.ids = [...new Set(o.ids)];
  return o;
}

/** 서비스 → 페이지에서 살펴볼 것 (page.js pageSelectorReport의 cfg) */
function probeConfig(svc) {
  return {
    parts: Object.fromEntries(PARTS.map((p) => [p, [...(svc[p] || [])]])),
    loggedOut: svc.loggedOut ? { url: svc.loggedOut.url || '', selectors: [...(svc.loggedOut.selectors || [])], text: svc.loggedOut.text || '' } : {},
  };
}

/**
 * 페이지 결과 정리 → { id, name, status, host, loggedOut, parts: { 이름: { state, found(처음 보인 셀렉터), candidates } }, notes }
 * status: 'ok' · 'fail'(입력창 못 찾음) · 'logged-out' · 'error'(페이지를 못 열었거나 못 읽음)
 * 보내기 버튼은 글을 쓰기 전에는 숨는 사이트가 많고, 중지 버튼 · 답변은 질문을 보내야 생겨서 못 찾아도 'unknown'(실패 아님).
 */
function summarize(svc, raw, error) {
  const base = { id: svc.id, name: svc.name, url: svc.url };
  if (error || !raw) return { ...base, status: 'error', error: String(error || '결과 없음'), parts: {}, notes: [] };
  const parts = {};
  for (const p of PARTS) {
    const candidates = (raw.parts && raw.parts[p]) || [];
    const hit = candidates.find((c) => c.visible > 0);
    const hidden = !hit && candidates.find((c) => c.count > 0);
    let state = hit ? 'ok' : 'unknown';
    if (p === 'input' && !hit) state = 'fail';
    if (!candidates.length) state = 'none';
    parts[p] = { state, found: hit ? hit.sel : null, hidden: hidden ? hidden.sel : null, candidates };
  }
  const lo = raw.loggedOut || {};
  const loggedOut = !!(lo.url || (lo.selectors || []).some((s) => s.visible > 0) || lo.text);
  const notes = [];
  if (loggedOut) notes.push(`로그아웃 상태로 보입니다 (${lo.url ? '주소' : lo.text ? `버튼 "${lo.text}"` : '로그인 링크'}) — 앱 프로필로 로그인한 뒤 다시 실행하세요`);
  if (parts.send.state !== 'ok' && parts.send.state !== 'none') notes.push('보내기 버튼은 글을 쓰기 전에는 숨는 사이트가 많아 실패로 보지 않습니다 (못 찾으면 Enter 키로 보냄)');
  if ((raw.parts?.input || []).concat(raw.parts?.send || [], raw.parts?.stop || [], raw.parts?.response || []).some((c) => c.bad)) notes.push('문법이 틀린 셀렉터가 있습니다');
  const status = loggedOut ? 'logged-out' : parts.input.state === 'fail' ? 'fail' : 'ok';
  return { ...base, status, host: raw.host || '', loggedOut, loginHint: lo.text || null, parts, notes };
}

/** 보고서 전체 → { at, fake, profile(쓴 프로필이 따로 정한 것인지만), selectorsVersion, counts, services } */
function buildReport(results, meta = {}) {
  const counts = { ok: 0, fail: 0, 'logged-out': 0, error: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  return {
    tool: 'selectors-probe',
    at: meta.at || new Date().toISOString(),
    app: meta.app || '',
    fake: !!meta.fake,
    customProfile: !!meta.customProfile,
    selectorsVersion: meta.selectorsVersion ?? null,
    counts,
    services: results,
  };
}

const MARK = { ok: '✓', unknown: '–', fail: '✕', none: '·' };
const STATUS_TEXT = { ok: '정상', fail: '입력창 못 찾음', 'logged-out': '로그아웃', error: '열지 못함' };

/** 사람이 읽는 요약 (터미널) */
function formatSummary(report) {
  const lines = [];
  lines.push(`셀렉터 점검 ${report.fake ? '(가짜 페이지) ' : ''}— ${report.at}${report.selectorsVersion ? ` · 원격 셀렉터 v${report.selectorsVersion}` : ''}`);
  lines.push('표시: ✓ 찾음 · – 이 화면에서는 안 보임(질문 전이라 정상일 수 있음) · ✕ 못 찾음 · · 셀렉터 없음');
  lines.push('');
  for (const r of report.services) {
    const head = `${r.id.padEnd(11)}${STATUS_TEXT[r.status] || r.status}`;
    if (r.status === 'error') {
      lines.push(`${head} — ${r.error}`);
      continue;
    }
    const parts = PARTS.map((p) => `${p} ${MARK[r.parts[p].state] || '?'}`).join('  ');
    lines.push(`${head.padEnd(26)}${parts}`);
    if (r.parts.input.found) lines.push(`${''.padEnd(13)}입력창: ${r.parts.input.found}`);
    for (const n of r.notes) lines.push(`${''.padEnd(13)}${n}`);
  }
  const c = report.counts;
  lines.push('');
  lines.push(`정상 ${c.ok || 0} · 입력창 못 찾음 ${c.fail || 0} · 로그아웃 ${c['logged-out'] || 0} · 열지 못함 ${c.error || 0}`);
  return lines.join('\n');
}

/**
 * 못 찾은 서비스의 remote/selectors.json 고칠 틀 (파일에 쓰지 않고 보여 주기만) → { patch, notes } | null(고칠 것 없음)
 * 원격으로 고칠 수 있는 항목(input · stop · response)만 빈칸으로 넣고, 보내기 버튼처럼 앱 업데이트가 필요한 것은 notes로.
 */
function patchSkeleton(report, { version = 0, today } = {}) {
  const services = {};
  const notes = [];
  for (const r of report.services) {
    if (r.status !== 'fail') continue;
    services[r.id] = { input: ['<새 입력창 셀렉터 — 개발자 도구에서 찾은 것>'] };
    notes.push(`${r.id}: 지금 후보 ${r.parts.input.candidates.map((c) => c.sel).join(' | ')} 를 못 찾았습니다${r.parts.input.hidden ? ` (${r.parts.input.hidden}는 있지만 안 보임)` : ''}`);
    if (r.parts.send.state === 'unknown') notes.push(`${r.id}: 보내기 버튼도 고쳐야 하면 src/shared/services.js를 고쳐 새 버전으로 배포합니다 (원격으로 바꿀 수 없음)`);
  }
  if (!Object.keys(services).length) return null;
  return {
    patch: { version: Number(version) + 1, updated: today || new Date().toISOString().slice(0, 10), services },
    notes,
  };
}

// ---------- --fake: 가짜 채팅 페이지 (실제 사이트에 접속하지 않고 도구가 제대로 도는지 확인) ----------

const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** 셀렉터를 공백(자손) 단위로 나눈다 — [ ] · ( ) 안의 공백은 나누지 않음 */
function splitCompound(sel) {
  const out = [];
  let cur = '';
  let depth = 0;
  let quote = null;
  for (const ch of String(sel)) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === '[' || ch === '(') {
      depth++;
      cur += ch;
    } else if (ch === ']' || ch === ')') {
      depth--;
      cur += ch;
    } else if ((ch === ' ' || ch === '>') && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 단순 셀렉터 하나(tag#id.class[attr="v"]) → { tag, attrs }. :not(...) 같은 것은 무시 */
function parseCompound(c) {
  const s = c.replace(/:not\([^)]*\)/g, '').replace(/::?[\w-]+(\([^)]*\))?/g, '');
  const tag = (s.match(/^[a-z][\w-]*/i) || ['div'])[0];
  const attrs = {};
  const classes = [];
  for (const m of s.matchAll(/#([\w-]+)/g)) attrs.id = m[1];
  for (const m of s.replace(/\[[^\]]*\]/g, '').matchAll(/\.([\w-]+)/g)) classes.push(m[1]);
  for (const m of s.matchAll(/\[\s*([\w-]+)\s*(?:[*^$|~]?=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*(?:i)?\s*\]/g)) {
    const name = m[1];
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    if (name === 'class') classes.push(val);
    else attrs[name] = val;
  }
  if (classes.length) attrs.class = classes.join(' ');
  return { tag, attrs };
}

/** 셀렉터에 맞는 요소 HTML을 만든다 (가짜 페이지용). inner: 가장 안쪽 요소의 글 */
function elementFromSelector(sel, inner = '') {
  const chain = splitCompound(sel).map(parseCompound);
  let html = escAttr(inner);
  for (let i = chain.length - 1; i >= 0; i--) {
    const { tag, attrs } = chain[i];
    const a = Object.entries(attrs)
      .map(([k, v]) => ` ${k}="${escAttr(v)}"`)
      .join('');
    const isVoid = /^(input|img|br|hr)$/i.test(tag);
    html = isVoid ? `<${tag}${a} style="display:block">` : `<${tag}${a} style="display:block;min-height:12px;min-width:40px">${html}</${tag}>`;
  }
  return html;
}

/**
 * 가짜 채팅 페이지: kind 'ok'(입력창 · 보내기 버튼이 그 서비스 첫 셀렉터 모양) · 'broken'(입력창 없음) · 'logged-out'(로그인 버튼)
 * 실제 사이트 화면이 아니며 질문 · 답변 글도 없다.
 */
function fakePage(svc, kind = 'ok') {
  const body = [];
  body.push(`<p>테스트용 가짜 페이지 — ${escAttr(svc.name)} (${escAttr(kind)})</p>`);
  if (kind === 'logged-out') body.push('<button>Log in</button><button>Sign in</button>');
  if (kind !== 'broken' && svc.input?.[0]) body.push(elementFromSelector(svc.input[0]));
  if (kind !== 'broken' && svc.send?.[0]) body.push(elementFromSelector(svc.send[0], 'send'));
  return `<!doctype html><meta charset="utf-8"><title>fake ${escAttr(svc.id)}</title><body style="background:#111;color:#ddd;font:13px sans-serif">${body.join('\n')}</body>`;
}

/** --fake에서 서비스마다 고르는 가짜 페이지 종류 (실패 · 로그아웃 경로도 보이게 둘은 일부러 다르게) */
function fakeKind(id) {
  return id === 'deepseek' ? 'broken' : id === 'perplexity' ? 'logged-out' : 'ok';
}

const USAGE = `셀렉터 점검 (읽기 전용 — 사이트에 입력하거나 보내지 않습니다)

  npm run selectors:probe -- [서비스 id ...] [--fake] [--out 보고서.json] [--wait 초] [--show] [--remote 파일 | --builtin]

  MLA_PROFILE=<앱 프로필 폴더>  로그인된 앱 프로필의 쿠키로 엽니다 (앱을 먼저 끄세요). 없으면 빈 프로필(로그아웃 상태).
  --fake      실제 사이트 대신 가짜 페이지 (도구 시험용, 접속 없음)
  --out       JSON 보고서 경로 (없으면 임시 폴더)
  --wait      페이지마다 입력창이 나타나길 기다릴 최대 시간 (초, 기본 15)
  --remote    이 selectors.json을 앱 셀렉터에 더해서 점검 (기본: 저장소의 remote/selectors.json)
  --builtin   원격 셀렉터 없이 앱에 들어 있는 셀렉터만`;

module.exports = {
  PARTS,
  USAGE,
  parseArgs,
  probeConfig,
  summarize,
  buildReport,
  formatSummary,
  patchSkeleton,
  splitCompound,
  parseCompound,
  elementFromSelector,
  fakePage,
  fakeKind,
};
