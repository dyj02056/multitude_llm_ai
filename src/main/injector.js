'use strict';

// 서비스 패널에 질문을 넣고 보낸다.
// 글자 입력은 webContents.insertText(브라우저의 실제 입력 경로)를 써서
// textarea · ProseMirror(ChatGPT) · Quill(Gemini) 어느 편집기든 똑같이 동작하게 한다.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 아래 두 함수는 toString()으로 페이지 안에 주입되어 실행된다. 바깥 변수를 쓰면 안 된다.
function pageFocusInput(cfg) {
  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const input = cfg.input.map((s) => document.querySelector(s)).find(visible);
  if (!input) return { ok: false, error: '입력창을 찾지 못했습니다' };
  input.focus();
  // 이미 적혀 있던 내용은 지우고 새로 쓴다.
  document.execCommand('selectAll');
  document.execCommand('delete');
  return { ok: document.activeElement === input || input.contains(document.activeElement) };
}

function pageClickSend(cfg) {
  const usable = (el) =>
    !!el &&
    !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
    !el.disabled &&
    el.getAttribute('aria-disabled') !== 'true' &&
    // Tailwind의 "disabled:opacity-50" 같은 클래스는 상태가 아니라서 걸러내지 않는다.
    !/(^|\s)([\w-]*--)?disabled(\s|$)/.test(String(el.className));
  let btn = cfg.send.map((s) => document.querySelector(s)).find(usable);
  if (!btn && cfg.sendText) {
    const re = new RegExp(cfg.sendText, 'i');
    btn = [...document.querySelectorAll('button,[role="button"]')].find(
      (el) => usable(el) && re.test(String(el.innerText || el.getAttribute('aria-label') || '').trim()),
    );
  }
  if (!btn) return false;
  if (!cfg.dry) btn.click();
  return true;
}

const run = (wc, fn, arg) => wc.executeJavaScript(`(${fn.toString()})(${JSON.stringify(arg)})`, true);

function pressKey(wc, combo) {
  const parts = combo.split('+');
  const keyCode = parts.pop();
  const modifiers = parts.map((m) => m.toLowerCase());
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

/** 질문을 보낸다. 결과: { ok: true, via: 'button' | 'key' } 또는 { ok: false, error } */
async function sendPrompt(wc, svc, text) {
  // 개발용: MLA_DRY_SEND=1 이면 입력과 버튼 찾기까지만 하고 실제로 보내지는 않는다.
  const dry = !!process.env.MLA_DRY_SEND;
  const cfg = { input: svc.input || [], send: svc.send || [], sendText: svc.sendText || null, dry };

  const focus = await run(wc, pageFocusInput, cfg);
  if (!focus.ok) return { ok: false, error: focus.error || '입력창에 포커스를 줄 수 없습니다' };

  await wc.insertText(text);

  // 보내기 버튼은 글자가 들어간 뒤에야 나타나거나 활성화되는 경우가 많아 잠깐 기다리며 찾는다.
  for (let i = 0; i < 12; i++) {
    await sleep(250);
    if (await run(wc, pageClickSend, cfg)) return { ok: true, via: dry ? 'button (dry)' : 'button' };
  }
  if (dry) return { ok: true, via: 'key (dry)' };

  // 버튼을 못 찾으면 키보드로 보낸다. 입력창에 포커스를 다시 준 뒤 누른다.
  await run(wc, (c) => {
    const el = c.input.map((s) => document.querySelector(s)).find(Boolean);
    if (el) el.focus();
  }, cfg);
  pressKey(wc, svc.submitKey || 'Enter');
  return { ok: true, via: 'key' };
}

module.exports = { sendPrompt };
