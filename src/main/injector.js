'use strict';

// 서비스 패널에 질문을 넣고 보낸다.
// 글자 입력은 webContents.insertText(브라우저의 실제 입력 경로)를 써서
// textarea · ProseMirror(ChatGPT) · Quill(Gemini) 어느 편집기든 똑같이 동작하게 한다.

const { dev } = require('./dev');
const { pageFocusInput, pageRefocusInput, pageClickSend } = require('../shared/page');
const { attachFiles, cleanupTemp } = require('./attach');

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

/**
 * 질문을 보낸다. files가 있으면 먼저 첨부하고, 첨부에 실패해도 글은 보낸다.
 * 첨부에 실패했는데 fallbackText가 있으면 text 대신 그 글을 보낸다 (프로젝트 파일 업로드의 내부 예비 경로).
 * 결과: { ok: true, via, attach?: { ok, via | error, fallback? } } 또는 { ok: false, error }
 */
async function sendPrompt(wc, svc, text, files = [], { fallbackText } = {}) {
  const dry = dev.drySend; // 개발용: 입력과 버튼 찾기까지만 하고 실제로 보내지 않는다
  const cfg = { input: svc.input || [], send: svc.send || [], sendText: svc.sendText || null, dry };

  const focus = await run(wc, pageFocusInput, cfg);
  if (!focus.ok) return { ok: false, error: focus.error || '입력창에 포커스를 줄 수 없습니다' };

  let attach;
  if (files.length) {
    attach = await attachFiles(wc, svc, files);
    await run(wc, pageRefocusInput, cfg); // 첨부하면서 포커스가 옮겨 갔을 수 있다
    if (!attach.ok && typeof fallbackText === 'string' && fallbackText) {
      text = fallbackText;
      attach = { ...attach, fallback: true };
    }
    if (!text && !attach.ok) return { ok: false, error: `첨부하지 못해 보낼 내용이 없습니다 (${attach.error})` };
  }

  if (text) await wc.insertText(text);
  const done = (via) => ({ ok: true, via, attach });

  // 보내기 버튼은 글자가 들어간 뒤에야 나타나거나 활성화되는 경우가 많아 잠깐 기다리며 찾는다 (3초).
  // 첨부가 있으면 버튼이 보이는데 꺼져 있는 동안(업로드 중)은 최대 60초까지 더 기다린다.
  for (let i = 0; i < 240; i++) {
    await sleep(250);
    const clicked = await run(wc, pageClickSend, cfg);
    if (clicked === true) return done(dry ? 'button (dry)' : 'button');
    if (i >= 11 && !(attach?.ok && clicked === null)) break;
  }
  if (dry) return done('key (dry)');

  // 버튼을 못 찾으면 키보드로 보낸다. 입력창에 포커스를 다시 준 뒤 누른다.
  await run(wc, pageRefocusInput, cfg);
  pressKey(wc, svc.submitKey || 'Enter');
  return done('key');
}

module.exports = { sendPrompt, cleanupTemp };
