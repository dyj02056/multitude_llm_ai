'use strict';

// 서비스 패널에 질문을 넣고 보낸다.
// 글자 입력은 webContents.insertText(브라우저의 실제 입력 경로)를 써서
// textarea · ProseMirror(ChatGPT) · Quill(Gemini) 어느 편집기든 똑같이 동작하게 한다.

const { dev } = require('./dev');
const { pageFocusInput, pageClickSend } = require('../shared/page');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 페이지 함수(shared/page.js)는 toString()으로 페이지 안에 주입해 실행한다.
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
  const dry = dev.drySend; // 개발용: 입력과 버튼 찾기까지만 하고 실제로 보내지 않는다
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
    const el = c.input
      .flatMap((s) => [...document.querySelectorAll(s)])
      .find((e) => e.offsetWidth || e.offsetHeight || e.getClientRects().length);
    if (el) el.focus();
  }, cfg);
  pressKey(wc, svc.submitKey || 'Enter');
  return { ok: true, via: 'key' };
}

module.exports = { sendPrompt };
