// 답변 HTML을 Markdown으로 바꾼다. 표·코드 블록·목록·제목·강조·링크를 살린다.
// 이 함수는 toString()으로 서비스 페이지 안에 주입되어 실행된다. 바깥 변수를 쓰면 안 된다.
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.markdown)이 같이 쓴다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).markdown = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function htmlToMarkdown(root) {
    const SKIP = /^(BUTTON|SVG|STYLE|SCRIPT|NOSCRIPT|TEXTAREA|INPUT|SELECT|MAT-ICON|TITLE)$/;
    const BLOCK_DISPLAY = /^(block|flex|grid|table|list-item|flow-root)$/;
    const LANG_RE = /^[A-Za-z][\w+#.-]{0,15}$/;
    const style = (el) => {
      try {
        return getComputedStyle(el);
      } catch {
        return null;
      }
    };

    // ---- 코드 블록 찾기 ----
    // 서비스마다 모양이 다르다: <pre>(Gemini·DeepSeek 등), CodeMirror .cm-content(ChatGPT),
    // <pre> 없이 줄바꿈을 그대로 보여 주는 <code>(ChatGPT 출력 블록).
    function codeRootText(el) {
      if (el.tagName === 'PRE') return (el.querySelector('code') || el).innerText.replace(/\n$/, '');
      if (el.classList.contains('cm-content')) {
        return [...el.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\n');
      }
      if (el.tagName === 'CODE') {
        const s = style(el);
        const preLike = s && /^pre/.test(s.whiteSpace) && s.display !== 'inline';
        if (preLike && el.textContent.includes('\n')) return el.textContent.replace(/\n$/, '');
      }
      return null;
    }

    const codeRoots = new Map(); // 코드 블록 요소 -> { text, lang }
    const skip = new Set(); // 코드 블록 머리줄의 언어 이름 등, 따로 찍지 않을 요소

    for (const el of root.querySelectorAll('pre, .cm-content, code')) {
      if ([...codeRoots.keys()].some((r) => r.contains(el))) continue;
      const text = codeRootText(el);
      if (text === null) continue;

      // 언어: 클래스(language-xxx) · data-language, 없으면 머리줄의 짧은 영문 단어
      const cls = `${el.className || ''} ${el.querySelector('code')?.className || ''}`;
      let lang = el.getAttribute('data-language') || /(?:language|lang)-([\w+#.-]+)/.exec(cls)?.[1] || '';

      // 코드 블록을 감싼 상자(코드 말고는 머리줄 정도만 있는 상자)에서 머리줄 글자를 찾아 건너뛴다.
      let box = el.parentElement;
      for (let i = 0; i < 10 && box && box !== root; i++) {
        const extra = box.innerText.length - el.innerText.length;
        if (extra > 60) break;
        for (const leaf of box.querySelectorAll('*')) {
          if (leaf.children.length || el.contains(leaf) || leaf.contains(el)) continue;
          if (leaf.closest('p,li,td,th,h1,h2,h3,h4,h5,h6,blockquote')) continue; // 본문 글은 건드리지 않는다
          const t = (leaf.textContent || '').trim();
          if (!t || t.length > 20) continue;
          skip.add(leaf);
          if (!lang && LANG_RE.test(t)) lang = t;
        }
        box = box.parentElement;
      }
      codeRoots.set(el, { text, lang: lang.toLowerCase() });
    }

    // 코드 블록은 뒤의 공백 정리에서 빼 두었다가 마지막에 되돌린다 (들여쓰기·빈 줄 보존).
    const kept = [];
    const keep = (s) => `\u0000${kept.push(s) - 1}\u0000`;
    const restore = (s) => s.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]);

    // ---- 변환 ----
    const wrap = (s) => `\n\n${s}\n\n`;
    const children = (el, ctx) => [...el.childNodes].map((n) => convert(n, ctx)).join('');

    function table(el) {
      const rows = [...el.querySelectorAll('tr')].map((tr) =>
        [...tr.children].map((td) => convert(td, { inline: true }).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()),
      );
      if (!rows.length) return '';
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r) => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`;
      return wrap([line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n'));
    }

    function list(el, ordered, ctx) {
      let n = Number(el.getAttribute('start')) || 1;
      const items = [...el.children].filter((li) => li.tagName === 'LI');
      const out = items.map((li) => {
        const marker = ordered ? `${n++}. ` : '- ';
        const body = children(li, ctx).replace(/\n{3,}/g, '\n\n').trim();
        // 항목 안의 줄(하위 목록 등)은 표시 너비만큼 들여 쓴다.
        return marker + body.split('\n').join(`\n${' '.repeat(marker.length)}`);
      });
      return wrap(out.join('\n'));
    }

    function convert(node, ctx = {}) {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent.replace(/\s+/g, ' ');
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const el = node;
      const tag = el.tagName.toUpperCase();
      if (SKIP.test(tag) || el.getAttribute('role') === 'button' || skip.has(el)) return '';

      const code = codeRoots.get(el);
      if (code) return wrap(keep(`\`\`\`${code.lang}\n${code.text}\n\`\`\``));

      switch (tag) {
        case 'CODE':
          return `\`${el.textContent}\``;
        case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
          return wrap(`${'#'.repeat(Number(tag[1]))} ${children(el, ctx).trim()}`);
        case 'P':
          return wrap(children(el, ctx).trim());
        case 'BR':
          return '\n';
        case 'HR':
          return wrap('---');
        case 'STRONG': case 'B': {
          const c = children(el, ctx).trim();
          return c ? `**${c}**` : '';
        }
        case 'EM': case 'I': {
          const c = children(el, ctx).trim();
          return c ? `*${c}*` : '';
        }
        case 'DEL': case 'S':
          return `~~${children(el, ctx).trim()}~~`;
        case 'A': {
          const c = children(el, ctx).trim();
          const href = el.getAttribute('href') || '';
          return /^https?:/.test(href) && c ? `[${c}](${href})` : c;
        }
        case 'IMG': {
          const src = el.getAttribute('src') || '';
          return /^https?:/.test(src) ? `![${el.getAttribute('alt') || ''}](${src})` : '';
        }
        case 'UL':
          return list(el, false, ctx);
        case 'OL':
          return list(el, true, ctx);
        case 'TABLE':
          return table(el);
        case 'BLOCKQUOTE': {
          // 인용문 안의 코드 블록도 줄마다 "> "가 붙도록 먼저 되돌린 뒤 앞머리를 붙인다.
          const inner = restore(children(el, ctx)).replace(/\n{3,}/g, '\n\n').trim();
          const quoted = inner.split('\n').map((l) => (l.trim() ? `> ${l}` : '>'));
          return wrap(quoted.filter((l, i) => !(l === '>' && quoted[i - 1] === '>')).join('\n'));
        }
        default: {
          const c = children(el, ctx);
          const s = !ctx.inline && style(el);
          return s && BLOCK_DISPLAY.test(s.display) ? wrap(c.trim()) : c;
        }
      }
    }

    return restore(
      convert(root)
        .split('\n')
        .map((l) => l.replace(/[ \t]+$/, '').replace(/^ (?! )/, '')) // 줄 끝 공백, 문단 첫머리의 남는 공백 한 칸
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim(),
    );
  }

  return { htmlToMarkdown };
});
