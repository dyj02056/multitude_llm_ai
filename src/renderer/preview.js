'use strict';

// 미리보기 창의 도구 줄 (v0.44.0) — preview.html. window.pv(preview-preload.js)로 본체(main/preview.js)와 이야기한다.
//   위 줄: ← → ⟳ ⌂ · 지금 주소 · [브라우저로 ↗] · [개발자 도구]   아래 줄: 점검 판정(초록 · 노랑 · 빨강) · 콘솔 오류 N · 실패한 요청 N
//   배지를 누르면 자세히 칸이 펼쳐지고(사이트 화면이 그만큼 내려감) 오류 글 · 요청 주소를 보여 준다.
//
// [쉽게 말하면] 미리보기 창 맨 위의 주소 줄과 "이 화면에 오류가 있는지" 알려 주는 줄입니다.

(() => {
  const H = MLA.previewHealth;
  const { t } = MLA.i18n;
  MLA.i18n.setLang(window.pv?.lang || 'ko');
  MLA.i18n.apply(document);
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  let st = { open: false };
  let open = ''; // 펼친 자세히: 'errors' | 'failed' | ''

  function verdictText(v) {
    switch (v.key) {
      case 'loadError':
        return t('dev.pv.v.loadError', { msg: st.loadError || '' });
      case 'loading':
        return t('dev.pv.v.loading');
      case 'blank':
        return t('dev.pv.v.blank');
      case 'errors':
        return t('dev.pv.v.errors');
      case 'failed':
        return t('dev.pv.v.failed');
      case 'ok':
        return t('dev.pv.v.ok');
      default:
        return '';
    }
  }

  function render() {
    const v = H.verdict(st.open ? st : null);
    $('#pvUrl').textContent = st.url || st.home || '';
    $('#pvBack').disabled = !st.canBack;
    $('#pvFwd').disabled = !st.canForward;
    const vd = $('#pvVerdict');
    vd.textContent = verdictText(v);
    vd.className = `pv-verdict lvl-${v.level === 'wait' ? 'unknown' : v.level}`;
    document.body.dataset.level = v.level;
    const errN = (st.errors || []).reduce((n, x) => n + (x.count || 1), 0);
    const failN = (st.failed || []).reduce((n, x) => n + (x.count || 1), 0);
    $('#pvErrors').hidden = !errN;
    $('#pvErrors').textContent = t('dev.pv.errorsBadge', { n: errN });
    $('#pvErrors').setAttribute('aria-expanded', String(open === 'errors'));
    $('#pvFailed').hidden = !failN;
    $('#pvFailed').textContent = t('dev.pv.failedBadge', { n: failN });
    $('#pvFailed').setAttribute('aria-expanded', String(open === 'failed'));
    $('#pvNotice').textContent = st.notice || '';
    renderDetails();
  }

  function renderDetails() {
    const box = $('#pvDetails');
    const list = open === 'errors' ? st.errors || [] : open === 'failed' ? st.failed || [] : [];
    if (!open || !list.length) {
      if (!box.hidden) {
        box.hidden = true;
        window.pv?.details(false);
      }
      open = list.length ? open : '';
      return;
    }
    const rows = list.map((x) => {
      const li = el('li', '');
      if (open === 'errors') li.append(el('code', 'pv-msg', x.text || ''), el('span', 'pv-src', `${x.source || ''}${x.count > 1 ? ` ×${x.count}` : ''}`));
      else li.append(el('span', 'pv-status', String(x.status ?? '')), el('code', 'pv-msg', x.url || ''), el('span', 'pv-src', `${x.kind || ''}${x.count > 1 ? ` ×${x.count}` : ''}`));
      return li;
    });
    const ul = el('ul', 'pv-list');
    ul.append(...rows);
    box.replaceChildren(el('b', '', open === 'errors' ? t('dev.pv.errorsTitle') : t('dev.pv.failedTitle')), ul);
    if (box.hidden) {
      box.hidden = false;
      window.pv?.details(true);
    }
  }

  const toggle = (what) => {
    open = open === what ? '' : what;
    render();
  };

  $('#pvBack').addEventListener('click', () => window.pv.nav('back'));
  $('#pvFwd').addEventListener('click', () => window.pv.nav('forward'));
  $('#pvReload').addEventListener('click', () => window.pv.nav('reload'));
  $('#pvHome').addEventListener('click', () => window.pv.nav('home'));
  $('#pvExternal').addEventListener('click', () => window.pv.external());
  $('#pvDevtools').addEventListener('click', () => window.pv.nav('devtools'));
  $('#pvErrors').addEventListener('click', () => toggle('errors'));
  $('#pvFailed').addEventListener('click', () => toggle('failed'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F5' || (e.ctrlKey && e.key.toLowerCase() === 'r')) {
      e.preventDefault();
      window.pv.nav('reload');
    }
  });

  window.pv?.onState((s) => {
    st = s || { open: false };
    render();
  });
  window.pv?.state().then((s) => {
    st = s || st;
    render();
  });
  MLA.previewBar = { render, set: (s) => ((st = s), render()), toggle };
})();
