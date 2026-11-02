// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/export.js)
// 기록 · 답변 비교 · 분석 결과 내보내기 (v0.14.0): Markdown 글과, 파일 하나로 완결되는 밝은 문서 모양 HTML.
// Electron 앱 화면(<script>, 전역 MLA.exporter)과 크롬 확장 프로그램이 같이 쓰고, 테스트는 require로 읽는다.
//
// [쉽게 말하면]
// 질문과 AI별 답변, 종합 · 분석 결과를 "문서 하나"로 묶어 파일로 저장하게 해 줍니다.
//   - Markdown(.md): 다른 메모 앱에 그대로 붙여 넣기 좋게
//   - HTML(.html): 브라우저로 열면 밝은 보고서 모양. 인쇄(Ctrl+P)하면 PDF로도 저장됩니다.
// HTML에는 바깥 파일(글꼴 · 그림 · 스크립트)을 하나도 쓰지 않고, 모든 글은 이스케이프해서 넣습니다 (답변 속 <script>가 실행되지 않게).
(function (root, factory) {
  const api = factory(root.MLA && root.MLA.analysis);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).exporter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (analysis) {
  'use strict';

  const AN = analysis || require('./analysis');
  const NO_TEXT = '(글 없이 첨부 파일만 보냄)';

  const fmtTime = (ms) =>
    new Date(ms).toLocaleString('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

  /**
   * 문서 한 개의 공통 모양 (Markdown · HTML이 같이 쓴다)
   * { title, at, question, files: [{ name, size }], answers: [{ name, text }], synth: [{ judge, text }], analysis: { judge, at, md, names } | null }
   */

  /** 기록 하나 → 문서 */
  function docFromRecord(rec) {
    const answers = [];
    for (const id of rec.targets || []) {
      const a = rec.answers?.[id];
      if (a?.text) answers.push({ name: a.name || id, text: a.md || a.text });
    }
    const synth = (rec.synth || []).filter((s) => s.mode !== 'analysis').map((s) => ({ judge: s.judge, text: s.md || s.text || '' }));
    const analyses = (rec.synth || []).filter((s) => s.mode === 'analysis');
    const last = analyses[analyses.length - 1];
    return {
      title: (rec.question || NO_TEXT).split('\n')[0].slice(0, 120),
      at: rec.at || Date.now(),
      question: rec.question || NO_TEXT,
      files: (rec.files || []).map((f) => ({ name: f.name, size: f.size })),
      answers,
      synth,
      analysis: last ? { judge: last.judge, at: last.at, md: last.md || last.text || '', names: last.names || [] } : null,
    };
  }

  /** 답변 비교 화면 → 문서 (지금 열린 패널의 최신 답변과 이번 질문의 분석) */
  function docFromCompare({ question, answers, analysis: an }) {
    const q = question || '(질문 없음)';
    return {
      title: q.split('\n')[0].slice(0, 120),
      at: Date.now(),
      question: q,
      files: [],
      answers: (answers || []).filter((a) => a.text).map((a) => ({ name: a.name, text: a.md || a.text })),
      synth: [],
      analysis: an ? { judge: an.judge, at: an.at, md: an.md || an.text || '', names: an.names || [] } : null,
    };
  }

  // ---------- Markdown ----------

  /** 문서 → Markdown 글 */
  function toMarkdown(doc) {
    const parts = [`# ${doc.title}`, '', `> ${fmtTime(doc.at)} · Multitude LLM`, '', '## 질문', '', doc.question];
    if (doc.files.length) parts.push('', `첨부: ${doc.files.map((f) => `${f.name} (${fmtSize(f.size || 0)})`).join(' · ')}`);
    if (doc.analysis) parts.push('', `## 분석 (판정 ${doc.analysis.judge})`, '', doc.analysis.md);
    for (const a of doc.answers) parts.push('', `## ${a.name}`, '', a.text);
    for (const s of doc.synth) parts.push('', `## 종합 (${s.judge})`, '', s.text);
    return `${parts.join('\n')}\n`;
  }

  // ---------- HTML ----------

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  /** HTML에 넣을 글 이스케이프 (모든 글은 이것을 거친다) */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

  /**
   * 답변 글(Markdown) → 안전한 HTML 조각. 코드 블록 · 제목 · 글머리표 · 표 · 굵게 · 인라인 코드만 알아보고,
   * 나머지는 줄바꿈을 살린 문단으로. 글은 모두 이스케이프한 뒤 태그를 붙인다 (HTML을 그대로 통과시키지 않는다).
   */
  function mdToHtml(md) {
    const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    const inline = (t) =>
      esc(t)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/.exec(line);
      if (fence) {
        const close = fence[1];
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
        i++;
        out.push(`<pre><code${fence[2] ? ` data-lang="${esc(fence[2])}"` : ''}>${esc(body.join('\n'))}</code></pre>`);
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        const level = Math.min(6, h[1].length + 2); // 문서 안의 h3~h6
        out.push(`<h${level}>${inline(h[2])}</h${level}>`);
        i++;
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
        const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const [head, , ...body] = rows;
        out.push(
          `<table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
            body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
            '</tbody></table>',
        );
        continue;
      }
      if (/^\s*(?:[-*•]|\d+[.)])\s+/.test(line)) {
        const items = [];
        const ordered = /^\s*\d+[.)]/.test(line);
        while (i < lines.length && /^\s*(?:[-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''));
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
        continue;
      }
      if (!line.trim()) {
        i++;
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*(`{3,}|~{3,})|\s*(?:[-*•]|\d+[.)])\s+|\s*\|.*\|\s*$)/.test(lines[i])) para.push(lines[i++]);
      if (!para.length) para.push(lines[i++]);
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    }
    return out.join('\n');
  }

  /** 분석 결과 → HTML (형식이 맞으면 이견 표 · 공통 의견 · 근거 부족 · 최종 답변, 깨졌으면 글 그대로) */
  function analysisHtml(an) {
    const res = AN.parseAnalysis(an.md, { names: an.names || [] });
    const head = `<h2>분석 <small>판정 ${esc(an.judge)}${an.at ? ` · ${esc(fmtTime(an.at))}` : ''}</small></h2>`;
    if (!res.ok) return `${head}\n<p class="note">정해진 형식이 아니라서 글 그대로 넣었습니다 (${esc(res.reason)})</p>\n<div class="answer">${mdToHtml(res.raw)}</div>`;
    const list = (items, render) => (items.length ? `<ul>${items.map((x) => `<li>${render(x)}</li>`).join('')}</ul>` : '<p class="muted">없음</p>');
    let dis = '<p class="muted">이견이 없습니다 — 답변들이 같은 방향입니다</p>';
    if (res.disagreements.length) {
      const cols = [...new Set([...(an.names || []), ...res.disagreements.flatMap((d) => d.positions.map((p) => p.name))])];
      dis =
        `<table><thead><tr><th>쟁점</th>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}<th>판단</th></tr></thead><tbody>` +
        res.disagreements
          .map((d) => {
            const cell = (name) => {
              const p = d.positions.find((x) => x.name === name);
              return `<td>${p && p.text && p.text !== '-' ? esc(p.text) : '<span class="muted">—</span>'}</td>`;
            };
            return `<tr><td><strong>${esc(d.topic)}</strong></td>${cols.map(cell).join('')}<td class="verdict">${esc(d.verdict || '—')}</td></tr>`;
          })
          .join('') +
        '</tbody></table>';
    }
    return [
      head,
      `<h3>이견 <span class="count">${res.disagreements.length}</span></h3>`,
      dis,
      `<h3>공통 의견 <span class="count">${res.common.length}</span></h3>`,
      list(res.common, esc),
      `<h3>근거 부족 <span class="count">${res.unsupported.length}</span></h3>`,
      list(res.unsupported, (u) => `${u.name ? `<b>[${esc(u.name)}]</b> ` : ''}${esc(u.text)}`),
      '<h3>최종 답변</h3>',
      `<div class="answer final">${mdToHtml(res.final)}</div>`,
    ].join('\n');
  }

  // 밝은 문서 모양 (인쇄 · PDF 저장에 맞춤). 바깥 글꼴 · 그림을 쓰지 않는다.
  const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #f5f6f8; color: #1d2230; font: 15px/1.65 "Pretendard", "Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif; }
main { max-width: 900px; margin: 32px auto; padding: 36px 44px; background: #fff; border: 1px solid #e3e6ec; border-radius: 14px; box-shadow: 0 4px 24px rgba(20, 30, 60, .06); }
header { border-bottom: 2px solid #6d5cff; padding-bottom: 14px; margin-bottom: 22px; }
header .brand { font-size: 12px; font-weight: 700; letter-spacing: .06em; color: #6d5cff; text-transform: uppercase; }
h1 { font-size: 24px; line-height: 1.35; margin: 6px 0 4px; }
header .meta { color: #6b7385; font-size: 13px; }
h2 { font-size: 19px; margin: 30px 0 10px; padding-top: 14px; border-top: 1px solid #eceef3; }
h2 small { font-size: 13px; font-weight: 500; color: #6b7385; margin-left: 6px; }
h3 { font-size: 15.5px; margin: 18px 0 6px; }
h4, h5, h6 { font-size: 14.5px; margin: 14px 0 4px; }
.question { background: #f0eeff; border: 1px solid #ddd8ff; border-radius: 12px; padding: 12px 16px; white-space: pre-wrap; font-weight: 600; }
.files { color: #6b7385; font-size: 13px; margin-top: 6px; }
.answer { border-left: 3px solid #c9cfdb; padding: 2px 0 2px 16px; }
.answer.final { border-left-color: #2fb37a; }
pre { background: #f4f5f8; border: 1px solid #e3e6ec; border-radius: 8px; padding: 10px 12px; overflow-x: auto; font: 12.5px/1.5 "Cascadia Mono", Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
code { font-family: "Cascadia Mono", Consolas, monospace; font-size: .92em; background: #f1f2f6; padding: 0 4px; border-radius: 4px; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 12px; font-size: 13.5px; }
th, td { border: 1px solid #dfe3ea; padding: 6px 9px; text-align: left; vertical-align: top; }
th { background: #f4f5f8; }
td.verdict { color: #0f7a55; }
.count { display: inline-block; min-width: 20px; padding: 0 6px; border-radius: 999px; background: #eef0f5; color: #4b5366; font-size: 12px; text-align: center; }
.muted { color: #8a91a2; }
.note { background: #fff7e0; border: 1px solid #f3dd9b; border-radius: 8px; padding: 8px 12px; font-size: 13px; }
footer { margin-top: 30px; color: #9aa1b1; font-size: 12px; text-align: center; }
@media print { body { background: #fff; } main { margin: 0; border: none; box-shadow: none; padding: 0; } h2 { break-after: avoid; } pre, table { break-inside: avoid; } }
`;

  /** 문서 → HTML 파일 한 개 (밝은 문서 모양, 바깥 파일 없음, 스크립트 없음) */
  function toHtml(doc) {
    const files = doc.files.length ? `<div class="files">첨부: ${doc.files.map((f) => `${esc(f.name)} (${esc(fmtSize(f.size || 0))})`).join(' · ')}</div>` : '';
    const body = [
      '<header>',
      '<div class="brand">Multitude LLM</div>',
      `<h1>${esc(doc.title)}</h1>`,
      `<div class="meta">${esc(fmtTime(doc.at))} · AI 답변 ${doc.answers.length}개${doc.analysis ? ' · 분석 포함' : ''}</div>`,
      '</header>',
      '<h2>질문</h2>',
      `<div class="question">${esc(doc.question)}</div>`,
      files,
      doc.analysis ? analysisHtml(doc.analysis) : '',
      ...doc.answers.map((a) => `<h2>${esc(a.name)}</h2>\n<div class="answer">${mdToHtml(a.text)}</div>`),
      ...doc.synth.map((s) => `<h2>종합 <small>${esc(s.judge)}</small></h2>\n<div class="answer">${mdToHtml(s.text)}</div>`),
      `<footer>Multitude LLM에서 내보냄 · ${esc(fmtTime(Date.now()))}</footer>`,
    ]
      .filter(Boolean)
      .join('\n');
    return (
      '<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      // 이 파일 안의 스크립트 · 바깥 파일은 쓰지 않는다 (답변 글은 이스케이프되어 있지만 한 번 더 막는다)
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">\n` +
      `<title>${esc(doc.title)}</title>\n<style>${CSS}</style>\n</head>\n<body>\n<main>\n${body}\n</main>\n</body>\n</html>\n`
    );
  }

  /** 저장할 파일 이름: "2026-11-02 질문 앞부분.md" (Windows에서 못 쓰는 글자는 뺀다) */
  function fileName(doc, ext) {
    const d = new Date(doc.at);
    const pad = (n) => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const title = doc.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50).replace(/[. ]+$/, '') || '답변';
    return `${day} ${title}.${ext}`;
  }

  return { docFromRecord, docFromCompare, toMarkdown, toHtml, mdToHtml, esc, fileName };
});
