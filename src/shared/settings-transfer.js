// 설정 옮기기 (v0.29.0): 설정 · 라이브러리를 .mla.json 파일 하나로 내보내고, 다른 PC · 앱 · 크롬 확장에서 가져온다.
// 화면(Windows 앱 · 크롬 확장 app.html, 전역 MLA.settingsTransfer)과 테스트(require)가 같이 쓴다.
//
// 파일에 넣는 것: 설정 일부(고른 모델 · 배치 · 종합 담당과 자동 종합 · 답변 대기 시간 · 알림 · 보내기 전 미리보기 · 다시 보내기 ·
//   추천 조합 · 기록 최대 개수 · 적용 후 커밋 제안 · 로컬 LLM 설정) + 라이브러리(내 템플릿 · 스킬(이전 버전 포함) · 프리셋).
// 넣지 않는 것: 질문 · 답변 기록, 프로젝트 폴더 · 상태, 로그인 정보(쿠키), 마지막에 넣은 템플릿 변수 값.
// 비밀번호를 넣으면 암호화한다: PBKDF2-SHA256(25만 번, 무작위 salt 16바이트) → AES-GCM 256(무작위 iv 12바이트).
//   globalThis.crypto.subtle만 쓴다 — Electron 화면 · 크롬 확장 · Node 20+가 모두 같은 파일을 읽고 쓴다.
//
// [쉽게 말하면] 내 설정과 템플릿 · 스킬 · 프리셋을 파일 하나로 옮기는 기능의 계산을 맡습니다.
//   파일 만들기 · 암호 걸기/풀기 · 파일 검사 · "무엇이 바뀌는지" 목록 · 라이브러리 합치기(덮어쓰기 / 둘 다 남기기).
//   실제로 설정을 바꾸는 일은 화면(settings-transfer-ui.js)이 기존 설정 창구(host.setSettings 등)로 하고, 본체가 다시 검사합니다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).settingsTransfer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KIND = 'multitude-llm-settings';
  const ENC_KIND = 'multitude-llm-settings-encrypted';
  const VERSION = 1;
  const ITERATIONS = 250000; // PBKDF2 반복 횟수 (20만 번 이상)
  const MIN_ITERATIONS = 200000;
  const MAX_ITERATIONS = 5000000; // 파일이 터무니없는 값을 적어도 화면이 멈추지 않게
  const MAX_FILE_CHARS = 5 * 1024 * 1024;
  const MIN_PASSWORD = 8;
  // 옮기는 설정 (이 순서로 보여 준다)
  const KEYS = ['selected', 'layout', 'synthTarget', 'autoSynth', 'answerTimeoutMin', 'historyMax', 'notify', 'sendPreview', 'retryOnce', 'autoRecommend', 'commitOffer', 'historyArchive', 'lang', 'local'];
  const BOOL_KEYS = ['autoSynth', 'sendPreview', 'retryOnce', 'autoRecommend', 'commitOffer', 'historyArchive'];
  const ID = /^[a-z0-9-]{1,40}$/;

  /** 오류 (화면이 code로 문구를 고른다: json · kind · version · size · password · crypto) */
  const fail = (code) => Object.assign(new Error(code), { code });

  // ---------- 설정 고르기 · 검사 ----------

  /** 화면 상태(state) 또는 저장된 설정에서 옮길 값만 → 검사한 설정 */
  function pickSettings(s) {
    const src = s && typeof s === 'object' ? s : {};
    return cleanSettings(Object.fromEntries(KEYS.filter((k) => src[k] !== undefined).map((k) => [k, src[k]])));
  }

  /** 파일에서 읽은 설정 검사: 아는 칸 · 맞는 모양만 남긴다 (값의 범위는 받는 쪽 설정 창구가 다시 본다) */
  function cleanSettings(raw) {
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = {};
    if (Array.isArray(r.selected)) out.selected = [...new Set(r.selected.filter((id) => typeof id === 'string' && ID.test(id)))].slice(0, 6);
    if (typeof r.layout === 'string' && /^[a-z]{1,20}$/.test(r.layout)) out.layout = r.layout;
    if (typeof r.synthTarget === 'string' && ID.test(r.synthTarget)) out.synthTarget = r.synthTarget;
    for (const k of BOOL_KEYS) if (typeof r[k] === 'boolean') out[k] = r[k];
    if (['auto', 'ko', 'en'].includes(r.lang)) out.lang = r.lang; // 화면 언어 (v0.30.0)
    for (const k of ['answerTimeoutMin', 'historyMax']) if (Number.isInteger(r[k]) && r[k] > 0 && r[k] <= 100000) out[k] = r[k];
    if (r.notify && typeof r.notify === 'object' && !Array.isArray(r.notify)) {
      const n = Object.entries(r.notify).filter(([k, v]) => /^[a-z]{1,20}$/.test(k) && typeof v === 'boolean').slice(0, 10);
      if (n.length) out.notify = Object.fromEntries(n);
    }
    if (r.local && typeof r.local === 'object' && !Array.isArray(r.local)) {
      const L = r.local;
      const local = {};
      if (typeof L.enabled === 'boolean') local.enabled = L.enabled;
      if (typeof L.baseUrl === 'string' && L.baseUrl.length <= 200) local.baseUrl = L.baseUrl;
      if (typeof L.model === 'string' && L.model.length <= 200) local.model = L.model;
      if (Number.isInteger(L.contextTokens) && L.contextTokens > 0) local.contextTokens = L.contextTokens;
      if (Object.keys(local).length) out.local = local;
    }
    return out;
  }

  // ---------- 파일 만들기 · 읽기 ----------

  /** 내보낼 내용 (암호화 전). library: normalizeLibrary 결과 — 템플릿 · 스킬 · 프리셋만 (변수 값 · 켠 스킬은 넣지 않음) */
  function buildExport({ settings, library, app = '', appVersion = '', now = Date.now() } = {}) {
    const lib = library || {};
    return {
      kind: KIND,
      version: VERSION,
      exportedAt: new Date(now).toISOString(),
      app: String(app).slice(0, 20),
      appVersion: String(appVersion).slice(0, 20),
      settings: cleanSettings(settings),
      library: { templates: lib.templates || [], skills: lib.skills || [], presets: lib.presets || [] },
    };
  }

  /**
   * 하나만 공유 (v0.35.0): 템플릿 · 스킬 · 프리셋 하나를 설정 옮기기와 같은 .mla.json 파일 모양으로 (설정 칸은 비움).
   * 프리셋은 그것이 쓰는 스킬과 템플릿(라이브러리에 있으면)도 함께 담는다. 스킬의 이전 버전(versions)은 지운 글이 남아 있을 수 있어 넣지 않는다.
   * → { name, counts: { templates, skills, presets }, payload } | null (그런 항목이 없음)
   */
  function buildShare({ kind, id, library, app = '', appVersion = '', now = Date.now() } = {}) {
    const lib = library || {};
    const find = (list) => (Array.isArray(list) ? list : []).find((x) => x && x.id === id);
    const strip = (s) => ({ ...s, versions: [] });
    let templates = [];
    let skills = [];
    let presets = [];
    let name = '';
    if (kind === 'template') {
      const x = find(lib.templates);
      if (!x) return null;
      templates = [x];
      name = x.name;
    } else if (kind === 'skill') {
      const x = find(lib.skills);
      if (!x) return null;
      skills = [strip(x)];
      name = x.name;
    } else if (kind === 'preset') {
      const x = find(lib.presets);
      if (!x) return null;
      const want = new Set(Array.isArray(x.skills) ? x.skills : []);
      skills = (lib.skills || []).filter((s) => s && want.has(s.id)).map(strip);
      const tid = x.template && x.template.id;
      templates = tid ? (lib.templates || []).filter((tp) => tp && tp.id === tid) : [];
      presets = [x];
      name = x.name;
    } else return null;
    const payload = buildExport({ settings: {}, library: { templates, skills, presets }, app, appVersion, now });
    return { name: String(name || kind).slice(0, 60), counts: { templates: templates.length, skills: skills.length, presets: presets.length }, payload };
  }

  /** 파일 글 → { encrypted: true, envelope } | { encrypted: false, data } (모양이 틀리면 code가 있는 Error) */
  function parseFile(text) {
    if (typeof text !== 'string' || text.length > MAX_FILE_CHARS) throw fail('size');
    let j;
    try {
      j = JSON.parse(text.replace(/^﻿/, ''));
    } catch {
      throw fail('json');
    }
    if (!j || typeof j !== 'object') throw fail('kind');
    if (j.kind === ENC_KIND) {
      if (j.version !== VERSION) throw fail('version');
      return { encrypted: true, envelope: j };
    }
    if (j.kind !== KIND) throw fail('kind');
    if (j.version !== VERSION) throw fail('version');
    return { encrypted: false, data: readPayload(j) };
  }

  /** 풀어 낸 내용 검사 → { settings, library: { templates, skills, presets }, app, exportedAt } */
  function readPayload(j) {
    const lib = j.library && typeof j.library === 'object' ? j.library : {};
    const arr = (v) => (Array.isArray(v) ? v : []);
    return {
      settings: cleanSettings(j.settings),
      library: { templates: arr(lib.templates), skills: arr(lib.skills), presets: arr(lib.presets) },
      app: typeof j.app === 'string' ? j.app.slice(0, 20) : '',
      exportedAt: typeof j.exportedAt === 'string' ? j.exportedAt.slice(0, 40) : '',
    };
  }

  // ---------- 암호 (PBKDF2-SHA256 → AES-GCM) ----------

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const subtleOf = (s) => s || globalThis.crypto?.subtle;
  function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(b64) {
    if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/=]*$/.test(b64)) throw fail('kind');
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  async function deriveKey(subtle, password, salt, iterations) {
    const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  /** 글을 비밀번호로 암호화한 파일 글 (JSON) */
  async function encrypt(text, password, { subtle, iterations = ITERATIONS, random } = {}) {
    const S = subtleOf(subtle);
    if (!S) throw fail('crypto');
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw fail('password');
    const rnd = random || ((n) => globalThis.crypto.getRandomValues(new Uint8Array(n)));
    const salt = rnd(16);
    const iv = rnd(12);
    const key = await deriveKey(S, password, salt, iterations);
    const data = new Uint8Array(await S.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)));
    return JSON.stringify(
      {
        kind: ENC_KIND,
        version: VERSION,
        kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toB64(salt) },
        cipher: { name: 'AES-GCM', iv: toB64(iv) },
        data: toB64(data),
      },
      null,
      2,
    );
  }

  /** 암호화된 파일(parseFile의 envelope) → 풀어 낸 글 (안의 종류는 보지 않음, 기록 옮기기도 같이 씀). 비밀번호가 틀리면 code 'password' */
  async function decryptText(envelope, password, { subtle } = {}) {
    const S = subtleOf(subtle);
    if (!S) throw fail('crypto');
    const e = envelope || {};
    const it = e.kdf?.iterations;
    if (e.kdf?.name !== 'PBKDF2' || e.kdf?.hash !== 'SHA-256' || e.cipher?.name !== 'AES-GCM') throw fail('kind');
    if (!Number.isInteger(it) || it < MIN_ITERATIONS || it > MAX_ITERATIONS) throw fail('kind');
    const salt = fromB64(e.kdf.salt);
    const iv = fromB64(e.cipher.iv);
    if (salt.length < 16 || iv.length !== 12) throw fail('kind');
    let plain;
    try {
      const key = await deriveKey(S, String(password || ''), salt, it);
      plain = dec.decode(await S.decrypt({ name: 'AES-GCM', iv }, key, fromB64(e.data)));
    } catch {
      throw fail('password'); // AES-GCM은 비밀번호가 틀리거나 글이 바뀌면 풀지 못한다
    }
    return plain;
  }

  /** 암호화된 설정 옮기기 파일 → 풀어 낸 내용 { settings, library, … } */
  async function decrypt(envelope, password, opts) {
    const plain = await decryptText(envelope, password, opts);
    const inner = parseFile(plain);
    if (inner.encrypted) throw fail('kind');
    return inner.data;
  }

  // ---------- 바뀌는 것 · 합치기 ----------

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /** 지금 설정과 가져올 설정의 차이 → [{ key, from, to }] (가져올 파일에 있는 칸만, KEYS 순서) */
  function diffSettings(cur, next) {
    const c = pickSettings(cur);
    const n = cleanSettings(next);
    return KEYS.filter((k) => n[k] !== undefined && !same(k === 'local' || k === 'notify' ? { ...c[k], ...n[k] } : n[k], c[k])).map((k) => ({ key: k, from: c[k], to: n[k] }));
  }

  const KINDS = [
    ['templates', 'u'],
    ['skills', 's'],
    ['presets', 'p'],
  ];

  /** 같은 id가 이미 있는 가져올 항목 수 → { templates, skills, presets, total } */
  function conflicts(cur, inc) {
    const out = { total: 0 };
    for (const [k] of KINDS) {
      const ids = new Set((cur?.[k] || []).map((x) => x.id));
      out[k] = (inc?.[k] || []).filter((x) => x && ids.has(x.id)).length;
      out.total += out[k];
    }
    return out;
  }

  /**
   * 라이브러리 합치기 (id로). mode 'overwrite': 같은 id는 가져온 것으로 바꿈 · 'keepBoth': 가져온 것을 새 id로 더함.
   * normalize: prompt-lib normalizeLibrary (한도 · 모양 검사), newId(prefix), copyName(name) → 둘 다 남길 때의 이름
   * → { lib, counts: { templates: { added, replaced, copied }, … }, dropped: 한도로 빠진 수 }
   */
  function mergeLibrary(cur, inc, { mode = 'overwrite', normalize, newId, copyName = (n) => n } = {}) {
    const base = normalize(cur || {});
    // 가져올 쪽도 같은 검사 (모양이 틀린 것은 빠짐). 프리셋은 지금 스킬 + 가져올 스킬을 함께 보고 검사한다
    const i = inc || {};
    const incLib = normalize({ templates: i.templates, skills: i.skills });
    const incoming = { templates: incLib.templates, skills: incLib.skills, presets: normalize({ skills: [...base.skills, ...incLib.skills], presets: i.presets }).presets };
    const next = { ...base };
    const counts = {};
    let wanted = 0;
    for (const [k, prefix] of KINDS) {
      const list = [...base[k]];
      const c = { added: 0, replaced: 0, copied: 0 };
      for (const item of incoming[k]) {
        const at = list.findIndex((x) => x.id === item.id);
        if (at < 0) {
          list.push(item);
          c.added++;
        } else if (mode === 'keepBoth') {
          list.push({ ...item, id: newId(prefix), name: copyName(item.name) });
          c.copied++;
        } else {
          list[at] = item;
          c.replaced++;
        }
      }
      wanted += list.length;
      next[k] = list;
      counts[k] = c;
    }
    const lib = normalize(next);
    const kept = KINDS.reduce((n, [k]) => n + lib[k].length, 0);
    return { lib, counts, dropped: wanted - kept };
  }

  return {
    KIND, ENC_KIND, VERSION, ITERATIONS, MIN_ITERATIONS, MIN_PASSWORD, KEYS,
    pickSettings, cleanSettings, buildExport, buildShare, parseFile, readPayload, encrypt, decrypt, decryptText, diffSettings, conflicts, mergeLibrary,
  };
});
