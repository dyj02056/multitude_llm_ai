'use strict';
// v0.10.1 안정성·보안 단위 테스트:  npm test
// [쉽게 말하면] 이번에 고친 것들이 맞게 동작하는지 확인합니다:
//   - 로그인 팝업 허용: 정규식이 아니라 호스트가 허용 목록과 정확히 같을 때만
//   - 업로드 나누기: 글자 수가 아니라 UTF-8 바이트 기준 (한글 큰 파일) + 서비스별 크기 한도
//   - 크롬 확장 프로젝트 id: 이름이 같은 두 폴더를 따로 저장, 예전 이름 기반 상태 옮기기
//   - Windows 앱 프로젝트 쓰기: 바로가기(링크)로 밖을 가리키면 거절, 첨부 조각은 항상 지움
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const S = require('../src/shared/services');
const U = require('../src/shared/project-upload');

const svc = (id) => S.SERVICES.find((s) => s.id === id);

// ---------- 로그인 팝업 ----------

test('로그인 팝업: 비슷한 주소·경로만 login인 주소는 거부, 허용 목록의 호스트는 허용', () => {
  const claude = svc('claude');
  for (const bad of [
    'https://evil.com/login',
    'https://evil.com/oauth/authorize',
    'https://x.com.evil.com/',
    'https://accounts.google.com.evil.com/',
    'https://evil-accounts.google.com/',
    'https://sub.accounts.google.com/',
    'https://accounts.google.com@evil.com/',
    'http://accounts.google.com/', // https만
    'javascript:alert(1)',
    'not a url',
  ]) {
    assert.equal(S.isAuthPopupUrl(claude, bad), false, bad);
  }
  for (const ok of ['https://accounts.google.com/o/oauth2/auth?x=1', 'https://appleid.apple.com/auth', 'https://claude.ai/login/callback', 'https://x.com/i/oauth2']) {
    assert.equal(S.isAuthPopupUrl(claude, ok), true, ok);
  }
});

test('로그인 팝업: 서비스의 authHosts는 그 서비스 패널에서만', () => {
  assert.equal(S.isAuthPopupUrl(svc('chatgpt'), 'https://auth.openai.com/authorize'), true);
  assert.equal(S.isAuthPopupUrl(svc('gemini'), 'https://auth.openai.com/authorize'), false);
  assert.equal(S.isAuthPopupUrl(svc('mistral'), 'https://v2.auth.mistral.ai/login'), true);
  assert.equal(S.isAuthPopupUrl(null, 'https://accounts.google.com/'), true); // 로그인 화면: 공용 도메인만
  assert.equal(S.isAuthPopupUrl(null, 'https://claude.ai/'), false);
});

test('main.js가 정규식 대신 isAuthPopupUrl로 팝업과 팝업 안 이동을 검사한다', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  assert.ok(!/AUTH_URL_RE/.test(src));
  assert.match(src, /setWindowOpenHandler\(\(\{ url \}\) => \{[\s\S]*?isAuthPopupUrl\(svc, url\)/);
  assert.match(src, /did-create-window[\s\S]*?will-navigate[\s\S]*?will-redirect/);
});

// ---------- 업로드: 바이트 기준 ----------

const bytes = (t) => Buffer.byteLength(t, 'utf8');
const proj = (files) => ({ name: 'demo', paths: files.map((f) => f.path) });

test('바이트로 나누기: 한글 글자를 중간에서 자르지 않고 한도 안', () => {
  const text = '가나다라마바사\n'.repeat(1000) + '긴줄'.repeat(5000);
  const parts = U.splitBytes(text, 4000);
  assert.equal(parts.join(''), text);
  for (const p of parts) assert.ok(bytes(p) <= 4000, `${bytes(p)}`);
  assert.equal(U.splitBytes('😀😀😀', 5).join(''), '😀😀😀'); // 서로게이트 쌍도 그대로
});

test('묶음 파일: 한글만 있는 큰 파일도 묶음 하나가 바이트 한도 안', () => {
  // 70만 글자 = 약 196만 바이트. 예전(글자 수 100만 기준)에는 한 묶음에 다 들어가 1MB를 넘었다.
  const files = [{ path: 'docs/ko.md', text: '한글문서내용입니다\n'.repeat(70000) }];
  const p = U.packContext({ project: proj(files), files, request: 'q' });
  assert.equal(p.attachments.length, 2);
  for (const a of p.attachments) assert.ok(bytes(a.text) <= U.BUNDLE_BYTES, `${a.name} ${bytes(a.text)}`);
  // 나눈 조각을 이어 붙이면 원래 내용이 모두 들어 있다
  const joined = p.attachments.map((a) => a.text).join('');
  assert.equal((joined.match(/한글문서내용입니다/g) || []).length, 70000);
  assert.match(p.attachments[0].text, /조각으로 나눔: 1\//);
});

test('묶음 파일: 서비스 파일 한도(budget.fileBytes)가 작으면 그 크기로 나눈다', () => {
  const files = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.txt`, text: '가'.repeat(20000) })); // 파일당 6만 바이트
  const budget = { files: 10, bytes: 50 * 1024 * 1024, fileBytes: 100 * 1024 };
  const p = U.packFollowUp({ files, budget });
  assert.ok(p.attachments.length >= 3);
  for (const a of p.attachments) assert.ok(bytes(a.text) <= 100 * 1024, `${a.name} ${bytes(a.text)}`);
  const u = U.packUpdate({ files, budget });
  for (const a of u.attachments) assert.ok(bytes(a.text) <= 100 * 1024);
});

test('서비스별 파일 한도: 없으면 공통 한도, 있으면 공통 한도 안에서', () => {
  assert.equal(S.fileBytesOf(svc('chatgpt')), S.ATTACH_LIMITS.maxFileBytes);
  assert.equal(S.fileBytesOf({ upload: { maxFileBytes: 1000 } }), 1000);
  assert.equal(S.fileBytesOf({ upload: { maxFileBytes: 1e12 } }), S.ATTACH_LIMITS.maxFileBytes);
});

// ---------- 크롬 확장: 프로젝트 id ----------

/** IndexedDB 흉내 (project-fs.js가 쓰는 만큼만) */
function fakeIndexedDB() {
  const data = new Map();
  const db = {
    createObjectStore() {},
    transaction() {
      const tx = {};
      const req = (fn) => {
        const r = {};
        setImmediate(() => {
          r.result = fn();
          tx.oncomplete?.();
        });
        return r;
      };
      tx.objectStore = () => ({
        get: (k) => req(() => data.get(k)),
        put: (v, k) => req(() => void data.set(k, v)),
        delete: (k) => req(() => void data.delete(k)),
      });
      return tx;
    },
  };
  return {
    data,
    open() {
      const r = {};
      setImmediate(() => {
        r.result = db;
        r.onsuccess?.();
      });
      return r;
    },
  };
}

function fakeStorage() {
  const data = {};
  return {
    data,
    local: {
      get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in data).map((k) => [k, data[k]])),
      set: async (obj) => Object.assign(data, obj),
      remove: async (k) => void delete data[k],
    },
  };
}

/** 폴더 핸들 흉내: 같은 실제 폴더(real)면 isSameEntry가 true */
const dirHandle = (name, real) => ({ kind: 'directory', name, real, isSameEntry: async (o) => o.real === real, queryPermission: async () => 'granted' });

function loadProjectFs({ idb = fakeIndexedDB(), storage = fakeStorage(), picks = [] } = {}) {
  const win = { showDirectoryPicker: async () => picks.shift() };
  const ctx = {
    window: win,
    indexedDB: idb,
    chrome: { storage },
    crypto: require('crypto').webcrypto,
    MLA: { projectIgnore: { looksBinary: () => false, MAX_FILE_BYTES: 1 }, patch: { safeRelPath: (p) => p, isGitInternal: () => false } },
    setTimeout,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/project-fs.js'), 'utf8'), ctx);
  return { api: win.MLA_PROJECT_FS, idb, storage, win, picks };
}

test('확장: 이름이 같은 두 폴더는 다른 id로 상태를 따로 저장', async () => {
  const env = loadProjectFs();
  const { api } = env;
  env.picks.push(dirHandle('app', 'C:/work/a/app'));
  const a = await api.pick();
  await api.saveState({ checked: ['a.js'] });
  env.picks.push(dirHandle('app', 'D:/other/app'));
  const b = await api.pick();
  await api.saveState({ checked: ['b.js'] });
  assert.equal(a.name, b.name);
  assert.notEqual(a.id, b.id);
  assert.deepEqual(await api.loadState(), { checked: ['b.js'] });

  // 같은 폴더를 다시 고르면 같은 id · 지난 상태
  env.picks.push(dirHandle('app', 'C:/work/a/app'));
  const a2 = await api.pick();
  assert.equal(a2.id, a.id);
  assert.deepEqual(await api.loadState(), { checked: ['a.js'] });

  // 탭을 새로 연 것처럼 다시 불러와도 지금 폴더가 이어진다
  const again = loadProjectFs({ idb: env.idb, storage: env.storage });
  const r = await again.api.restore();
  assert.equal(r.id, a.id);
  assert.deepEqual(await again.api.loadState(), { checked: ['a.js'] });

  await again.api.close();
  assert.equal(await again.api.loadState(), null);
  assert.equal(await again.api.restore(), null);
});

test('확장: 예전 버전의 이름 기반 상태(root 핸들 · project-state:이름)를 새 id로 옮긴다', async () => {
  const idb = fakeIndexedDB();
  const storage = fakeStorage();
  idb.data.set('root', dirHandle('legacy', '/x/legacy'));
  storage.data['project-state:legacy'] = { checked: ['old.js'] };
  const { api } = loadProjectFs({ idb, storage });
  const r = await api.restore();
  assert.equal(r.name, 'legacy');
  assert.match(r.id, /^p-/);
  assert.deepEqual(await api.loadState(), { checked: ['old.js'] });
  assert.ok(!('project-state:legacy' in storage.data));
  assert.ok(!idb.data.has('root'));
});

// ---------- Windows 앱: 프로젝트 쓰기 · 첨부 조각 ----------

/** electron 없이 main 쪽 모듈을 불러온다 (필요한 것만 가짜로) */
function requireWithFakeElectron(rel, electron) {
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'electron') return electron;
    return orig.call(this, req, ...rest);
  };
  try {
    const file = require.resolve(rel);
    delete require.cache[file];
    return require(file);
  } finally {
    Module._load = orig;
  }
}

test('앱 프로젝트 쓰기: 링크로 밖을 가리키는 파일·폴더는 거절, 안쪽 쓰기는 됨', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mla-p1-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'proj');
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'keep');
  let linked = true;
  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    fs.symlinkSync(outside, path.join(root, 'linkdir'), 'dir');
  } catch {
    linked = false; // Windows에서 링크를 만들 권한이 없으면 링크 검사는 건너뛴다
  }
  const project = requireWithFakeElectron('../src/main/project', { dialog: {}, app: { getPath: () => tmp } });
  await project.open(root);
  assert.equal(await project.writeFile('src/a.txt', 'hi'), true);
  assert.equal(fs.readFileSync(path.join(root, 'src/a.txt'), 'utf8'), 'hi');
  await assert.rejects(project.writeFile('../x.txt', 'no'));
  if (linked) {
    await assert.rejects(project.writeFile('link.txt', 'overwrite'));
    await assert.rejects(project.writeFile('linkdir/new.txt', 'no'));
    await assert.rejects(project.deleteFile('link.txt'));
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'keep');
    assert.ok(!fs.existsSync(path.join(outside, 'new.txt')));
  }
  project.close();
});

test('첨부: 옮기는 중 오류가 나도 페이지의 조각을 지운다', async () => {
  const attach = requireWithFakeElectron('../src/main/attach', {});
  const calls = [];
  let n = 0;
  const wc = {
    isDestroyed: () => false,
    getURL: () => 'https://chatgpt.com/',
    executeJavaScriptInIsolatedWorld: async (_w, [{ code }]) => {
      calls.push(code);
      if (++n === 2) throw new Error('page gone'); // 두 번째 조각에서 실패
      return true;
    },
  };
  const data = new TextEncoder().encode('hello').buffer;
  const res = await attach.attachFiles(wc, { ...svc('chatgpt'), upload: { methods: ['paste'] } }, [{ name: 'a.txt', type: 'text/plain', data }]);
  assert.equal(res.ok, false);
  assert.match(calls[calls.length - 1], /window\.__mlaParts = \{\}; if \(window\.__mlaFiles\) delete window\.__mlaFiles/);
});
