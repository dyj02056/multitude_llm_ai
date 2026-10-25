'use strict';

// 답변이 다 써졌는지 지켜보고, 최신 답변 글을 꺼낸다.
// 완료 판단은 크롬 확장 프로그램과 같이 쓰는 shared/watch.js가 하고, 여기서는 패널 페이지를 읽는 방법만 준다.

// [쉽게 말하면] AI가 답변을 "다 썼는지" 지켜보는 감시원입니다.
// AI는 글자를 조금씩 이어서 쓰기 때문에, 글이 더 이상 늘지 않고 "멈춤" 버튼이 사라지면 다 쓴 것으로 봅니다.
// 그 판단 규칙은 공통 부품(shared/watch.js)에 있고, 여기서는 "패널 페이지를 읽는 방법"만 알려 줍니다.

const { htmlToMarkdown } = require('../shared/markdown');
const { pageSnapshot } = require('../shared/page');
const core = require('../shared/watch');

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
 * 보낸 뒤부터 답변이 끝날 때까지 지켜본다. 인자와 onState는 shared/watch.js의 watchAnswer와 같다.
 * before: 보내기 직전 snapshot. isCurrent(): 이 감시가 아직 유효한지 (새로 보내면 false).
 */
function watchAnswer(wc, svc, before, isCurrent, onState, opts = {}) {
  return core.watchAnswer(() => snapshot(wc, svc), before, () => isCurrent() && !wc.isDestroyed(), onState, opts);
}

module.exports = { snapshot, watchAnswer };
