'use strict';

// 크롬 확장 프로그램 폴더(extension/)를 만든다. Electron 앱과 같은 코드를 쓰도록 src/에서 복사·생성한다.
//   node scripts/build-extension.js          만들기 (npm run build:ext)
//   node scripts/build-extension.js --check  만든 결과가 src/와 맞는지만 확인 (다르면 실패)
//
// 직접 고치는 파일: extension/host.js · project-fs.js · content.js · cookie-shim.js · cookie-bridge.js · background.js · ext.css
// 이 스크립트가 만드는 파일 (직접 고치지 말 것):
//   extension/manifest.json        서비스 목록(src/shared/services.js)과 package.json 버전으로 생성
//   extension/app.html             src/renderer/index.html에서 생성
//   extension/lib/shared/*.js      src/shared/*.js 복사 (vendor/ 안의 외부 라이브러리·라이선스 포함)
//   extension/lib/renderer/*       src/renderer/renderer.js · templates.js · styles.css 복사
//   extension/icons/icon-*.png     scripts/make-icon.js로 생성
//
// 생성 결과도 저장소에 커밋해 둔다. 그래야 받은 그대로 "압축해제된 확장 프로그램을 로드"할 수 있다.

const fs = require('fs');
const path = require('path');
const { SERVICES, MAX_SELECTED } = require('../src/shared/services');
const { renderPng } = require('./make-icon');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const CHECK = process.argv.includes('--check');
const GENERATED = '자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

// 앱 탭(app.html)이 읽는 공통 모듈. 순서가 중요하다 (rounds.js는 synth.js를 쓴다).
const APP_SHARED = ['services', 'layout', 'synth', 'shortcuts', 'watch', 'history-core', 'remote-core', 'rounds'];
// 서비스 페이지(content script)가 읽는 공통 모듈
const CONTENT_SHARED = ['page', 'markdown', 'shortcuts'];
const ICON_SIZES = [16, 32, 48, 128];

/** 만들 파일 목록: { 경로(extension/ 기준): 내용(문자열 | Buffer) } */
function buildFiles() {
  const files = {};

  for (const name of fs.readdirSync(path.join(ROOT, 'src/shared'))) {
    if (!name.endsWith('.js')) continue;
    files[`lib/shared/${name}`] = `// ${GENERATED} (원본: src/shared/${name})\n${read(`src/shared/${name}`)}`;
  }
  for (const name of fs.readdirSync(path.join(ROOT, 'src/shared/vendor'))) {
    const body = read(`src/shared/vendor/${name}`);
    files[`lib/shared/vendor/${name}`] = name.endsWith('.js') ? `// ${GENERATED} (원본: src/shared/vendor/${name})\n${body}` : body;
  }
  for (const name of ['renderer.js', 'templates.js', 'project.js', 'library.js']) {
    files[`lib/renderer/${name}`] = `// ${GENERATED} (원본: src/renderer/${name})\n${read(`src/renderer/${name}`)}`;
  }
  files['lib/renderer/styles.css'] = `/* ${GENERATED} (원본: src/renderer/styles.css) */\n${read('src/renderer/styles.css')}`;

  files['app.html'] = buildAppHtml(read('src/renderer/index.html'));
  files['manifest.json'] = `${JSON.stringify(buildManifest(), null, 2)}\n`;
  for (const size of ICON_SIZES) files[`icons/icon-${size}.png`] = renderPng(size);
  return files;
}

/** Electron 화면(index.html)을 확장 프로그램 탭용으로 바꾼다: CSP에 iframe 허용, 공통 모듈·host.js 추가. */
function buildAppHtml(html) {
  const replace = (from, to) => {
    if (!html.includes(from)) throw new Error(`src/renderer/index.html에서 "${from}"을 찾지 못했습니다`);
    html = html.replace(from, to);
  };
  replace(
    `content="default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' blob: data:"`,
    `content="default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' blob: data:; ` +
      // iframe은 서비스 도메인만 (다른 사이트는 이 탭 안에 뜨지 않게)
      `frame-src ${[...new Set(SERVICES.flatMap((s) => s.hosts))].map((h) => `https://${h}`).join(' ')}; ` +
      `connect-src https://raw.githubusercontent.com"`,
  );
  replace('<link rel="stylesheet" href="styles.css" />', [
    '<link rel="stylesheet" href="lib/renderer/styles.css" />',
    '  <link rel="stylesheet" href="ext.css" />',
    '  <link rel="icon" href="icons/icon-32.png" />',
  ].join('\n'));
  // 화면이 읽는 공통 모듈(../shared/…)은 lib/shared/로, host.js(window.host)는 화면 스크립트보다 먼저 읽힌다.
  html = html.replaceAll('<script src="../shared/', '<script src="lib/shared/');
  replace('  <script src="templates.js"></script>', [
    ...APP_SHARED.map((n) => `  <script src="lib/shared/${n}.js"></script>`),
    '  <script src="project-fs.js"></script>',
    '  <script src="host.js"></script>',
    '  <script src="lib/renderer/templates.js"></script>',
  ].join('\n'));
  replace('  <script src="renderer.js"></script>\n  <script src="project.js"></script>\n  <script src="library.js"></script>', [
    '  <script src="lib/renderer/renderer.js"></script>',
    '  <script src="lib/renderer/project.js"></script>',
    '  <script src="lib/renderer/library.js"></script>',
  ].join('\n'));
  replace('<!doctype html>\n', `<!doctype html>\n<!-- ${GENERATED} (원본: src/renderer/index.html) -->\n`);
  return html;
}

function buildManifest() {
  const hosts = [...new Set(SERVICES.flatMap((s) => s.hosts))];
  const matches = hosts.map((h) => `https://${h}/*`);
  const matchesOf = (pick) => SERVICES.filter(pick).flatMap((s) => s.hosts.map((h) => `https://${h}/*`));
  const jsCookieMatches = matchesOf((s) => s.jsCookies);
  const bridgeMatches = matchesOf((s) => s.jsCookies || s.tokenBridge);
  return {
    manifest_version: 3,
    name: 'Multitude LLM',
    // 크롬은 숫자 버전만 받는다 (예: 0.2.0)
    version: pkg.version.replace(/[^0-9.].*$/, ''),
    // 스토어 설명은 132자까지라 앞의 세 서비스만 이름을 쓴다
    description: `${SERVICES.slice(0, 3).map((s) => s.name).join(' · ')} 등 ${SERVICES.length}개 AI 웹 채팅을 한 탭에 최대 ${MAX_SELECTED}개 띄워 같은 질문을 동시에 보내고 답변을 비교합니다.`,
    minimum_chrome_version: '116',
    icons: Object.fromEntries(ICON_SIZES.map((s) => [s, `icons/icon-${s}.png`])),
    action: {
      default_title: 'Multitude LLM 열기',
      default_icon: Object.fromEntries([16, 32].map((s) => [s, `icons/icon-${s}.png`])),
    },
    background: { service_worker: 'background.js' },
    // browsingData: 패널을 막는 서비스 워커 등록만 지운다 (host.js clearServiceWorkers)
    // cookies: 앱 탭 iframe의 WebSocket 연결에 그 사이트 쿠키를 붙이려고 읽는다 (background.js syncWsCookies)
    permissions: ['storage', 'unlimitedStorage', 'declarativeNetRequest', 'clipboardWrite', 'browsingData', 'cookies'],
    // wss://는 WebSocket 요청 헤더(쿠키)를 바꾸는 규칙에 필요하다 (background.js syncWsCookies)
    host_permissions: [...matches, ...hosts.map((h) => `wss://${h}/*`)],
    content_scripts: [
      {
        matches,
        js: [...CONTENT_SHARED.map((n) => `lib/shared/${n}.js`), 'content.js'],
        all_frames: true,
        run_at: 'document_idle',
      },
      // 화면 스크립트가 로그인 쿠키를 직접 읽고 쓰는 사이트(jsCookies)·localStorage 토큰 사이트(tokenBridge)용.
      // 페이지 스크립트보다 먼저 실행돼야 한다.
      ...(jsCookieMatches.length
        ? [{ matches: jsCookieMatches, js: ['cookie-shim.js'], world: 'MAIN', all_frames: true, run_at: 'document_start' }]
        : []),
      ...(bridgeMatches.length ? [{ matches: bridgeMatches, js: ['cookie-bridge.js'], all_frames: true, run_at: 'document_start' }] : []),
    ],
  };
}

// Windows에서 git이 줄바꿈을 CRLF로 바꿔 받아도 같은 파일로 본다.
const lf = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n');
const same = (have, want, text) => (text ? lf(have) === lf(want) : have.equals(want));

function main() {
  const files = buildFiles();
  const stale = [];
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(EXT, rel);
    const want = Buffer.isBuffer(content) ? content : Buffer.from(content);
    let have = null;
    try {
      have = fs.readFileSync(file);
    } catch {}
    if (have && same(have, want, !Buffer.isBuffer(content))) continue;
    if (CHECK) {
      stale.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, want);
    console.log(`wrote extension/${rel}`);
  }
  // src/shared에서 지운 모듈의 복사본도 지운다.
  const libShared = path.join(EXT, 'lib/shared');
  for (const name of fs.existsSync(libShared) ? fs.readdirSync(libShared) : []) {
    if (files[`lib/shared/${name}`] || name === 'vendor') continue;
    if (CHECK) stale.push(`lib/shared/${name} (남은 파일)`);
    else {
      fs.rmSync(path.join(libShared, name));
      console.log(`removed extension/lib/shared/${name}`);
    }
  }
  if (CHECK && stale.length) {
    console.error(`extension/ 이 src/와 다릅니다. npm run build:ext 를 실행해 주세요:\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
  console.log(CHECK ? 'extension/ 이 최신입니다.' : '확장 프로그램 폴더를 만들었습니다: extension/');
}

main();
