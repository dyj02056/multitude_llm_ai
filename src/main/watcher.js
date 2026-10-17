'use strict';

// 답변이 다 써졌는지 지켜보고, 최신 답변 글을 꺼낸다.
// 완료 판단: 답변이 시작된 뒤 "중지" 버튼이 사라지고, 최신 답변 글이 일정 시간 바뀌지 않으면 완료.
// 중지 버튼을 못 찾는 서비스(DeepSeek 등)도 글이 멈춘 것만으로 완료를 판단할 수 있다.

const POLL_MS = 700;
const LATE_POLL_MS = 3000; // 시간 초과 뒤에는 천천히 계속 지켜본다
const STABLE_POLLS = 3; // 약 2초 동안 글이 그대로면 완료
const DEFAULT_START_MS = 90 * 1000; // 이 안에 답변이 시작되지 않으면 포기 (생각이 긴 모델도 중지 버튼은 바로 뜬다)
const DEFAULT_MAX_MS = 20 * 60 * 1000; // 이 시간이 지나면 "시간 초과"로 알린다
const LATE_EXTRA_MS = 60 * 60 * 1000; // 시간 초과 뒤에도 이만큼은 더 지켜보다가 끝나면 "완료"로 바꾼다

const { htmlToMarkdown } = require('./markdown');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 페이지 안에 주입되어 실행된다. 바깥 변수를 쓰면 안 된다.
// toMarkdown이 있으면 최신 답변을 Markdown으로도 바꿔 md에 담는다.
function pageSnapshot(cfg, toMarkdown) {
  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const stop = cfg.stop.some((s) => [...document.querySelectorAll(s)].some(visible));
  let list = [];
  // 메시지 블록에 역할 이름(USER/ASSISTANT)이 붙는 사이트(Groq 플레이그라운드)는 역할로 고른다.
  if (cfg.messages) {
    const re = new RegExp(cfg.messages.role, 'i');
    list = [...document.querySelectorAll(cfg.messages.container)]
      .filter((el) => visible(el) && re.test(el.innerText.trim()))
      .map((el) => el.querySelector(cfg.messages.content) || el);
  }
  for (const s of list.length ? [] : cfg.response) {
    const els = [...document.querySelectorAll(s)].filter(visible);
    if (els.length) {
      list = els;
      break;
    }
  }
  const last = list[list.length - 1];
  const text = last ? textWithoutButtons(last) : '';
  const md = toMarkdown && last ? toMarkdown(last) : undefined;
  return { stop, count: list.length, text, md };

  // 답변 안의 버튼 글자("예", "복사" 등)는 빼고 읽는다.
  // innerText는 화면에 붙어 있어야 줄바꿈이 살아서, 복제본을 화면 밖에 잠깐 붙였다가 뗀다.
  function textWithoutButtons(el) {
    if (!el.querySelector('button,[role="button"]')) return el.innerText.trim();
    const clone = el.cloneNode(true);
    clone.querySelectorAll('button,[role="button"]').forEach((b) => b.remove());
    Object.assign(clone.style, { position: 'fixed', left: '-100000px', top: '0', width: `${el.clientWidth}px` });
    document.body.appendChild(clone);
    const text = clone.innerText.trim();
    clone.remove();
    return text;
  }
}

/** 패널의 지금 상태. { markdown: true }면 최신 답변의 Markdown(md)도 함께 읽는다 (조금 느림). */
async function snapshot(wc, svc, { markdown = false } = {}) {
  if (wc.isDestroyed()) return null;
  const cfg = { stop: svc.stop || [], response: svc.response || [], messages: svc.messages || null };
  const md = markdown ? htmlToMarkdown.toString() : 'null';
  try {
    return await wc.executeJavaScript(`(${pageSnapshot.toString()})(${JSON.stringify(cfg)}, ${md})`, true);
  } catch {
    return null; // 페이지가 바뀌는 중
  }
}

/**
 * 보낸 뒤부터 답변이 끝날 때까지 지켜본다.
 * before: 보내기 직전 snapshot. isCurrent(): 이 감시가 아직 유효한지 (새로 보내면 false).
 * onState(state, info): 'answering' | 'done' | 'timeout' | 'no-answer'
 *   시간 초과(timeout) 뒤에 답변이 끝나면 'done'이 한 번 더 온다 (info.late = true).
 * opts.maxMs: 시간 초과까지 기다릴 시간, opts.startMs: 답변 시작을 기다릴 시간
 */
async function watchAnswer(wc, svc, before, isCurrent, onState, opts = {}) {
  const maxMs = opts.maxMs || DEFAULT_MAX_MS;
  const startMs = opts.startMs || DEFAULT_START_MS;
  const startAt = Date.now();
  let started = false;
  let late = false;
  let lastText = null;
  let stable = 0;

  while (isCurrent() && !wc.isDestroyed()) {
    await sleep(late ? LATE_POLL_MS : POLL_MS);
    const snap = await snapshot(wc, svc);
    if (!snap) continue;

    if (!started) {
      const changed = snap.count > (before?.count ?? 0) || (snap.text && snap.text !== (before?.text ?? ''));
      if (snap.stop || changed) {
        started = true;
        onState('answering');
      } else if (Date.now() - startAt > startMs) {
        return onState('no-answer');
      }
      continue;
    }

    if (!snap.stop && snap.text && snap.text === lastText) stable++;
    else stable = 0;
    lastText = snap.text;

    // 천천히 지켜볼 때는 한 번만 같아도 충분하다 (간격이 길다).
    if (stable >= (late ? 1 : STABLE_POLLS)) return onState('done', { chars: snap.text.length, late });
    const elapsed = Date.now() - startAt;
    if (!late && elapsed > maxMs) {
      late = true;
      onState('timeout');
    } else if (late && elapsed > maxMs + LATE_EXTRA_MS) {
      return;
    }
  }
}

module.exports = { snapshot, watchAnswer };
