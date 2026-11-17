// 기록 의미 검색 (v0.36.0): 이 PC의 로컬 서버(OpenAI 호환 /v1/embeddings)로 기록마다 "뜻 벡터"를 만들어 두고,
// 질문과 비슷한 뜻의 기록을 찾는다. 로컬 LLM을 켠 사람만 쓰고, 글은 localhost 밖으로 나가지 않는다 (주소 검사는 local-llm normalizeBaseUrl).
// 벡터는 길이 1로 맞춰(정규화) 저장해 두어 곱하기만으로 코사인 유사도가 나온다. 기록 글이 바뀌면(해시가 다르면) 그 기록만 다시 만든다.
// Electron 앱(require)과 크롬 확장 · 화면(전역 MLA.embedIndex)이 같이 쓴다. 저장은 쓰는 쪽이 load / save로 넘긴다.
//
// [쉽게 말하면] "예전에 물어본 것 중 이 질문과 비슷한 것"을 단어가 달라도 찾아 주는 부품입니다. 처음 한 번 [색인 만들기]가 필요합니다.
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./local-llm') : root.MLA && root.MLA.localLLM);
  if (isNode) module.exports = api;
  else (root.MLA = root.MLA || {}).embedIndex = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (LL) {
  'use strict';

  const VERSION = 1;
  const MAX_TEXT = 1200; // 기록 하나에서 벡터로 만드는 글의 길이 (질문 + 답변 앞부분)
  const BATCH = 16; // 한 번에 서버에 보내는 글 수
  const MAX_DIM = 8192;
  const MIN_SCORE = 0.2; // 이보다 비슷하지 않으면 결과에 넣지 않는다
  const TOP = 40;
  const FRESH_LIMIT = 24; // 검색할 때 새 기록(색인에 없는 것)을 이만큼까지는 먼저 만들어 넣는다

  const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

  /** 기록 → 벡터로 만들 글: 질문 + 답변 둘의 앞부분 + 종합 앞부분 (최대 MAX_TEXT자) */
  function recordText(rec) {
    if (!rec || typeof rec !== 'object') return '';
    const parts = [String(rec.question || '').slice(0, 500)];
    const answers = rec.answers && typeof rec.answers === 'object' ? Object.values(rec.answers) : [];
    for (const a of answers.filter((x) => x && typeof x.text === 'string' && x.text).slice(0, 2)) parts.push(a.text.slice(0, 350));
    const synth = Array.isArray(rec.synth) ? rec.synth.find((s) => s && typeof s.text === 'string' && s.text && s.mode !== 'analysis') : null;
    if (synth) parts.push(synth.text.slice(0, 250));
    return parts.filter(Boolean).join('\n').slice(0, MAX_TEXT).trim();
  }

  /** 짧은 글 지문 (FNV-1a 32비트): 글이 바뀌었는지만 본다 */
  function hashText(s) {
    let h = 0x811c9dc5;
    const str = String(s);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  /** 벡터 → 길이 1 (0 벡터 · 숫자가 아닌 값이 있으면 null) */
  function normalize(vec) {
    if (!Array.isArray(vec) && !(vec instanceof Float32Array)) return null;
    if (vec.length < 2 || vec.length > MAX_DIM) return null;
    let sum = 0;
    for (let i = 0; i < vec.length; i++) {
      if (!Number.isFinite(vec[i])) return null;
      sum += vec[i] * vec[i];
    }
    if (!sum) return null;
    const n = Math.sqrt(sum);
    const out = new Float32Array(vec.length);
    for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
    return out;
  }

  function toB64(f32) {
    const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(b64, dim) {
    if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(b64)) return null;
    let s;
    try {
      s = atob(b64);
    } catch {
      return null;
    }
    if (s.length !== dim * 4) return null;
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  }

  const dot = (a, b) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  };

  /** 빈 색인 */
  const emptyIndex = (model = '') => ({ v: VERSION, model, dim: 0, items: {} });

  /**
   * 저장해 둔 색인 검사 → 쓸 수 있는 색인. 모델이 다르거나 모양이 틀리면 빈 색인 (벡터 길이 · 글자 모양이 틀린 항목은 버린다).
   * 색인: { v, model, dim, items: { [기록 id]: { h: 글 지문, v: base64 Float32 } } }
   */
  function cleanIndex(raw, model) {
    const empty = emptyIndex(model);
    if (!raw || typeof raw !== 'object' || raw.v !== VERSION || raw.model !== model || !Number.isInteger(raw.dim) || raw.dim < 2 || raw.dim > MAX_DIM) return empty;
    const items = {};
    for (const [id, it] of Object.entries(raw.items && typeof raw.items === 'object' ? raw.items : {})) {
      if (!/^[A-Za-z0-9-]{1,40}$/.test(id) || !it || typeof it.h !== 'string' || !fromB64(it.v, raw.dim)) continue;
      items[id] = { h: it.h.slice(0, 20), v: it.v };
    }
    return { v: VERSION, model, dim: raw.dim, items };
  }

  /** 색인에 넣어야 할 기록 (색인에 없거나 글이 바뀐 것, 글이 없는 기록은 뺌) → [{ id, text, h }] 최근 것부터 */
  function pending(records, index) {
    const out = [];
    for (const r of Array.isArray(records) ? records : []) {
      if (!r || typeof r.id !== 'string') continue;
      const text = recordText(r);
      if (!text) continue;
      const h = hashText(text);
      if (!index.items[r.id] || index.items[r.id].h !== h) out.push({ id: r.id, text, h });
    }
    return out;
  }

  /** 지금 기록에 없는 항목은 색인에서 뺀다 → 지운 개수 */
  function prune(index, records) {
    const ids = new Set((Array.isArray(records) ? records : []).map((r) => r && r.id));
    let n = 0;
    for (const id of Object.keys(index.items)) {
      if (!ids.has(id)) {
        delete index.items[id];
        n++;
      }
    }
    return n;
  }

  /**
   * 색인 만들기 (이어서 가능): 빠진 기록을 batch개씩 embed(texts) → 벡터들로 만들어 index에 더한다.
   * embed(texts: string[]) → Promise<number[][]> (글과 같은 순서 · 같은 개수). 실패하면 그때까지의 결과는 남기고 error를 알린다.
   * opts: { records, index, embed, batch, max (이번에 만들 최대 기록 수), onProgress({ done, total }), isCancelled() }
   * → { index, done, total, error? }
   */
  async function build({ records, index, embed, batch = BATCH, max = Infinity, onProgress, isCancelled } = {}) {
    const todo = pending(records, index).slice(0, max);
    let done = 0;
    onProgress?.({ done, total: todo.length });
    for (let i = 0; i < todo.length; i += batch) {
      if (isCancelled?.()) return { index, done, total: todo.length, error: 'cancelled' };
      const chunk = todo.slice(i, i + batch);
      let vecs;
      try {
        vecs = await embed(chunk.map((c) => c.text));
      } catch (err) {
        return { index, done, total: todo.length, error: err.message || String(err) };
      }
      if (!Array.isArray(vecs) || vecs.length !== chunk.length) return { index, done, total: todo.length, error: 'count' };
      for (let j = 0; j < chunk.length; j++) {
        const v = normalize(vecs[j]);
        if (!v) continue; // 벡터가 깨진 기록은 건너뛴다 (다음에 다시 시도)
        if (!index.dim) index.dim = v.length;
        if (v.length !== index.dim) return { index, done, total: todo.length, error: 'dim' }; // 모델을 바꾼 것 같다
        index.items[chunk[j].id] = { h: chunk[j].h, v: toB64(v) };
        done++;
      }
      onProgress?.({ done, total: todo.length });
    }
    return { index, done, total: todo.length };
  }

  /**
   * 비슷한 뜻 찾기: qvec(정규화된 벡터)와 색인의 코사인 유사도 → [{ id, score }] 높은 순 (MIN_SCORE 아래는 뺌, top개까지)
   * ids: 있으면 그 기록만 본다 (Set)
   */
  function search(index, qvec, { ids, top = TOP, minScore = MIN_SCORE } = {}) {
    const q = normalize(qvec);
    if (!q || !index.dim || q.length !== index.dim) return [];
    const out = [];
    for (const [id, it] of Object.entries(index.items)) {
      if (ids && !ids.has(id)) continue;
      const v = fromB64(it.v, index.dim);
      if (!v) continue;
      const score = dot(q, v);
      if (score >= minScore) out.push({ id, score: Math.round(score * 1000) / 1000 });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, top);
  }

  /**
   * 로컬 서버에 글들을 벡터로 바꿔 달라고 한다 (OpenAI 호환 POST /v1/embeddings). 주소는 이 PC만.
   * → number[][] (글과 같은 순서). 실패하면 code가 있는 Error: baseUrl · model · http · shape
   */
  async function embedTexts({ fetchFn, baseUrl, model, texts, signal }) {
    const base = LL.normalizeBaseUrl(baseUrl);
    if (!base) throw fail('baseUrl');
    const m = LL.cleanModel(model);
    if (!m) throw fail('model');
    const res = await fetchFn(`${base}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ model: m, input: texts }),
      signal,
    });
    if (!res.ok) throw fail('http', { status: res.status });
    const j = await res.json();
    const data = Array.isArray(j && j.data) ? [...j.data] : [];
    data.sort((a, b) => (a && a.index) - (b && b.index));
    const vecs = data.map((d) => d && d.embedding);
    if (vecs.length !== texts.length || !vecs.every((v) => Array.isArray(v) && v.length >= 2)) throw fail('shape');
    return vecs;
  }

  /**
   * 의미 검색 서비스 (앱 · 확장 공통). 저장은 load() → 저장된 색인 | null, save(index)로 넘긴다 (Promise).
   *   getConfig(): { enabled, baseUrl, embedModel } · getRecords(): 기록 배열(최근 것부터) · fetchFn · listByIds(ids, filters) → 목록 요약들
   * → { status(), build(), search(query, filters) }
   */
  function createEmbedService({ getConfig, getRecords, fetchFn, load, save, listByIds, now = Date.now }) {
    let index = null;
    let loadedModel = null;
    let building = null; // { done, total, startedAt }
    let lastError = '';
    let cancelled = false;

    const cfg = () => {
      const c = getConfig() || {};
      return { enabled: c.enabled === true, baseUrl: c.baseUrl, model: LL.cleanModel(c.embedModel) };
    };
    async function ensureLoaded(model) {
      if (index && loadedModel === model) return index;
      index = cleanIndex(await Promise.resolve(load()).catch(() => null), model);
      loadedModel = model;
      return index;
    }
    const embedFor = (c) => (texts) => embedTexts({ fetchFn, baseUrl: c.baseUrl, model: c.model, texts });
    const errText = (err) => (err && err.code ? `${err.code}${err.status ? ` ${err.status}` : ''}` : (err && err.message) || String(err));

    async function status() {
      const c = cfg();
      const records = getRecords() || [];
      if (!c.enabled || !c.model) return { ok: true, ready: false, enabled: c.enabled, model: c.model, count: 0, total: records.length, building: !!building, error: lastError };
      const idx = await ensureLoaded(c.model);
      const have = records.filter((r) => r && idx.items[r.id]).length;
      return { ok: true, ready: have > 0, enabled: true, model: c.model, count: have, total: records.length, building: building ? { done: building.done, total: building.total } : false, error: lastError };
    }

    /** 색인을 (이어서) 만든다 — 기다리지 않고 바로 돌아오고, 진행은 status()로 본다 */
    async function startBuild() {
      const c = cfg();
      if (!c.enabled) return { ok: false, error: 'off' };
      if (!c.model) return { ok: false, error: 'model' };
      if (building) return { ok: true, already: true };
      const idx = await ensureLoaded(c.model);
      building = { done: 0, total: 0, startedAt: now() };
      cancelled = false;
      lastError = '';
      (async () => {
        try {
          const records = getRecords() || [];
          prune(idx, records);
          const r = await build({
            records,
            index: idx,
            embed: embedFor(c),
            onProgress: (p) => Object.assign(building, p),
            isCancelled: () => cancelled,
          });
          if (r.error && r.error !== 'cancelled') lastError = r.error;
          if (r.error === 'dim') {
            index = emptyIndex(c.model); // 모델이 바뀌었으면 처음부터 다시 만든다
            loadedModel = c.model;
            lastError = 'dim';
          }
          await Promise.resolve(save(index)).catch(() => {});
        } catch (err) {
          lastError = errText(err);
        } finally {
          building = null;
        }
      })();
      return { ok: true };
    }

    const stopBuild = () => {
      cancelled = true;
    };

    /**
     * 질문과 비슷한 뜻의 기록: { ok, items: [목록 요약 + score], error? }. filters는 history-search cleanFilters 모양(이미 검사됨).
     * 색인에 없는 새 기록은 FRESH_LIMIT개까지 먼저 만들어 넣는다. 색인이 아예 비었으면 { ok: false, error: 'noIndex' }
     */
    async function searchSimilar(query, filters) {
      const c = cfg();
      if (!c.enabled) return { ok: false, error: 'off' };
      if (!c.model) return { ok: false, error: 'model' };
      const q = String(query || '').trim().slice(0, 500);
      if (!q) return { ok: true, items: [] };
      const idx = await ensureLoaded(c.model);
      const records = getRecords() || [];
      if (!Object.keys(idx.items).length && !building) return { ok: false, error: 'noIndex' };
      try {
        if (!building) {
          const fresh = await build({ records, index: idx, embed: embedFor(c), max: FRESH_LIMIT });
          if (fresh.done) await Promise.resolve(save(index || idx)).catch(() => {});
        }
        const [qv] = await embedFor(c)([q]);
        const ids = new Set(listByIds(records.map((r) => r.id), filters).map((x) => x.id)); // 거르기에 맞는 기록만
        const hits = search(idx, qv, { ids });
        const sums = new Map(listByIds(hits.map((h) => h.id), filters).map((x) => [x.id, x]));
        const items = hits.filter((h) => sums.has(h.id)).map((h) => ({ ...sums.get(h.id), score: h.score }));
        return { ok: true, items, indexed: Object.keys(idx.items).length };
      } catch (err) {
        return { ok: false, error: errText(err) };
      }
    }

    /** 색인을 지운다 (기록을 모두 지울 때) */
    async function clear() {
      cancelled = true;
      index = null;
      loadedModel = null;
      await Promise.resolve(save(null)).catch(() => {});
    }

    return { status, startBuild, stopBuild, searchSimilar, clear, _index: () => index };
  }

  return {
    VERSION, MAX_TEXT, BATCH, MIN_SCORE, TOP, FRESH_LIMIT,
    recordText, hashText, normalize, toB64, fromB64, emptyIndex, cleanIndex, pending, prune, build, search, embedTexts, createEmbedService,
  };
});
