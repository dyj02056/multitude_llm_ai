'use strict';
// v0.37.0 단위 테스트:  npm test
// [쉽게 말하면] 사이드탭의 PDF 읽기(진짜 pdf.js로 만든 PDF를 읽어 봄) · 영상 자막 고르기 · 번역 비교 · 한 줄 종합 정리 ·
// 사이트별 프리셋이 맞게 동작하고, 연결(빌드 · 화면 · 배경)이 이어져 있는지 확인합니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const SP = require('../src/shared/side-panel');
const PR = require('../src/shared/page-read');
const PT = require('../src/shared/pdf-text');
const { SERVICES } = require('../src/shared/services');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---------- 본문 · PDF · 자막 가리기 ----------

test('읽은 결과 가리기: PDF(종류 또는 .pdf 주소) · 이미 떠 있는 자막(40자 이상) · 본문 · 없음', () => {
  const base = { title: 'T', url: 'https://x.test/a', text: '본문 글', captions: '', contentType: 'text/html' };
  assert.deepEqual(PR.pickContext(base), { source: 'page', title: 'T', url: 'https://x.test/a', text: '본문 글' });
  assert.equal(PR.pickContext({ ...base, contentType: 'application/pdf', text: '' }).pdf, true);
  assert.equal(PR.pickContext({ ...base, url: 'https://x.test/doc.PDF?dl=1', text: '' }).source, 'pdf');
  assert.equal(PR.pickContext({ ...base, url: 'https://x.test/pdf-guide' }).source, 'page'); // 이름에 pdf만 들어간 것은 아님
  const cap = '00:01 안녕하세요 오늘은 날씨 이야기를 합니다\n00:05 내일은 비가 옵니다';
  const c = PR.pickContext({ ...base, captions: cap });
  assert.equal(c.source, 'captions');
  assert.equal(c.text, cap);
  assert.equal(PR.pickContext({ ...base, captions: '00:01 짧다' }).source, 'page'); // 짧은 자막 한 줄은 본문을 대신하지 않는다
  assert.equal(PR.pickContext({ ...base, text: '  ' }), null);
  assert.equal(PR.pickContext(null), null);
  assert.equal(PR.looksPdf('not a url'), false);
});

/** readPageNow를 가짜 문서에서 돌려 본다 (페이지 안에서 도는 함수라 전역 document · location을 쓴다) */
function runReadPage(doc, loc = { href: 'https://v.test/watch' }) {
  const g = globalThis;
  const keep = { document: g.document, location: g.location };
  g.document = doc;
  g.location = loc;
  try {
    return PR.readPageNow();
  } finally {
    g.document = keep.document;
    g.location = keep.location;
  }
}

test('페이지 안 읽기: 열려 있는 스크립트 패널 · 켜져 있는 자막 트랙만, 꺼진 트랙은 읽지 않는다', () => {
  const seg = (ts, tx) => ({ querySelector: (s) => ({ '.segment-timestamp': { textContent: ` ${ts} ` }, '.segment-text': { textContent: ` ${tx}\n ` } })[s] });
  const doc = (segs, videos) => ({ title: '영상', contentType: 'text/html', body: { innerText: '본문' }, querySelectorAll: (s) => (s === 'ytd-transcript-segment-renderer' ? segs : s === 'video' ? videos : []) });
  const r1 = runReadPage(doc([seg('0:05', '첫 줄'), seg('0:09', '둘째 줄')], []));
  assert.equal(r1.captions, '0:05 첫 줄\n0:09 둘째 줄');
  assert.equal(r1.text, '본문');
  const cue = (t, text) => ({ startTime: t, text });
  const track = (mode, cues) => ({ kind: 'captions', mode, cues });
  const r2 = runReadPage(doc([], [{ textTracks: [track('disabled', [cue(1, '꺼진 트랙')]), track('showing', [cue(65, '<i>켜진</i> 트랙'), cue(70, '둘째')])] }]));
  assert.equal(r2.captions, '01:05 켜진 트랙\n01:10 둘째');
  const r3 = runReadPage(doc([], [{ textTracks: [track('disabled', [cue(1, '꺼진 트랙')])] }]));
  assert.equal(r3.captions, ''); // 자막 설정을 바꾸지 않는다 — 꺼져 있으면 읽지 않음
});

// ---------- PDF ----------

/** 글 한 줄짜리 쪽 n개의 최소 PDF (Helvetica, 영문) */
function makePdf(lines) {
  const objs = [];
  const add = (s) => objs.push(s) && objs.length;
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [${lines.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${lines.length} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  lines.forEach((line, i) => {
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    const stream = `BT /F1 18 Tf 20 100 Td (${line}) Tj ET`;
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

test('PDF 글 꺼내기(가짜 pdf.js): 쪽마다 머리표, 글 없는 쪽은 건너뜀, 길이 · 쪽 수 상한, 오류 code', async () => {
  const mk = (pages, opts = {}) => ({
    getDocument: () => ({
      promise: opts.fail ? Promise.reject(Object.assign(new Error('x'), { name: opts.fail })) : Promise.resolve({
        numPages: pages.length,
        getPage: async (n) => ({ getTextContent: async () => ({ items: pages[n - 1].map((s) => ({ str: s, hasEOL: s.endsWith('.') })) }), cleanup() {} }),
        destroy: async () => {},
      }),
    }),
  });
  const bytes = new Uint8Array([1, 2, 3]);
  const r = await PT.extractPdfText(mk([['Hello', 'world.'], [], ['Third']]), bytes, { label: (n) => `[${n}쪽]` });
  assert.equal(r.text, '[1쪽]\nHello world.\n\n[3쪽]\nThird');
  assert.deepEqual([r.pages, r.totalPages, r.truncated, r.empty], [3, 3, false, false]);
  const cut = await PT.extractPdfText(mk([['a'.repeat(300)], ['b'.repeat(300)]]), bytes, { maxChars: 400 });
  assert.equal(cut.truncated, true);
  assert.ok(cut.text.length <= 400);
  const few = await PT.extractPdfText(mk([['a'], ['b'], ['c']]), bytes, { maxPages: 2 });
  assert.deepEqual([few.pages, few.totalPages, few.truncated], [2, 3, true]);
  assert.equal((await PT.extractPdfText(mk([[], []]), bytes)).empty, true);
  const code = (p) => p.then(() => null, (e) => e.code);
  assert.equal(await code(PT.extractPdfText(mk([['x']], { fail: 'PasswordException' }), bytes)), 'password');
  assert.equal(await code(PT.extractPdfText(mk([['x']], { fail: 'InvalidPDFException' }), bytes)), 'invalid');
  assert.equal(await code(PT.extractPdfText(mk([['x']], { fail: 'Weird' }), bytes)), 'read');
  assert.equal(await code(PT.extractPdfText(mk([['x']]), new Uint8Array(0))), 'invalid');
  assert.equal(PT.base64ToBytes(Buffer.from('abc').toString('base64')).length, 3);
  assert.throws(() => PT.base64ToBytes('***'), (e) => e.code === 'base64');
});

test('PDF 글 꺼내기(진짜 pdf.js, vendor): 손으로 만든 PDF의 글을 쪽 순서대로 읽는다', { timeout: 60000 }, async (t) => {
  let pdfjs;
  try {
    pdfjs = await import(pathToFileURL(path.join(ROOT, 'src/shared/vendor/pdf.min.mjs')).href);
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(ROOT, 'src/shared/vendor/pdf.worker.min.mjs')).href;
  } catch (err) {
    return t.skip(`이 환경에서는 pdf.js를 불러오지 못함: ${err.message}`);
  }
  const r = await PT.extractPdfText(pdfjs, makePdf(['First page text', 'Second page text']), { label: (n) => `[p.${n}]` });
  assert.match(r.text, /\[p\.1\]\s+First page text/);
  assert.match(r.text, /\[p\.2\]\s+Second page text/);
  assert.equal(r.totalPages, 2);
  await assert.rejects(PT.extractPdfText(pdfjs, new Uint8Array(Buffer.from('not a pdf at all')), {}), (e) => ['invalid', 'read'].includes(e.code));
});

test('vendor pdf.js: 라이선스 · 한국어 CMap이 같이 있고 확장 폴더에 복사된다', () => {
  for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs', 'pdf.LICENSE', 'cmaps/KSCms-UHC-H.bcmap', 'cmaps/Adobe-Korea1-UCS2.bcmap', 'cmaps/LICENSE']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'src/shared/vendor', f)), f);
    assert.ok(fs.existsSync(path.join(ROOT, 'extension/lib/shared/vendor', f)), `extension/${f}`);
  }
  assert.match(read('src/shared/vendor/pdf.LICENSE'), /Apache License/);
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.build.files.includes('!src/shared/vendor/pdf.*'), 'Windows 앱 설치 파일에는 넣지 않는다');
  assert.equal(Buffer.compare(fs.readFileSync(path.join(ROOT, 'src/shared/vendor/cmaps/KSC-H.bcmap')), fs.readFileSync(path.join(ROOT, 'extension/lib/shared/vendor/cmaps/KSC-H.bcmap'))), 0, '바이트 그대로');
});

// ---------- 맥락 · 번역 비교 · 한 줄 종합 ----------

test('맥락: PDF · 자막 출처와 쪽 수가 남는다 (없으면 본문)', () => {
  const c = SP.normalizeContext({ title: 'T', url: 'https://x.test/a.pdf', text: '[1쪽]\n글', source: 'pdf', pages: 3, totalPages: 9, truncated: true });
  assert.deepEqual([c.source, c.pages, c.totalPages, c.truncated], ['pdf', 3, 9, true]);
  assert.equal(SP.normalizeContext({ text: 'a', source: 'evil' }).source, 'page');
  assert.ok(!('pages' in SP.normalizeContext({ text: 'a' })));
});

test('번역 비교: 한쪽에만 있는 문장에 표시 (비슷한 문장은 같은 것으로)', () => {
  assert.deepEqual(SP.splitSentences('첫째 문장입니다. 둘째는요?\n셋째 줄'), ['첫째 문장입니다.', '둘째는요?', '셋째 줄']);
  assert.equal(SP.similarity('Hello world', 'hello, world!'), 1);
  assert.ok(SP.similarity('The cat sat on the mat.', 'The cat sits on the mat.') > 0.7);
  assert.ok(SP.similarity('apples and oranges', '완전히 다른 한글') < 0.2);
  assert.equal(SP.similarity('', 'x'), 0);
  const a = 'The meeting is at noon. Bring your laptop. Lunch is provided.';
  const b = 'The meeting is at noon! Please bring a charger.';
  const d = SP.diffSentences(a, b);
  assert.deepEqual(d.a.map((x) => x.diff), [false, true, true]);
  assert.deepEqual(d.b.map((x) => x.diff), [false, true]);
  assert.deepEqual(SP.diffSentences('', '').a, []);
});

test('한 줄 종합: 요청 글에 두 답(앞부분만), 답 정리(첫 줄 · 머리표 · 굵게 · 따옴표 · 200자)', () => {
  const t = (k) => (k === 'side.oneLine.prompt' ? '한 문장으로' : k);
  const p = SP.oneLinePrompt([{ name: 'Gemini', text: 'A'.repeat(5000) }, { name: 'Claude', text: '답B' }], t, 100);
  assert.ok(p.startsWith('한 문장으로\n\n### Gemini\n'));
  assert.ok(p.includes('### Claude\n답B'));
  assert.ok(!p.includes('A'.repeat(101)));
  assert.equal(SP.cleanOneLine('\n\n## **핵심:** 둘 다 맞다\n더 긴 설명'), '핵심: 둘 다 맞다');
  assert.equal(SP.cleanOneLine('- “따옴표로 감싼 결론”'), '따옴표로 감싼 결론');
  assert.equal(SP.cleanOneLine('1. 번호 달린 답'), '번호 달린 답');
  assert.equal(SP.cleanOneLine('x'.repeat(500)).length, 200);
  assert.equal(SP.cleanOneLine(''), '');
});

// ---------- 사이트별 프리셋 ----------

test('사이트 프리셋: 호스트 열쇠 · 검사 · 저장 · 지우기 · 50개 상한 · 이 주소의 프리셋', () => {
  assert.equal(SP.hostKey('https://www.Example.com/a?b=1#c'), 'example.com');
  assert.equal(SP.hostKey('http://news.site.kr:8080/x'), 'news.site.kr');
  assert.equal(SP.hostKey('chrome://extensions'), '');
  assert.equal(SP.hostKey('nope'), '');
  let m = SP.setSitePreset({}, 'example.com', { selected: ['gemini', 'claude', 'chatgpt', 'gemini', 'nosuch'], quick: 'summary' }, SERVICES, 100);
  assert.deepEqual(m['example.com'], { selected: ['gemini', 'claude'], quick: 'summary', at: 100 }); // 웹 서비스 · 중복 없이 · 2개까지
  m = SP.setSitePreset(m, 'example.com', { selected: ['chatgpt'], quick: 'weird' }, SERVICES, 200);
  assert.deepEqual(m['example.com'], { selected: ['chatgpt'], quick: '', at: 200 });
  assert.deepEqual(SP.setSitePreset(m, '', { selected: ['gemini'] }, SERVICES), m);
  assert.deepEqual(SP.setSitePreset(m, 'x.com', { selected: [] }, SERVICES), m); // 고른 AI가 없으면 저장하지 않음
  assert.deepEqual(SP.presetFor(m, 'https://www.example.com/page'), { host: 'example.com', selected: ['chatgpt'], quick: '', at: 200 });
  assert.equal(SP.presetFor(m, 'https://other.com/'), null);
  assert.deepEqual(SP.clearSitePreset(m, 'example.com'), {});
  assert.deepEqual(SP.normalizeSitePresets('x', SERVICES), {});
  assert.deepEqual(SP.normalizeSitePresets({ 'bad host!': { selected: ['gemini'] }, ok: { selected: ['gemini'], quick: 'compare', at: 1 } }, SERVICES), { ok: { selected: ['gemini'], quick: 'compare', at: 1 } });
  let big = {};
  for (let i = 0; i < SP.MAX_SITES + 5; i++) big = SP.setSitePreset(big, `s${i}.com`, { selected: ['gemini'] }, SERVICES, i + 1);
  assert.equal(Object.keys(big).length, SP.MAX_SITES);
  assert.ok(!('s0.com' in big) && 's54.com' in big); // 가장 오래된 것부터 빠진다
});

// ---------- 연결 ----------

test('연결: 배경 · 사이드 패널 · 화면 뼈대 · 빌드가 새 기능을 이어 준다', () => {
  const bg = read('extension/background.js');
  for (const s of ["'lib/shared/page-read.js', 'lib/shared/local-llm.js'", 'MLA.pageRead.pickContext', 'MLA.pageRead.readPageNow', "msg?.type !== 'mla:local-ask'", 'sender.url?.startsWith(SIDE_URL)']) assert.ok(bg.includes(s), s);
  const sp = read('extension/sidepanel.js');
  for (const s of ['MLA.pdfText.fetchSelfBase64', "lib/shared/vendor/pdf.min.mjs", 'lib/shared/vendor/cmaps/', 'quickCompare', 'oneLineSynth', "type: 'mla:local-ask'", 'SP.setSitePreset', 'sideSites', 'onRunDone']) assert.ok(sp.includes(s), s);
  assert.ok(!/func: \(\) => \(\{ title: document\.title/.test(sp), '본문 읽기는 한 곳(readPageNow)에서');
  const html = read('extension/sidepanel.html');
  for (const id of ['spSite', 'spSiteSave', 'spOne', 'spOneToggle', 'spCompare', 'spCmpA', 'spCmpB']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes('data-quick="compare"'));
  assert.ok(html.includes("connect-src 'self' https://raw.githubusercontent.com"), 'pdf.js가 확장 안의 CMap을 읽는다');
  assert.ok(html.indexOf('side-panel.js') < html.indexOf('page-read.js') && html.indexOf('page-read.js') < html.indexOf('pdf-text.js') && html.indexOf('pdf-text.js') < html.indexOf('sidepanel.js'));
  assert.ok(!/unsafe-eval|script-src[^;]*https/.test(html), 'script-src는 확장 안(self)만');
});
