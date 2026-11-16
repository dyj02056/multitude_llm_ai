'use strict';
// 접근성 훑어보기 도우미 (v0.30.0): 화면 뼈대(index.html · sidepanel.html)를 글로 읽어
// 버튼 · 입력칸에 "이름"이 있는지, 창(dialog)에 역할 · 제목이 달렸는지, 색 대비가 충분한지 계산한다.
// 브라우저 없이 정규식으로만 본다 — 스크립트가 나중에 채우는 것은 볼 수 없어서, 그런 요소는 뼈대에 aria 이름을 달아 두게 한다.
//
// [쉽게 말하면] 화면 읽기 프로그램을 쓰는 사람이 "이 버튼이 뭔지" 알 수 있게 이름표가 붙어 있는지 검사하는 부품입니다.

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}(?:="([^"]*)")?(?=[\\s>/])`).exec(tag);
  return m ? m[1] ?? '' : null;
};
const has = (tag, name) => attr(tag, name) !== null;
const lineOf = (html, at) => html.slice(0, at).split('\n').length;
const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').trim();

/**
 * html → { controls: [{ tag, id, line, raw, named, symbolOnly }], dialogs: [{ id, ok }], tables, live }
 * 이름으로 치는 것: 보이는 글 · data-i18n(글을 넣는 키) · aria-label · data-i18n-aria · aria-labelledby ·
 *   <label for> 또는 감싼 <label> · title(data-i18n-title). placeholder만으로는 이름으로 치지 않는다.
 * symbolOnly: 버튼 글이 기호뿐(글자 · 숫자 없음)인데 aria 이름이 없음 — 화면 읽기 프로그램이 "오른쪽 화살표"처럼 읽는다.
 */
function scan(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  const labelFor = new Set([...body.matchAll(/<label\b[^>]*\sfor="([^"]+)"/g)].map((m) => m[1]));
  const controls = [];
  for (const m of body.matchAll(/<(button|input|select|textarea)\b[^>]*>/g)) {
    const [raw, tag] = m;
    if (tag === "input" && (attr(raw, "type") === "hidden" || (attr(raw, "type") === "file" && has(raw, "hidden")))) continue; // 숨긴 파일 고르기 칸은 버튼이 대신 연다
    const id = attr(raw, 'id') || '';
    const aria = has(raw, 'aria-label') || has(raw, 'data-i18n-aria') || has(raw, 'aria-labelledby');
    let named = aria;
    let symbolOnly = false;
    if (tag === 'button') {
      const end = body.indexOf('</button>', m.index);
      const inner = body.slice(m.index + raw.length, end);
      const text = strip(inner);
      const keyed = has(raw, 'data-i18n') || /\sdata-i18n="/.test(inner);
      named = named || keyed || !!text || has(raw, "data-label-by-script"); // data-label-by-script: 글을 스크립트가 넣는 버튼 (테스트가 그 id를 쓰는 코드가 있는지 본다)
      symbolOnly = !aria && !keyed && !!text && !/[\p{L}\p{N}]/u.test(text);
    } else {
      // 감싼 <label>: 이 요소 앞에서 마지막으로 열린 <label>이 아직 닫히지 않았으면 그 안에 있다
      const before = body.slice(0, m.index);
      const wrapped = before.lastIndexOf('<label') > before.lastIndexOf('</label>');
      named = named || labelFor.has(id) || wrapped || has(raw, 'title') || has(raw, 'data-i18n-title');
    }
    controls.push({ tag, id, line: lineOf(body, m.index), raw, named, symbolOnly });
  }
  // 창: class="modal" 안의 상자가 role="dialog" · aria-modal="true" · aria-labelledby(있는 id)를 갖는지
  const ids = new Set([...body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const dialogs = [];
  for (const m of body.matchAll(/<div id="(\w+)" class="modal"[^>]*>\s*<div class="modal-box[^>]*>/g)) {
    const box = m[0].slice(m[0].indexOf('<div class="modal-box'));
    const by = attr(box, 'aria-labelledby');
    dialogs.push({ id: m[1], ok: attr(box, 'role') === 'dialog' && attr(box, 'aria-modal') === 'true' && !!by && ids.has(by) });
  }
  const live = [...body.matchAll(/<[^>]*\saria-live="(polite|assertive)"[^>]*>/g)].map((m) => attr(m[0], 'id'));
  return { controls, dialogs, live };
}

// ---------- 색 대비 (WCAG 2.x) ----------
/** '#rrggbb' → 상대 휘도 */
function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
/** 두 색의 대비 (1 ~ 21). 보통 글자는 4.5 이상이 AA */
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** styles.css의 :root 색 이름표 → { '--bg': '#0d1117', … } (#rrggbb만) */
function cssTokens(css) {
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] || '';
  return Object.fromEntries([...root.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2].toLowerCase()]));
}

module.exports = { scan, contrast, luminance, cssTokens };
