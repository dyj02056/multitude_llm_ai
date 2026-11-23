// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/renderer/dev-capture.js)
'use strict';

// 화면 캡처 · AI 확인 · 적용 전/후 비교 (v0.45.0) — dev-run.js 다음에 읽힌다. Windows 앱 전용(host.preview.capture), 확장에서는 숨긴다.
//   - 사이트 화면 캡처: 사이드바 [화면 캡처] 또는 미리보기 창 도구 줄의 [화면 캡처]. 캡처는 이 실행 동안 본체 메모리에만 (최근 12장).
//   - 캡처 창: 그림 목록(두 장까지 고름) · 크게 보기(두 장이면 나란히) · PNG로 저장 · 지우기
//     · "AI에게 보내 확인받기": 받을 AI(그림을 받는 패널만) · 보낼 글(지금 로드맵 작업의 완료 조건을 넣어 채움, 고칠 수 있음)
//     → [보내기]를 눌러야 보낸다. 이 창 자체가 보내기 전 확인이다 (그림 · 글 · 받는 곳을 다 보여 줌).
//   - 적용 전/후 비교: 미리보기 창(변경 보기)의 [화면 비교] → 본체가 수정안을 잠깐 써 보고 두 화면을 캡처한 뒤 되돌린다 → 캡처 창에 두 장을 골라 연다.
//
// [쉽게 말하면] 띄운 앱 화면을 사진으로 찍어, 확인을 거쳐 AI에게 "이 화면이 완료 조건대로 보이니?"라고 물어보는 부분입니다.

(() => {
  const RM = MLA.roadmap;
  const WHO_KEY = 'mla-cap-who';
  const cap = { list: [], sel: [], data: new Map(), dirty: false, compare: false, busy: false };
  let modal = null; // { dialog, pending }
  let pvState = { open: false };

  const can = () => !!host.preview?.capture;
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const time = (at) => new Date(at).toLocaleTimeString();
  const tagText = (c) => (c.tag === 'before' ? t('dev.cap.before') : c.tag === 'after' ? t('dev.cap.after') : time(c.at));

  async function refresh() {
    if (!can()) return render();
    try {
      cap.list = (await host.preview.captures()) || [];
    } catch {
      cap.list = [];
    }
    cap.sel = cap.sel.filter((id) => cap.list.some((c) => c.id === id));
    render();
    if (modal) renderModal();
  }

  // ---------- 사이드바 ----------
  function render() {
    const box = $('#dhCap');
    if (!box) return;
    box.hidden = !can() || (!pvState.open && !cap.list.length);
    if (box.hidden) return;
    $('#dhCapShot').disabled = !pvState.open || cap.busy;
    const open = $('#dhCapOpen');
    open.textContent = t('dev.cap.openN', { n: cap.list.length });
    open.title = t('dev.cap.openTitle');
    open.disabled = !cap.list.length;
  }

  async function shoot() {
    if (!can() || cap.busy) return;
    cap.busy = true;
    render();
    let r;
    try {
      r = await host.preview.capture();
    } catch (err) {
      r = { ok: false, error: err.message };
    } finally {
      cap.busy = false;
    }
    await refresh();
    if (r?.ok) openGallery({ select: [r.capture.id] });
    else if (r?.error) $('#dhCapNote').textContent = r.error;
  }

  // ---------- 캡처 창 ----------
  async function dataOf(id) {
    if (cap.data.has(id)) return cap.data.get(id);
    const r = await host.preview.captureData(id).catch(() => null);
    const url = r?.ok ? r.dataUrl : '';
    if (url) cap.data.set(id, url);
    return url;
  }

  /** 받을 AI: 지금 연 패널 중 그림을 받는 서비스 */
  function targets() {
    const sel = new Set(state?.selected || []);
    return (state?.services || []).filter((s) => sel.has(s.id) && Array.isArray(s.accept) && s.accept.includes('image'));
  }

  /** 보낼 글: 비교면 비교 글, 아니면 확인 글. 지금 로드맵 작업의 완료 조건을 넣는다 */
  function defaultText() {
    const chosen = cap.sel.map((id) => cap.list.find((c) => c.id === id)).filter(Boolean);
    const url = chosen[0]?.url || pvState.url || '';
    let accept = '';
    try {
      const rm = MLA.roadmapUI?.get?.();
      const tk = rm ? RM.currentTask(rm, {}) : null;
      const lines = String(tk?.accept || '').split(/\n+/).map((x) => x.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean);
      if (lines.length) accept = t('prompt.cap.accept', { id: tk.id, title: tk.title, lines: lines.map((l) => `- ${l}`).join('\n') });
    } catch {}
    const pair = chosen.length === 2;
    return t(pair ? 'prompt.cap.compare' : 'prompt.cap.ask', { url, accept });
  }

  function select(id) {
    if (cap.sel.includes(id)) cap.sel = cap.sel.filter((x) => x !== id);
    else cap.sel = [...cap.sel, id].slice(-2); // 두 장까지 (나란히 보기 · 함께 보내기)
    if (!cap.dirty) $('#capText').value = defaultText();
    renderModal();
  }

  async function renderModal() {
    if (!modal) return;
    $('#capSub').textContent = t('dev.cap.sub', { n: cap.list.length });
    // 목록 (최근 것부터)
    const items = [...cap.list].reverse().map((c) => {
      const li = el('li', `cap-item${cap.sel.includes(c.id) ? ' on' : ''}${c.tag ? ` tag-${c.tag}` : ''}`);
      const b = el('button', 'cap-thumb');
      b.setAttribute('aria-pressed', String(cap.sel.includes(c.id)));
      b.title = `${c.title || c.url} · ${c.w}×${c.h}`;
      const img = el('img');
      img.alt = tagText(c);
      dataOf(c.id).then((u) => (img.src = u));
      b.append(img, el('span', 'cap-tag', tagText(c)));
      b.addEventListener('click', () => select(c.id));
      li.append(b);
      return li;
    });
    $('#capList').replaceChildren(...(items.length ? items : [el('li', 'dh-sub', t('dev.cap.none'))]));
    // 크게 보기
    const chosen = cap.sel.map((id) => cap.list.find((c) => c.id === id)).filter(Boolean);
    const view = $('#capView');
    view.classList.toggle('pair', chosen.length === 2);
    view.replaceChildren(
      ...(chosen.length
        ? chosen.map((c) => {
            const fig = el('figure', `cap-fig${c.tag ? ` tag-${c.tag}` : ''}`);
            const img = el('img');
            img.alt = tagText(c);
            dataOf(c.id).then((u) => (img.src = u));
            fig.append(img, el('figcaption', '', `${tagText(c)} · ${c.url}`));
            return fig;
          })
        : [el('p', 'dh-sub', t('dev.cap.pick'))]),
    );
    if (cap.compare && chosen.length === 2) view.prepend(el('p', 'cap-note', t('dev.cap.compareNote')));
    // 받을 AI
    const who = $('#capWho');
    const list = targets();
    const keep = who.value || localStorageGet(WHO_KEY);
    who.replaceChildren(...list.map((s) => Object.assign(el('option', '', s.name), { value: s.id })));
    who.value = list.some((s) => s.id === keep) ? keep : list[0]?.id || '';
    $('#capNoWho').hidden = !!list.length;
    const send = $('#capSend');
    send.textContent = chosen.length === 2 ? t('dev.cap.sendPair') : t('dev.cap.send');
    send.disabled = !chosen.length || !list.length || cap.busy;
    $('#capSave').disabled = chosen.length !== 1;
    $('#capRemove').disabled = !chosen.length;
  }

  function localStorageGet(k) {
    try {
      return localStorage.getItem(k) || '';
    } catch {
      return '';
    }
  }

  /** data:image/png;base64,… → ArrayBuffer */
  function bytesOf(dataUrl) {
    const b64 = String(dataUrl).split(',')[1] || '';
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  async function send() {
    const chosen = cap.sel.map((id) => cap.list.find((c) => c.id === id)).filter(Boolean);
    const who = $('#capWho').value;
    const text = $('#capText').value.trim();
    if (!chosen.length || !who || !text || cap.busy) return;
    cap.busy = true;
    renderModal();
    $('#capStatus').textContent = t('dev.cap.sending');
    try {
      try {
        localStorage.setItem(WHO_KEY, who);
      } catch {}
      const files = [];
      for (const [i, c] of chosen.entries()) {
        const url = await dataOf(c.id);
        files.push({ name: `screen-${i + 1}${c.tag ? `-${c.tag}` : ''}.png`, type: 'image/png', lastModified: c.at, data: bytesOf(url) });
      }
      const results = await host.sendPrompt(text, [who], files, { question: text.split('\n')[0].slice(0, 200) });
      const ok = results?.[0]?.ok;
      const name = (state?.services || []).find((s) => s.id === who)?.name || who;
      if (ok) {
        closeGallery();
        $('#sendHint') && ($('#sendHint').textContent = t('dev.cap.sent', { name }));
      } else $('#capStatus').textContent = t('dev.cap.sendFail', { name, msg: results?.[0]?.error || '' });
    } catch (err) {
      $('#capStatus').textContent = t('dev.cap.sendFail', { name: who, msg: err.message });
    } finally {
      cap.busy = false;
      renderModal();
    }
  }

  async function openGallery({ select: ids = [], compare = false } = {}) {
    if (!can()) return;
    await refresh();
    cap.sel = ids.filter((id) => cap.list.some((c) => c.id === id)).slice(-2);
    if (!cap.sel.length && cap.list.length) cap.sel = [cap.list[cap.list.length - 1].id];
    cap.compare = compare;
    cap.dirty = false;
    if (!modal) {
      const dialog = state?.chatView === 'panels';
      modal = { dialog, pending: dialog };
      if (dialog) host.setView('dialog');
      $('#capModal').hidden = false;
    }
    $('#capText').value = defaultText();
    $('#capStatus').textContent = '';
    await renderModal();
    $('#capClose').focus();
  }
  function closeGallery() {
    if (!modal) return;
    const { dialog } = modal;
    modal = null;
    $('#capModal').hidden = true;
    // 변경 보기 창 위에 열었으면 그 창은 그대로 (dialog 화면 유지)
    if (dialog && state?.chatView === 'dialog' && $('#patchModal')?.hidden !== false) host.setView('panels');
  }

  // ---------- 적용 전/후 비교 (변경 보기 창에서) ----------
  /** changes: [{ path, after }] → 본체가 잠깐 써 보고 두 장을 캡처 → 캡처 창. → 결과 글 (상태 줄용) */
  async function compare(changes) {
    if (!host.preview?.compare) return '';
    if (!pvState.open) return t('dev.cap.needPreview');
    const r = await host.preview.compare(changes).catch((err) => ({ ok: false, error: err.message }));
    if (!r?.ok) return r?.cancelled ? '' : t('dev.cap.compareFail', { msg: r?.error || '' });
    await openGallery({ select: [r.before.id, r.after.id], compare: true });
    return r.restoreFailed ? t('dev.cap.restoreFailed', { list: r.restoreFailed.join(', ') }) : t('dev.cap.compared');
  }
  const canCompare = () => !!host.preview?.compare && !!pvState.open;

  // 패널 화면으로 돌아가면 창을 닫는다 (다른 창과 같은 규칙)
  const prevState = window.onDevState;
  window.onDevState = () => {
    prevState?.();
    if (!modal) return;
    if (modal.pending) {
      if (state.chatView === 'dialog') modal.pending = false;
      return;
    }
    if (modal.dialog && state.chatView !== 'dialog') {
      modal.dialog = false;
      closeGallery();
    }
  };
  // 미리보기 상태(열림 · 캡처 수)가 바뀌면
  const prevPv = window.onPreviewState;
  window.onPreviewState = (pv) => {
    prevPv?.(pv);
    const before = pvState.captures || 0;
    pvState = pv || { open: false };
    if ((pvState.captures || 0) !== before || (!pvState.open && cap.list.length)) refresh();
    else render();
  };

  $('#dhCapShot').addEventListener('click', () => shoot());
  $('#dhCapOpen').addEventListener('click', () => openGallery());
  $('#capClose').addEventListener('click', () => closeGallery());
  $('#capSend').addEventListener('click', () => send());
  $('#capText').addEventListener('input', () => (cap.dirty = true));
  $('#capSave').addEventListener('click', async () => {
    const r = await host.preview.captureSave(cap.sel[0]).catch(() => null);
    if (r?.ok) $('#capStatus').textContent = t('dev.cap.saved', { path: r.path });
  });
  $('#capRemove').addEventListener('click', async () => {
    for (const id of cap.sel) {
      await host.preview.captureRemove(id).catch(() => {});
      cap.data.delete(id);
    }
    cap.sel = [];
    await refresh();
  });
  $('#capModal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeGallery();
    }
  });

  MLA.devCapture = { cap, refresh, render, shoot, openGallery, closeGallery, compare, canCompare, defaultText };
})();
