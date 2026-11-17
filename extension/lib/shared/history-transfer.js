// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/history-transfer.js)
// 기록 옮기기 (v0.35.0): 고른 기록을 파일 하나로 내보내고, 다른 PC · Windows 앱 · 크롬 확장에서 가져온다.
// 설정 옮기기 파일(.mla.json)과는 다른 파일(.mla-history.json)이다 — 설정 파일에는 기록을 넣지 않는다는 약속을 지키려고,
// 기록은 사용자가 고르고 누를 때만 따로 내보낸다. 암호화는 설정 옮기기와 같은 코드(PBKDF2-SHA256 → AES-GCM)를 쓴다.
// 화면(전역 MLA.historyTransfer)과 테스트(require)가 같이 쓴다. 가져온 기록의 모양 검사는 받는 쪽 본체(history-core cleanRecord)가 다시 한다.
//
// [쉽게 말하면] "이 질문들을 다른 PC에서도 보고 싶다"를 위한 기록 전용 옮기기 파일의 만들기 · 읽기 · 암호 계산입니다.
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./settings-transfer') : root.MLA && root.MLA.settingsTransfer);
  if (isNode) module.exports = api;
  else (root.MLA = root.MLA || {}).historyTransfer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ST) {
  'use strict';

  const KIND = 'multitude-llm-history';
  const VERSION = 1;
  const MAX_RECORDS = 2000; // 한 파일에 담는 기록 수
  const MAX_FILE_CHARS = 25 * 1024 * 1024; // 기록 글이 길어 설정 파일(5MB)보다 크다
  const fail = (code) => Object.assign(new Error(code), { code });

  /** 내보낼 내용 (암호화 전). records: 기록 배열 (오래된 것부터 담는다) */
  function buildExport({ records, app = '', appVersion = '', now = Date.now() } = {}) {
    const list = (Array.isArray(records) ? records : []).filter((r) => r && typeof r === 'object' && typeof r.id === 'string').slice(0, MAX_RECORDS);
    list.sort((a, b) => (a.at || 0) - (b.at || 0));
    return {
      kind: KIND,
      version: VERSION,
      exportedAt: new Date(now).toISOString(),
      app: String(app).slice(0, 20),
      appVersion: String(appVersion).slice(0, 20),
      count: list.length,
      records: list,
    };
  }

  /** 풀어 낸 내용 → { records, app, exportedAt, count } (기록 하나하나의 검사는 받는 쪽 본체가 한다) */
  function readPayload(j) {
    const records = (Array.isArray(j.records) ? j.records : []).filter((r) => r && typeof r === 'object' && !Array.isArray(r));
    if (records.length > MAX_RECORDS) throw fail('records');
    return {
      records,
      count: records.length,
      app: typeof j.app === 'string' ? j.app.slice(0, 20) : '',
      exportedAt: typeof j.exportedAt === 'string' ? j.exportedAt.slice(0, 40) : '',
    };
  }

  /** 파일 글 → { encrypted: true, envelope } | { encrypted: false, data } (모양이 틀리면 code가 있는 Error: size · json · kind · version · records) */
  function parseFile(text) {
    if (typeof text !== 'string' || text.length > MAX_FILE_CHARS) throw fail('size');
    let j;
    try {
      j = JSON.parse(text.replace(/^﻿/, ''));
    } catch {
      throw fail('json');
    }
    if (!j || typeof j !== 'object') throw fail('kind');
    if (j.kind === ST.ENC_KIND) {
      if (j.version !== ST.VERSION) throw fail('version');
      return { encrypted: true, envelope: j };
    }
    if (j.kind !== KIND) throw fail('kind'); // 설정 파일 · 다른 파일
    if (j.version !== VERSION) throw fail('version');
    return { encrypted: false, data: readPayload(j) };
  }

  /** 암호화된 파일의 envelope → 풀어 낸 내용. 비밀번호가 틀리면 code 'password', 기록 파일이 아니면 'kind' */
  async function decrypt(envelope, password, opts) {
    const plain = await ST.decryptText(envelope, password, opts);
    const inner = parseFile(plain);
    if (inner.encrypted) throw fail('kind');
    return inner.data;
  }

  /** 받은 기록 중 지금 있는 것과 id가 같은 수 (가져오기 전 안내용) */
  const countDuplicates = (existingIds, records) => {
    const have = existingIds instanceof Set ? existingIds : new Set(existingIds || []);
    return (records || []).filter((r) => r && have.has(r.id)).length;
  };

  return { KIND, VERSION, MAX_RECORDS, MAX_FILE_CHARS, buildExport, parseFile, readPayload, decrypt, countDuplicates, encrypt: ST.encrypt, MIN_PASSWORD: ST.MIN_PASSWORD };
});
