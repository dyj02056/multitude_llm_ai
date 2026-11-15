'use strict';

// 셀렉터 점검 도구 (v0.25.0):  npm run selectors:probe -- [서비스 id ...] [--fake] [--out 보고서.json] [--wait 초] [--show]
//
// 서비스마다 숨은 창으로 처음 화면(url)을 열고, 앱이 쓰는 셀렉터(입력창 · 보내기 버튼 · 중지 버튼 · 답변 · 로그아웃 단서)를
// 찾는지 shared/page.js pageSelectorReport로 살펴본다. 읽기만 한다 — 입력 · 클릭 · 보내기를 하지 않는다.
// 결과는 JSON 보고서(--out)와 터미널 요약, 입력창을 못 찾은 서비스는 remote/selectors.json에 넣을 틀(파일은 쓰지 않음)로 보여 준다.
//
//   MLA_PROFILE=<폴더>  그 프로필(앱의 로그인 쿠키, partition persist:shared)로 연다. 앱과 같은 폴더를 쓸 때는 앱을 먼저 끈다.
//   --fake              실제 사이트 대신 가짜 페이지(scripts/selectors-probe-lib.js fakePage)로 — 인터넷에 접속하지 않는다.
//
// [쉽게 말하면] AI 사이트 화면이 바뀌었는지 사람이 하나씩 열어 보지 않고, 앱의 "찾는 규칙"이 아직 맞는지 한 번에 확인하는 도구입니다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, session } = require('electron');
const { SERVICES } = require('../src/shared/services');
const { pageSelectorReport } = require('../src/shared/page');
const remoteCore = require('../src/shared/remote-core');
const L = require('./selectors-probe-lib');

const ROOT = path.join(__dirname, '..');
const args = L.parseArgs(process.argv.slice(2), SERVICES.map((s) => s.id));
const profile = process.env.MLA_PROFILE || null;
const POLL_MS = 1500;

// 앱(main.js)과 같은 브라우저 모습: 일반 크롬 UA, 자동화 표시 끔
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
app.userAgentFallback = CHROME_UA;
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
if (profile && !args.fake) app.setPath('userData', profile);

/** 점검할 서비스 목록: 앱 셀렉터 + (기본) 저장소의 remote/selectors.json — 사용자 앱이 받는 것과 같게 */
function servicesToProbe() {
  const list = JSON.parse(JSON.stringify(SERVICES));
  if (args.builtin) return { list, version: null };
  const file = args.remote || path.join(ROOT, 'remote', 'selectors.json');
  try {
    const data = remoteCore.sanitize(JSON.parse(fs.readFileSync(file, 'utf8')), list);
    if (!data) throw new Error('형식이 틀립니다');
    remoteCore.apply(list, remoteCore.snapshotBase(list), data.overrides);
    if (data.ignored.length) console.warn(`원격 셀렉터에서 무시한 항목: ${data.ignored.join(', ')}`);
    return { list, version: data.version };
  } catch (err) {
    console.warn(`원격 셀렉터를 읽지 못해 앱 셀렉터만 씁니다 (${file}): ${err.message}`);
    return { list, version: null };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 서비스 하나: 창을 열고 입력창이 보이거나 시간이 다 될 때까지 살펴본다 → summarize 결과 */
async function probeOne(ses, svc) {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: args.show,
    webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); // 팝업은 열지 않는다
  win.webContents.setAudioMuted(true);
  const code = `(${pageSelectorReport.toString()})(${JSON.stringify(L.probeConfig(svc))})`;
  try {
    await win.loadURL(svc.url).catch((err) => {
      // 사이트가 곧바로 다른 주소로 보내면(로그인 화면 등) 첫 요청이 취소로 끝난다 — 그 페이지를 그대로 살펴본다
      if (!/ERR_ABORTED/.test(err.message)) throw err;
    });
    const until = Date.now() + args.waitMs;
    let raw = null;
    for (;;) {
      raw = await win.webContents.executeJavaScript(code, true).catch(() => null);
      const inputSeen = raw && (raw.parts.input || []).some((c) => c.visible > 0);
      if (inputSeen || Date.now() >= until) break;
      await sleep(POLL_MS);
    }
    return L.summarize(svc, raw, raw ? null : '페이지를 읽지 못했습니다');
  } catch (err) {
    return L.summarize(svc, null, err.message);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** --fake: 모든 https 요청을 가짜 페이지로 바꾼 메모리 세션 (디스크 · 인터넷 사용 안 함) */
function fakeSession(list) {
  const ses = session.fromPartition('selectors-probe-fake');
  ses.protocol.handle('https', (req) => {
    const host = new URL(req.url).hostname;
    const svc = list.find((s) => s.hosts.some((h) => host === h || host.endsWith(`.${h}`)));
    if (!svc) return new Response('not found', { status: 404 });
    return new Response(L.fakePage(svc, L.fakeKind(svc.id)), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  return ses;
}

async function main() {
  if (args.help) {
    console.log(L.USAGE);
    return;
  }
  if (args.unknown.length) console.warn(`모르는 서비스 id는 건너뜁니다: ${args.unknown.join(', ')}`);
  const { list, version } = servicesToProbe();
  const ses = args.fake ? fakeSession(list) : session.fromPartition('persist:shared');
  console.log(
    args.fake
      ? '가짜 페이지로 점검합니다 (인터넷 접속 없음)'
      : `프로필: ${profile ? app.getPath('userData') : '빈 임시 프로필 (MLA_PROFILE이 없어 로그아웃 상태로 보일 수 있음)'}`,
  );
  const results = [];
  for (const id of args.ids) {
    const svc = list.find((s) => s.id === id);
    process.stdout.write(`  ${id} … `);
    const r = await probeOne(ses, svc);
    console.log(r.status);
    results.push(r);
  }
  const report = L.buildReport(results, {
    fake: args.fake,
    customProfile: !!profile,
    selectorsVersion: version,
    app: require('../package.json').version,
  });
  const out = path.resolve(args.out || path.join(os.tmpdir(), 'mla-selectors-probe.json'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log('');
  console.log(L.formatSummary(report));
  console.log(`\nJSON 보고서: ${out}`);
  const sk = L.patchSkeleton(report, { version: version || 0 });
  if (sk) {
    console.log('\n입력창을 못 찾은 서비스 — remote/selectors.json에 넣을 틀 (파일은 바꾸지 않았습니다, 고친 뒤 서명이 필요합니다):');
    console.log(JSON.stringify(sk.patch, null, 2));
    for (const n of sk.notes) console.log(`  - ${n}`);
  }
  process.exitCode = report.counts.fail || report.counts.error ? 1 : 0;
}

app.whenReady().then(() =>
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 2;
    })
    .finally(() => app.quit()),
);
app.on('window-all-closed', () => {}); // 서비스 사이에 창이 모두 닫혀도 끝내지 않는다 (main이 끝나면 quit)
