'use strict';
// v0.39.0 디자인 정리 단위 테스트:  npm test
// "터미널 흉내" 장식(❯ · ~/경로 · [x] · ## · ⏎)과 영문 약어 버튼이 다시 들어오지 않는지 본다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('CSS: 기호 장식 없음 (❯ · ~/ · [x] · [ ] · ## · ⏎), 화면 글자는 산스 · 코드는 고정폭', () => {
  for (const f of ['src/renderer/styles.css', 'extension/sidepanel.css']) {
    const css = read(f);
    for (const m of css.matchAll(/content:\s*"([^"]*)"/g)) {
      assert.ok(!/[❯⏎]|~\/|\[[ x!]\]|^#+ ?$/.test(m[1]), `${f}: content "${m[1]}"`);
    }
    assert.ok(!/inset 2px 0 0 var\(--svc/.test(css), `${f}: 서비스 색은 왼쪽 띠가 아니라 작은 사각형으로`);
  }
  const css = read('src/renderer/styles.css');
  assert.match(css, /--sans: /);
  assert.match(css, /html, body \{[^}]*font: 13px\/1\.5 var\(--sans\)/);
  assert.match(css, /\.url \{[^}]*var\(--mono\)/);
});

test('툴바 · 사이드탭 버튼: 글자는 사전(ko · en)에서 — lib · proj · diff · hist · cmp · models · send 같은 약어 없음', () => {
  const html = read('src/renderer/index.html');
  const bar = html.slice(html.indexOf('<header id="toolbar">'), html.indexOf('</header>'));
  for (const m of bar.matchAll(/<button[^>]*>([^<]*)<\/button>/g)) {
    if (m[1] === '?') continue;
    assert.match(m[0], /data-i18n="ui\.(tb|roadmap|h)\./, m[0]);
  }
  const side = read('extension/sidepanel.html');
  for (const word of ['>models<', '>send<', '>app ↗<', '>ctx:<', '>on<']) assert.ok(!side.includes(word), word);
  const ko = require('../src/shared/i18n-ko-ui.js');
  const en = require('../src/shared/i18n-en-ui.js');
  for (const k of Object.keys(ko).filter((k) => k.startsWith('ui.tb.'))) assert.ok(en[k], k);
  assert.equal(ko['ui.statusLine'].includes('{ready}') && en['ui.statusLine'].includes('{ready}'), true);
});
