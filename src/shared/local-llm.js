// 로컬 LLM 패널 (v0.16.0): 이 PC에서 돌아가는 OpenAI 호환 서버(Ollama · LM Studio · llama.cpp)에 직접 묻는다.
// 웹페이지가 아닌 패널이라, 앱이 대화를 들고 있다가 질문을 보내고 답을 받아(스트리밍) 패널에 말풍선으로 그린다.
// Electron 앱(메인, require)과 크롬 확장 프로그램(host.js, 전역 MLA.localLLM)이 같이 쓴다.
//
// [쉽게 말하면]
//   - 선택 기능입니다. 설정에서 켜야 모델 목록에 "로컬 LLM"이 나옵니다. 기본은 지금처럼 웹 채팅만.
//   - 주소는 이 PC(localhost · 127.0.0.1 · [::1])만 받습니다. API 키 · 바깥 주소는 받지 않습니다 → 질문 · 코드가 PC 밖으로 나가지 않습니다.
//   - 답변 감시 · 종합 · 비교 · 통계는 웹 패널과 똑같이 동작하도록, 웹 패널과 같은 모양의 "페이지 사진"(snapshot)을 돌려줍니다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).localLLM = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LOCAL_ID = 'local';
  const DEFAULT_BASE = 'http://localhost:11434'; // Ollama 기본 주소 (LM Studio는 http://localhost:1234)
  const MAX_TURNS = 40; // 대화에 남기는 최대 메시지 수 (오래된 것부터 뺀다)
  const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

  /** 서비스 목록에 붙일 로컬 LLM 항목 (웹 서비스 목록 SERVICES와는 따로 둔다) */
  function localService(cfg = {}) {
    return {
      id: LOCAL_ID,
      name: '로컬 LLM',
      color: '#f97316',
      kind: 'local',
      url: normalizeBaseUrl(cfg.baseUrl) || DEFAULT_BASE,
      hosts: [],
      upload: { accept: ['image'] }, // 이미지 첨부만 (비전 모델일 때). 문서는 본문으로 보낸다.
    };
  }

  /** 주소 검사: http(s)이고 호스트가 이 PC일 때만 → "http://localhost:11434" (경로 · 계정 · 쿼리 없이) | null */
  function normalizeBaseUrl(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    let u;
    try {
      u = new URL(raw.trim());
    } catch {
      return null;
    }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null;
    if (!LOCAL_HOSTS.includes(u.hostname.toLowerCase())) return null;
    return `${u.protocol}//${u.host}`;
  }

  /** 모델 이름 검사 (서버가 준 이름 · 사용자가 고른 이름) */
  const cleanModel = (m) => (typeof m === 'string' && /^[\w.:/@+-]{1,120}$/.test(m.trim()) ? m.trim() : '');

  /** 서버의 모델 목록 → [이름] (OpenAI 호환 /v1/models) */
  async function listModels(fetchFn, baseUrl, { signal } = {}) {
    const base = normalizeBaseUrl(baseUrl);
    if (!base) throw new Error('주소는 이 PC(localhost · 127.0.0.1)만 쓸 수 있습니다');
    const res = await fetchFn(`${base}/v1/models`, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`모델 목록을 받지 못했습니다 (HTTP ${res.status})`);
    const data = await res.json();
    return (Array.isArray(data?.data) ? data.data : []).map((m) => cleanModel(m?.id)).filter(Boolean).slice(0, 200);
  }

  /** 질문 글 + 이미지 → OpenAI 형식 content (이미지가 없으면 글 그대로) */
  function toContent(text, images = []) {
    if (!images.length) return text;
    return [{ type: 'text', text }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))];
  }

  /**
   * SSE(스트리밍 응답) 글 조각을 읽는다. 끝나지 않은 마지막 줄은 rest로 돌려준다.
   * → { deltas: [더할 글], done: [DONE]을 봤는지, rest }
   */
  function parseSSE(buffer) {
    const lines = buffer.split(/\r?\n/);
    const rest = lines.pop();
    const deltas = [];
    let done = false;
    for (const line of lines) {
      const m = /^data:\s?(.*)$/.exec(line.trim());
      if (!m) continue;
      if (m[1] === '[DONE]') {
        done = true;
        continue;
      }
      try {
        const j = JSON.parse(m[1]);
        const d = j?.choices?.[0]?.delta?.content ?? j?.choices?.[0]?.message?.content ?? j?.message?.content;
        if (typeof d === 'string' && d) deltas.push(d);
      } catch {} // 줄이 깨졌으면 건너뛴다
    }
    return { deltas, done, rest };
  }

  /**
   * 로컬 LLM 대화 하나 (패널 하나).
   * fetchFn: fetch 함수, getConfig(): { baseUrl, model }, onUpdate(view): 대화가 바뀔 때 (패널 다시 그리기)
   *   view: { messages: [{ role, text, images }], streaming, model, error }
   * → { send(text, images), stop(), reset(), snapshot(), view() }
   */
  function createLocalChat({ fetchFn, getConfig, onUpdate }) {
    let messages = []; // { role: 'user' | 'assistant', text, images: [data URL] }
    let streaming = false;
    let error = '';
    let ctrl = null;
    let model = '';

    const view = () => ({
      messages: messages.map((m) => ({ role: m.role, text: m.text, images: m.images ? m.images.length : 0 })),
      streaming,
      model,
      error,
    });
    const changed = () => onUpdate?.(view());

    /** 웹 패널과 같은 모양의 "페이지 사진": 답변 감시(watch) · 답변 읽기가 이것을 본다 */
    function snapshot() {
      const answers = messages.filter((m) => m.role === 'assistant');
      const last = answers[answers.length - 1];
      return { stop: streaming, count: answers.length, text: last ? last.text : '', md: last ? last.text : '' };
    }

    /** 질문을 보낸다. 서버가 받아들이면 { ok: true, via: 'local' }, 아니면 { ok: false, error } (답은 이어서 스트리밍) */
    async function send(text, images = []) {
      if (streaming) return { ok: false, error: '로컬 LLM이 아직 답하는 중입니다 (중지하거나 끝난 뒤 보내세요)' };
      const cfg = getConfig() || {};
      const base = normalizeBaseUrl(cfg.baseUrl);
      model = cleanModel(cfg.model);
      if (!base) return { ok: false, error: '로컬 LLM 주소가 올바르지 않습니다 (설정 › 로컬 LLM)' };
      if (!model) return { ok: false, error: '로컬 LLM 모델을 고르세요 (설정 › 로컬 LLM › 연결 확인)' };
      const user = { role: 'user', text: String(text || ''), images: images.length ? images : undefined };
      const history = [...messages, user].slice(-MAX_TURNS).map((m) => ({ role: m.role, content: m.role === 'user' ? toContent(m.text, m.images || []) : m.text }));
      ctrl = new AbortController();
      let res;
      try {
        res = await fetchFn(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({ model, messages: history, stream: true }),
          signal: ctrl.signal,
        });
      } catch (err) {
        error = `연결하지 못했습니다: ${err.message}`;
        changed();
        return { ok: false, error: `로컬 LLM에 ${error} (서버가 켜져 있는지 확인하세요)` };
      }
      if (!res.ok) {
        let why = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.error) why += ` — ${typeof j.error === 'string' ? j.error : j.error.message || ''}`;
        } catch {}
        error = why;
        changed();
        return { ok: false, error: `로컬 LLM이 질문을 받지 않았습니다 (${why})` };
      }
      error = '';
      messages.push(user);
      const answer = { role: 'assistant', text: '' };
      messages.push(answer);
      if (messages.length > MAX_TURNS) messages = messages.slice(-MAX_TURNS);
      streaming = true;
      changed();
      readStream(res, answer); // 기다리지 않는다 — 답변 감시가 snapshot으로 지켜본다
      return { ok: true, via: 'local' };
    }

    async function readStream(res, answer) {
      let lastPush = 0;
      try {
        const type = res.headers?.get?.('content-type') || '';
        if (!res.body || /application\/json/i.test(type)) {
          // 스트리밍을 하지 않는 서버: 한 번에 받은 답
          const j = await res.json();
          answer.text = String(j?.choices?.[0]?.message?.content ?? j?.message?.content ?? '');
        } else {
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const p = parseSSE(buf);
            buf = p.rest;
            if (p.deltas.length) answer.text += p.deltas.join('');
            const now = Date.now();
            if (now - lastPush > 120) {
              lastPush = now;
              changed();
            }
            if (p.done) break;
          }
          if (buf) answer.text += parseSSE(`${buf}\n`).deltas.join('');
        }
      } catch (err) {
        if (err.name !== 'AbortError') error = `답을 받다가 끊겼습니다: ${err.message}`;
      } finally {
        streaming = false;
        ctrl = null;
        if (!answer.text && error) answer.text = `⚠ ${error}`;
        changed();
      }
    }

    function stop() {
      ctrl?.abort();
    }

    /** 새 대화: 지금까지의 대화를 지운다 */
    function reset() {
      stop();
      messages = [];
      error = '';
      streaming = false;
      changed();
    }

    return { send, stop, reset, snapshot, view };
  }

  /** 첨부 파일(이미지) → data URL. file: { type, data(ArrayBuffer · Uint8Array) } */
  function imageDataUrl(file, toBase64) {
    if (!file || !/^image\//.test(file.type || '')) return null;
    return `data:${file.type};base64,${toBase64(file.data)}`;
  }

  return { LOCAL_ID, DEFAULT_BASE, LOCAL_HOSTS, localService, normalizeBaseUrl, cleanModel, listModels, toContent, parseSSE, createLocalChat, imageDataUrl };
});
