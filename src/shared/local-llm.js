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

  // 화면 문구 (v0.30.0): 부를 때마다 사전에서 찾는다 (언어를 바꾸면 바로 반영). 사전이 없는 곳(서비스 페이지 등)에서는 키 이름 그대로
  const t = (key, vars) => {
    const i18n = typeof module === 'object' && module.exports ? require('./i18n') : globalThis.MLA && globalThis.MLA.i18n;
    return i18n ? i18n.t(key, vars) : key;
  };

  const LOCAL_ID = 'local';
  // 로컬 패널은 최대 3개 (v0.36.0): 첫 패널은 예전 그대로 'local', 둘째 · 셋째는 'local-2' · 'local-3'. 패널마다 모델을 따로 고른다.
  const LOCAL_IDS = ['local', 'local-2', 'local-3'];
  const MAX_PANELS = LOCAL_IDS.length;
  const COLORS = ['#f97316', '#eab308', '#a855f7'];
  const isLocalId = (id) => LOCAL_IDS.includes(id);
  /** 패널 번호 (0 · 1 · 2), 로컬 패널이 아니면 -1 */
  const panelIndex = (id) => LOCAL_IDS.indexOf(id);
  /** 패널 수 설정 검사: 1 ~ 3 (아니면 1) */
  const normalizePanels = (v) => (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= MAX_PANELS ? Number(v) : 1);
  const DEFAULT_BASE = 'http://localhost:11434'; // Ollama 기본 주소 (LM Studio는 http://localhost:1234)
  const MAX_TURNS = 40; // 대화에 남기는 최대 메시지 수 (오래된 것부터 뺀다)
  const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
  // 로컬 모델 컨텍스트 한도 (v0.29.0, 토큰). 넘을 것 같으면 종합 입력은 줄여 보내고, 그 밖에는 경고만 한다.
  const CONTEXT_CHOICES = [2048, 4096, 8192, 16384, 32768, 131072];
  const DEFAULT_CONTEXT = 8192;
  const ASK_TIMEOUT_MS = 10 * 60 * 1000; // 패널 없이 한 번 묻기(판정 · 압축)의 최대 대기

  /** 서비스 목록에 붙일 로컬 LLM 항목 (웹 서비스 목록 SERVICES와는 따로 둔다). index: 패널 번호 (0 = 첫 패널) */
  function localService(cfg = {}, index = 0) {
    const i = Number.isInteger(index) && index >= 0 && index < MAX_PANELS ? index : 0;
    return {
      id: LOCAL_IDS[i],
      name: i ? `로컬 LLM ${i + 1}` : '로컬 LLM',
      color: COLORS[i],
      kind: 'local',
      url: normalizeBaseUrl(cfg.baseUrl) || DEFAULT_BASE,
      hosts: [],
      upload: { accept: ['image', 'document'] }, // 이미지(비전 모델일 때) + 글 파일은 본문에 끼워 보낸다 (v0.36.0, 그 밖의 문서는 뺀다)
      textOnlyDocs: true,
    };
  }

  /** 지금 쓰는 로컬 패널 항목 전부 (설정의 패널 수만큼) */
  const localServices = (cfg = {}) => Array.from({ length: normalizePanels(cfg.panels) }, (_, i) => localService(cfg, i));

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

  /** 그 로컬 패널이 쓸 모델: 첫 패널은 model, 둘째 · 셋째는 extraModels[0] · [1] (비었으면 '') */
  function modelOf(cfg, id) {
    const i = panelIndex(id);
    if (i < 0) return ''; // 로컬 패널이 아님
    if (i === 0) return cleanModel(cfg && cfg.model);
    return cleanModel(cfg && Array.isArray(cfg.extraModels) ? cfg.extraModels[i - 1] : '');
  }

  /** 설정 한 덩어리 검사 (패널 수 · 모델들까지). 둘째 · 셋째 모델은 [이름, 이름]으로 항상 두 칸 */
  function normalizeLocalPrefs(v) {
    const o = v && typeof v === 'object' ? v : {};
    const extra = Array.isArray(o.extraModels) ? o.extraModels : [];
    return {
      enabled: o.enabled === true,
      baseUrl: normalizeBaseUrl(o.baseUrl) || DEFAULT_BASE,
      model: cleanModel(o.model),
      contextTokens: normalizeContext(o.contextTokens),
      panels: normalizePanels(o.panels),
      extraModels: [cleanModel(extra[0]), cleanModel(extra[1])],
      embedModel: cleanModel(o.embedModel), // 기록 의미 검색용 임베딩 모델 (v0.36.0, 비면 끔)
    };
  }

  const MAX_ATTACH_CHARS = 200000; // 글 파일 하나에서 가져오는 최대 글자 수 (컨텍스트 한도를 몰라도)
  const ATTACH_SHARE = 0.8; // 컨텍스트 한도의 이만큼까지만 질문 + 첨부에 쓴다 (나머지는 답 · 이어지는 대화 몫)

  /**
   * 글 파일을 질문 글에 끼운다 (v0.36.0). 로컬 LLM은 문서 업로드가 없어서 글로 읽을 수 있는 파일(send-plan isTextLike)만 본문으로 보낸다.
   * 컨텍스트 한도(contextTokens)가 있으면 질문 + 첨부가 한도의 80%를 넘지 않게 뒤쪽 파일부터 · 파일 안에서는 뒷부분을 잘라 내고,
   * 잘렸다는 말을 글에 남긴다 (사용자 · 모델이 같이 안다).
   * opts: { sp: shared/send-plan, decode(file) → 글 | null, contextTokens }
   * → { attach: API에만 붙일 글 ('' 가능), files: [{ name, chars, cut }], skipped: [이름 (글로 읽을 수 없는 파일)] }
   */
  function embedTextFiles(text, files, { sp, decode, contextTokens } = {}) {
    const files_ = [];
    const skipped = [];
    const parts = [];
    const limit = Number(contextTokens) > 0 ? Math.floor(Number(contextTokens) * ATTACH_SHARE) : 0;
    let room = limit ? Math.max(0, limit - sp.estimateTokens(String(text || ''))) : Infinity;
    for (const f of Array.isArray(files) ? files : []) {
      if (!f || /^image\//.test(f.type || '')) continue; // 이미지는 따로 (image_url)
      let body = sp.isTextLike(f) ? decode(f) : null;
      if (typeof body !== 'string' || body.includes('\u0000')) {
        skipped.push(String(f.name || ''));
        continue;
      }
      let cut = false;
      if (body.length > MAX_ATTACH_CHARS) {
        body = body.slice(0, MAX_ATTACH_CHARS);
        cut = true;
      }
      if (limit) {
        const need = sp.estimateTokens(body);
        if (need > room) {
          body = sp.cutToTokens(body, room);
          cut = true;
        }
        room = Math.max(0, room - sp.estimateTokens(body));
      }
      const name = String(f.name || '').replace(/[\r\n`]+/g, ' ').slice(0, 120) || 'file';
      parts.push(`${t('local.attachHead', { name })}\n\`\`\`\n${body}\n\`\`\`${cut ? `\n${t('local.attachCut', { name })}` : ''}`);
      files_.push({ name, chars: body.length, cut });
    }
    return { attach: parts.length ? `\n\n${parts.join('\n\n')}` : '', files: files_, skipped };
  }

  /** 서버의 모델 목록 → [이름] (OpenAI 호환 /v1/models) */
  async function listModels(fetchFn, baseUrl, { signal } = {}) {
    const base = normalizeBaseUrl(baseUrl);
    if (!base) throw new Error(t('main.local.onlyThisPc'));
    const res = await fetchFn(`${base}/v1/models`, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(t('main.local.modelsFailed', { status: res.status }));
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
      messages: messages.map((m) => ({ role: m.role, text: m.text, images: m.images ? m.images.length : 0, ...(m.attach ? { files: m.attach.files } : {}) })),
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
    async function send(text, images = [], extra = {}) {
      if (streaming) return { ok: false, error: t('main.local.busy') };
      const cfg = getConfig() || {};
      const base = normalizeBaseUrl(cfg.baseUrl);
      model = cleanModel(cfg.model);
      if (!base) return { ok: false, error: t('main.local.badBase') };
      if (!model) return { ok: false, error: t('main.local.noModel') };
      // 글 파일은 API로 보내는 글에만 붙이고 패널에는 파일 이름만 보인다 (v0.36.0)
      const attach = extra && extra.attach && Array.isArray(extra.files) && extra.files.length ? { body: String(extra.attach), files: extra.files.slice(0, 20) } : undefined;
      const user = { role: 'user', text: String(text || ''), images: images.length ? images : undefined, ...(attach ? { attach } : {}) };
      const history = [...messages, user].slice(-MAX_TURNS).map((m) => ({ role: m.role, content: m.role === 'user' ? toContent(m.text + (m.attach ? m.attach.body : ''), m.images || []) : m.text }));
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
        error = t('main.local.connectFailed', { error: err.message });
        changed();
        return { ok: false, error: t('main.local.connectHint', { error }) };
      }
      if (!res.ok) {
        let why = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.error) why += ` — ${typeof j.error === 'string' ? j.error : j.error.message || ''}`;
        } catch {}
        error = why;
        changed();
        return { ok: false, error: t('main.local.rejected', { why }) };
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
        if (err.name !== 'AbortError') error = t('main.local.streamCut', { error: err.message });
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

  /** 컨텍스트 한도 설정 값 검사 (고를 수 있는 값만, 아니면 기본 8k) */
  const normalizeContext = (v) => (CONTEXT_CHOICES.includes(Number(v)) ? Number(v) : DEFAULT_CONTEXT);

  /**
   * 패널 없이 한 번 묻기 (v0.29.0): 종합 · 분석 · 토론 판정 · 스킬 압축을 로컬 LLM에 맡길 때.
   * 패널의 대화(createLocalChat)와 따로, 이 질문 하나만 담은 임시 대화로 보낸다 → 보이는 패널의 대화가 섞이지 않는다.
   * 스트리밍 없이 한 번에 받는다. → { ok: true, text } | { ok: false, error }
   */
  async function askOnce({ fetchFn, getConfig, text, timeoutMs = ASK_TIMEOUT_MS, signal } = {}) {
    const cfg = (getConfig && getConfig()) || {};
    const base = normalizeBaseUrl(cfg.baseUrl);
    const model = cleanModel(cfg.model);
    if (!base) return { ok: false, error: t('main.local.badBase') };
    if (!model) return { ok: false, error: t('main.local.noModel') };
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: t('main.nothingToSend') };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    signal?.addEventListener?.('abort', () => ctrl.abort());
    try {
      const res = await fetchFn(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: text }], stream: false }),
        signal: ctrl.signal,
      });
      if (!res.ok) return { ok: false, error: t('main.local.rejected', { why: `HTTP ${res.status}` }) };
      const j = await res.json();
      const answer = String(j?.choices?.[0]?.message?.content ?? j?.message?.content ?? '');
      return answer.trim() ? { ok: true, text: answer } : { ok: false, error: t('main.local.emptyAnswer') };
    } catch (err) {
      return { ok: false, error: err.name === 'AbortError' ? t('main.local.timeout') : t('main.local.connectFailedLocal', { error: err.message }) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 첨부 파일(이미지) → data URL. file: { type, data(ArrayBuffer · Uint8Array) } */
  function imageDataUrl(file, toBase64) {
    if (!file || !/^image\//.test(file.type || '')) return null;
    return `data:${file.type};base64,${toBase64(file.data)}`;
  }

  return {
    embedTextFiles, LOCAL_ID, LOCAL_IDS, MAX_PANELS, isLocalId, panelIndex, normalizePanels, modelOf, normalizeLocalPrefs, localServices,
    DEFAULT_BASE, LOCAL_HOSTS, CONTEXT_CHOICES, DEFAULT_CONTEXT,
    localService, normalizeBaseUrl, cleanModel, normalizeContext, listModels, toContent, parseSSE, createLocalChat, askOnce, imageDataUrl,
  };
});
