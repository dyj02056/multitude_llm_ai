// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/renderer/onboarding.js)
'use strict';

// 첫 사용 안내 (v0.31.0) — Windows 앱과 크롬 확장이 똑같이 씀. settings-transfer-ui.js 다음, a11y.js 앞에 읽힌다.
// 걸음 목록과 "보여 줄지" 규칙은 shared/onboarding.js, 글은 i18n-*-ui.js의 ui.onboard.*.
// Windows 앱은 패널 웹페이지가 화면 맨 위에 얹혀 있어 'dialog' 화면으로 바꿔 패널을 치운 뒤 띄운다 (보내기 전 미리보기와 같음).
// 포커스를 창 안에 가두고 닫을 때 돌려주는 일은 a11y.js가 한다 (.modal 공통).
//
// [쉽게 말하면] 앱을 처음 켠 사람에게 한 번만 뜨는 네 걸음 안내 창입니다. [건너뛰기]나 Esc로 언제든 닫을 수 있고,
// 닫으면 다시 뜨지 않습니다. 설정(?) 화면의 [처음 사용 안내 다시 보기]로 다시 볼 수 있습니다.

(() => {
  const OB = MLA.onboarding;
  let open = null; // { index, dialog(패널 화면에서 띄웠는지), pending('dialog' 화면으로 바뀌기를 기다리는 중) }
  let shown = false; // 이번에 켠 뒤로 저절로 띄운 적이 있는지 (설정 저장이 늦어도 두 번 뜨지 않게)

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  function render() {
    const step = OB.STEPS[open.index];
    const total = OB.STEPS.length;
    const last = open.index === total - 1;
    $('#onboardSub').textContent = t('ui.onboard.progress', { i: open.index + 1, n: total });
    const keys = el('p', 'onboard-keys');
    keys.append(el('span', 'muted-label', t('ui.onboard.keys')), ...step.keys.map((k) => el('kbd', '', k)));
    $('#onboardBody').replaceChildren(
      el('span', 'feature-step', String(open.index + 1).padStart(2, '0')),
      el('h3', '', t(`ui.onboard.${step.id}.title`)),
      el('p', 'onboard-text', t(`ui.onboard.${step.id}.body`)),
      keys,
    );
    $('#onboardPrev').disabled = open.index === 0;
    $('#onboardNext').textContent = last ? t('ui.onboard.done') : t('ui.onboard.next');
  }

  function close() {
    if (!open) return;
    const { dialog } = open;
    open = null;
    $('#onboardModal').hidden = true;
    if (state?.onboarded === false) host.setSettings({ onboarded: true }); // 끝까지 봤든 건너뛰었든 다시 띄우지 않는다
    if (dialog && state?.chatView === 'dialog') host.setView('panels');
  }

  function show() {
    if (open) return;
    const dialog = state?.mode === 'chat' && state?.chatView === 'panels';
    open = { index: 0, dialog, pending: dialog };
    if (dialog) host.setView('dialog');
    render();
    $('#onboardModal').hidden = false;
    $('#onboardNext').focus();
  }

  function move(dir) {
    if (!open) return;
    if (dir > 0 && open.index === OB.STEPS.length - 1) return close();
    open.index = OB.stepAt(open.index, dir);
    render();
  }

  /** 화면 상태가 올 때마다 (renderer-compose.js): 처음이면 띄우고, 띄운 화면을 떠났으면(Esc 단축키 · 툴바) 닫는다 */
  window.onOnboardState = () => {
    if (!open) {
      // 다른 창(미리보기 · 토론 · 자가진단 등)이 떠 있으면 끼어들지 않는다
      if (OB.shouldShow(state, shown) && !document.querySelector('.modal:not([hidden])')) {
        shown = true;
        show();
      }
      return;
    }
    if (!open.dialog) return;
    if (open.pending) {
      if (state.chatView === 'dialog') open.pending = false;
      return;
    }
    if (state.chatView !== 'dialog') {
      open.dialog = false; // 이미 다른 화면이라 패널로 되돌리지 않는다
      close();
    }
  };

  /** 언어를 바꾸면 열려 있는 안내도 새 언어로 */
  document.addEventListener('mla:lang', () => open && render());

  $('#onboardNext').addEventListener('click', () => move(1));
  $('#onboardPrev').addEventListener('click', () => move(-1));
  $('#onboardSkip').addEventListener('click', close);
  $('#onboardAgain').addEventListener('click', show);
  $('#onboardModal').addEventListener('click', (e) => e.target === $('#onboardModal') && close());
  $('#onboardModal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowRight') move(1);
    else if (e.key === 'ArrowLeft') move(-1);
  });
})();
