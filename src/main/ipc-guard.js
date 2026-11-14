'use strict';

// 화면(renderer)이 IPC로 넘긴 값을 앱 쪽(main)에서 다시 검사하는 도우미 모음.
// 화면 코드가 이미 검사했더라도, 앱 쪽은 받은 값을 믿지 않고 모양 · 크기 · 주소를 한 번 더 본다.
// electron 없이 순수 함수로만 만들어 테스트(test/ipc-guard.test.js)에서 바로 불러 쓸 수 있다.

const L = require('../shared/local-llm');

/**
 * 화면에서 받은 첨부 파일 검사.
 * files: [{ name, type, lastModified, data: ArrayBuffer | Uint8Array }] (preload는 ArrayBuffer를 보낸다)
 * limits: { maxFiles, maxFileBytes, maxTotalBytes }
 * → { ok: true, files: [...] } | { ok: false, error: '이유' }
 */
function checkFiles(files, limits) {
  if (files === undefined) return { ok: true, files: [] };
  if (!Array.isArray(files)) return { ok: false, error: '첨부 파일 목록의 모양이 올바르지 않습니다' };
  if (files.length > limits.maxFiles) return { ok: false, error: `첨부 파일은 ${limits.maxFiles}개까지 보낼 수 있습니다` };
  let total = 0;
  const out = [];
  for (const f of files) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return { ok: false, error: '첨부 파일의 모양이 올바르지 않습니다' };
    if (typeof f.name !== 'string' || !f.name) return { ok: false, error: '첨부 파일 이름이 없습니다' };
    // 내용은 ArrayBuffer 또는 Uint8Array만 받는다 (DataView · 다른 배열이나 숫자 · 문자열은 거절)
    if (!(f.data instanceof ArrayBuffer || f.data instanceof Uint8Array)) return { ok: false, error: `첨부 파일 내용이 올바르지 않습니다: ${f.name.slice(0, 200)}` };
    const size = f.data.byteLength;
    if (!Number.isSafeInteger(size) || size < 0) return { ok: false, error: `첨부 파일 크기를 알 수 없습니다: ${f.name.slice(0, 200)}` };
    if (size > limits.maxFileBytes) return { ok: false, error: `첨부 파일이 한도(${mb(limits.maxFileBytes)})를 넘었습니다: ${f.name.slice(0, 200)}` };
    total += size;
    if (total > limits.maxTotalBytes) return { ok: false, error: `첨부 파일 전체 크기가 한도(${mb(limits.maxTotalBytes)})를 넘었습니다` };
    out.push({ name: f.name.slice(0, 200), type: String(f.type || '').slice(0, 200), size, lastModified: Number(f.lastModified) || Date.now(), data: f.data });
  }
  return { ok: true, files: out };
}

const mb = (n) => `${Math.round(n / (1024 * 1024))}MB`;

/**
 * project:readFile 옵션 정리: 아는 항목(maxBytes)만 남기고, 0보다 큰 유한한 수일 때만 쓰되 앱 쪽 최대값(cap)을 넘지 않게 자른다.
 * 그 밖의 값이면 maxBytes를 빼서 project.readFile의 기본값을 쓰게 한다.
 */
function readFileOpts(opts, cap) {
  const out = {};
  const n = opts && typeof opts === 'object' ? opts.maxBytes : undefined;
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) out.maxBytes = Math.min(Math.floor(n) || 1, cap);
  return out;
}

/** 로컬 LLM 주소 다시 검사: 이 PC(localhost · 127.0.0.1 · [::1])의 http(s) 주소면 정리한 주소, 아니면 null */
const localBaseUrl = (raw) => L.normalizeBaseUrl(raw);

module.exports = { checkFiles, readFileOpts, localBaseUrl };
