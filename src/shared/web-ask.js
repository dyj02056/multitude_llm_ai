// 보고 있는 웹페이지로 질문 (v0.15.0, 크롬 확장): 오른쪽 클릭 메뉴로 넘어온 "선택한 글" · "페이지 본문"을 공통 입력창에 넣을 글로 만든다.
// 크롬 확장 화면(<script>, 전역 MLA.webAsk)과 테스트(require)가 같이 쓴다. Windows 앱에는 이 메뉴가 없다.
//
// [쉽게 말하면]
//   - 선택한 글: 오른쪽 클릭 메뉴가 넘겨주는 글을 그대로 입력창에 넣고, 그 아래에 질문을 쓰게 합니다.
//   - 페이지 본문: 그 페이지의 글을 page.md 파일로 만들어 첨부합니다 (비밀 정보 검사는 화면이 먼저 합니다).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).webAsk = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_SELECTION = 50000; // 입력창에 넣는 선택한 글의 최대 글자 수
  const MAX_PAGE = 300000; // page.md에 넣는 본문의 최대 글자 수
  const FRESH_MS = 2 * 60 * 1000; // 이보다 오래된 요청은 버린다 (앱 탭을 늦게 열었을 때 엉뚱한 글이 들어가지 않게)

  /** 메뉴에서 넘어온 요청을 검사한다 → { kind, title, url, text, truncated } | null */
  function normalize(raw, now = Date.now()) {
    if (!raw || typeof raw !== 'object' || !['selection', 'page'].includes(raw.kind)) return null;
    if (!Number.isFinite(raw.at) || now - raw.at > FRESH_MS || raw.at - now > 5000) return null;
    let url = '';
    try {
      const u = new URL(String(raw.url || ''));
      if (u.protocol === 'http:' || u.protocol === 'https:') url = u.href;
    } catch {}
    const max = raw.kind === 'page' ? MAX_PAGE : MAX_SELECTION;
    const text = String(raw.text || '').replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
    if (!text) return null;
    const title = String(raw.title || '').replace(/\s+/g, ' ').trim().slice(0, 200) || url || '웹페이지';
    return { kind: raw.kind, title, url, text: text.slice(0, max), truncated: text.length > max };
  }

  const source = (r) => (r.url ? `「${r.title}」(${r.url})` : `「${r.title}」`);

  /** 선택한 글 → 입력창 글. 맨 끝 "질문: " 뒤에 바로 이어 쓰게 한다. */
  function selectionPrompt(r) {
    return [
      `다음은 웹페이지 ${source(r)}에서 고른 글입니다.${r.truncated ? ` (길어서 앞 ${MAX_SELECTION.toLocaleString()}자만)` : ''}`,
      '',
      '---',
      r.text,
      '---',
      '',
      '질문: ',
    ].join('\n');
  }

  /** 페이지 본문 → page.md 파일 내용 */
  function pageFile(r, now = Date.now()) {
    const d = new Date(now);
    const pad = (n) => String(n).padStart(2, '0');
    const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return {
      name: 'page.md',
      type: 'text/markdown',
      text: [
        `# ${r.title}`,
        '',
        r.url ? `출처: ${r.url}` : '',
        `가져온 때: ${when}${r.truncated ? ` (길어서 앞 ${MAX_PAGE.toLocaleString()}자만)` : ''}`,
        '',
        '---',
        '',
        r.text,
        '',
      ]
        .filter((l, i) => l !== '' || i !== 2)
        .join('\n'),
    };
  }

  /** 페이지 본문을 첨부할 때 입력창에 넣는 안내 글 */
  function pagePrompt(r) {
    return [`첨부한 page.md는 웹페이지 ${source(r)}의 본문입니다.`, '', '질문: '].join('\n');
  }

  return { MAX_SELECTION, MAX_PAGE, FRESH_MS, normalize, selectionPrompt, pageFile, pagePrompt };
});
