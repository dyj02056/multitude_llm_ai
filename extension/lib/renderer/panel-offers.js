// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/renderer/panel-offers.js)
'use strict';

// 패널 아래 제안 바 (v0.26.0) — Windows 앱과 크롬 확장이 똑같이 씀. send-preview.js 다음에 읽힌다.
//   → 넘기기: 머리줄 → 를 누르면 "이 답변을 [검토 ▾] → [ChatGPT] [Claude]" — 고른 패널에 이 답변을 보내 검토 · 반박 · 이어서 쓰기를 부탁
//   다시 보내기: 보내기에 실패했거나(자동으로 한 번 다시 보낸 뒤에도) 답이 늦을 때(시간 초과 · 답변 없음) [다시 보내기]
//     시간 초과는 사이트가 아직 답하는 중일 수 있어 저절로 다시 보내지 않는다 — 누를 때만
//   다른 AI로: 사용 한도에 걸린 것 같으면 "다른 AI로 보낼까요?" + 한도에 걸리지 않은 열린 패널 (응답 통계에서 빠른 순, 첫 번째 추천)
//     저절로 바꿔 보내지 않는다 — 누른 패널에만 같은 질문을 보내고 기록의 이어 묻기에 남긴다
// 바는 프로젝트 변경 바와 같은 자리(패널 아래 34px)를 쓴다 (renderer.js syncPanelBar).
//
// [쉽게 말하면] 패널 아래에 잠깐 뜨는 "이렇게 해 볼까요?" 줄입니다. 무엇을 할지는 언제나 사용자가 누를 때 정해집니다.

(() => {
  const RT = MLA.retry;
  const CH = MLA.chain;
  const offers = new Map(); // id -> 'handoff' | 'resend' | 'fallback'
  const dismissedLimit = new Map(); // id -> 닫은 한도 문구 (같은 문구면 다시 띄우지 않음)
  let lastIntent = 'review';

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const nameOf = (id) => state?.services.find((s) => s.id === id)?.name || id;
  const openIds = () => (state?.rects || []).map((r) => r.id);

  function barOf(id) {
    const p = panels.get(id);
    if (!p) return null;
    if (!p.offerBar) {
      p.offerBar = el('div', 'change-bar offer-bar');
      p.offerBar.hidden = true;
      p.el.append(p.offerBar);
    }
    return p;
  }

  function hide(id, only) {
    const p = panels.get(id);
    if (!p?.offerBar || (only && !only.includes(offers.get(id)))) return;
    offers.delete(id);
    p.offerBar.hidden = true;
    p.offerBar.replaceChildren();
    syncPanelBar(id);
  }

  function show(id, kind, children, cls = '') {
    const p = barOf(id);
    if (!p) return;
    offers.set(id, kind);
    p.offerBar.className = `change-bar offer-bar ${cls}`.trim();
    const close = button('✕', t('offer.close'), () => {
      if (kind === 'fallback') dismissedLimit.set(id, limitKey(id));
      hide(id);
    });
    close.className = 'cb-close';
    p.offerBar.replaceChildren(...children, close);
    p.offerBar.hidden = false;
    syncPanelBar(id);
  }

  const result = (id, r, okText) => {
    const p = panels.get(id);
    if (p) flash(p.status, r?.ok ? okText : r?.error || t('offer.failed'));
  };

  // ---------- → 넘기기 ----------
  window.onHandoffClick = (id) => {
    if (offers.get(id) === 'handoff') return hide(id);
    const others = openIds().filter((x) => x !== id);
    if (!others.length) return flash(panels.get(id).status, t('handoff.noTarget'));
    const intent = el('select', 'offer-intent');
    intent.setAttribute('aria-label', t('handoff.intentLabel'));
    for (const k of CH.INTENTS) intent.append(Object.assign(el('option', '', t(`handoff.intent.${k}`)), { value: k, title: t(`handoff.intentTitle.${k}`) }));
    intent.value = lastIntent;
    intent.addEventListener('change', () => (lastIntent = intent.value));
    const targets = others.map((to) => {
      const b = button(nameOf(to), t('handoff.toTitle', { to: nameOf(to) }), async () => {
        hide(id);
        const r = await host.handoff(id, to, intent.value);
        result(to, r, t('handoff.sent', { from: nameOf(id), what: t(`handoff.intent.${intent.value}`) }));
        if (!r?.ok) result(id, r);
      });
      b.className = 'offer-target';
      b.style.setProperty('--svc', state.services.find((s) => s.id === to)?.color || 'var(--border)');
      return b;
    });
    show(id, 'handoff', [el('span', 'cb-icon', '→'), el('span', 'cb-text', t('handoff.barLabel')), intent, el('span', 'muted-label', '→'), ...targets], 'run');
  };

  // ---------- 다시 보내기 ----------
  function offerResend(id, why) {
    if (offers.get(id) === 'fallback' || offers.get(id) === 'handoff') return; // 사용자가 연 넘기기 · 한도 제안을 덮지 않는다
    const again = button(t('retry.resend'), t('retry.resendTitle'), async () => {
      hide(id);
      const r = await host.resend(id);
      if (!r?.ok) result(id, r);
    });
    again.className = 'cb-continue';
    show(id, 'resend', [el('span', 'cb-icon', '↻'), el('span', 'cb-text', t(`retry.why.${why}`)), again]);
  }

  // ---------- 다른 AI로 (사용 한도) ----------
  const limitKey = (id) => String(diagById[id]?.limit?.text || diagById[id]?.limit || '');

  async function offerFallback(id) {
    const limited = openIds().filter((x) => diagById[x]?.limit);
    const stats = await host.history.stats().catch(() => null);
    const ids = RT.pickFallback({ fromId: id, openIds: openIds(), limitedIds: limited, rows: stats?.rows || [] });
    if (!ids.length || !diagById[id]?.limit) return;
    const targets = ids.map((to, i) => {
      const b = button(i === 0 ? t('retry.fastestLabel', { name: nameOf(to) }) : nameOf(to), t('retry.elsewhereTitle', { to: nameOf(to) }), async () => {
        hide(id);
        const r = await host.sendElsewhere(id, to);
        result(to, r, t('retry.elsewhereSent', { from: nameOf(id) }));
        if (!r?.ok) result(id, r);
      });
      b.className = i === 0 ? 'cb-apply offer-target' : 'offer-target';
      return b;
    });
    show(id, 'fallback', [el('span', 'cb-icon', '⏳'), el('span', 'cb-text', t('retry.limitAsk')), ...targets]);
  }

  host.on('panel:status', ({ id, diag, send, answer }) => {
    if (diag) {
      // 사용 한도 표시가 생기면 제안, 없어지면 내린다 (같은 문구를 닫았으면 다시 띄우지 않음)
      if (!diag.limit) {
        dismissedLimit.delete(id);
        return hide(id, ['fallback']);
      }
      if (offers.get(id) !== 'fallback' && dismissedLimit.get(id) !== limitKey(id)) offerFallback(id);
      return;
    }
    if (!panels.has(id)) return;
    if (answer === 'clear') return hide(id);
    if (send === 'sending' || answer === 'answering' || answer === 'done') hide(id, ['resend']);
    if (send === 'error') offerResend(id, 'error');
    if (answer === 'timeout' || answer === 'no-answer') offerResend(id, answer);
  });
})();
