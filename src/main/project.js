'use strict';

// 프로젝트 모드: 사용자가 고른 로컬 폴더를 읽고 쓴다 (Windows 앱 쪽).
// 화면은 파일 목록·내용을 받아 공통 모듈(shared/project-ignore · project-context · patch)로 제외 규칙·맥락·diff를 처리하고,
// 여기서는 "고른 폴더 안에서만" 읽기·쓰기·지우기를 해 준다. 경로는 상대 경로만 받고, 바로가기 링크로 밖에 나가는 것도 막는다.

// [쉽게 말하면]
// 사용자가 고른 "프로젝트 폴더" 안의 파일을 읽고, 쓰고, 지우는 "파일 담당자"입니다 (Windows 앱).
// 가장 중요한 약속: 고른 폴더 "밖"의 파일은 절대 건드리지 않습니다.
//   - '../' 같은 경로로 바깥으로 나가려 하면 거절
//   - 바로가기(링크)가 바깥을 가리켜도 거절
//   - .git 폴더 안(코드 실행 설정이 있는 곳)에는 쓰지 않음
// 크롬 확장 프로그램에서는 extension/project-fs.js가 같은 일을 합니다.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { dialog, app } = require('electron');
const { looksBinary, MAX_FILE_BYTES } = require('../shared/project-ignore');
const { safeRelPath, isGitInternal } = require('../shared/patch');

// 화면이 읽기 한도(maxBytes)를 정해 보낼 때 앱 쪽에서 허용하는 최대값 (수정안 · 테스트 실행 원본 읽기가 5MB를 쓴다)
const READ_MAX_BYTES = 5 * 1024 * 1024;

let root = null; // 고른 폴더 (절대 경로)
let realRoot = null; // 바로가기 링크를 푼 실제 경로

const info = () => (root ? { name: path.basename(root) || root, id: root } : null);

/** 폴더를 프로젝트로 엽니다. 폴더가 맞는지 확인하고, 바로가기를 푼 실제 위치도 기억합니다. */
async function open(dir) {
  const abs = path.resolve(dir);
  const st = await fsp.stat(abs);
  if (!st.isDirectory()) throw new Error('폴더가 아닙니다');
  root = abs;
  realRoot = await fsp.realpath(abs);
  return info();
}

/** 폴더 선택 창을 띄워 사용자가 고르게 합니다. 취소하면 null. */
async function pick(win) {
  const r = await dialog.showOpenDialog(win, { title: '프로젝트 폴더 선택', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths?.[0]) return null;
  return open(r.filePaths[0]);
}

function close() {
  root = null;
  realRoot = null;
}

// 어떤 실제 경로가 프로젝트 폴더 안쪽인지 확인하는 도우미
const inside = (real) => real === realRoot || real.startsWith(realRoot + path.sep);

/** 상대 경로를 프로젝트 안의 절대 경로로. 밖으로 나가면(.., 절대 경로, 링크) 오류 */
async function resolveSafe(rel) {
  if (!root) throw new Error('프로젝트가 열려 있지 않습니다');
  const clean = rel === '' ? '' : safeRelPath(rel);
  if (clean === null) throw new Error(`허용되지 않는 경로입니다: ${rel}`);
  const abs = path.join(root, clean);
  // 있는 가장 가까운 상위 경로의 실제 위치가 프로젝트 안이어야 한다 (링크로 밖을 가리키는 경우 차단).
  let probe = abs;
  for (;;) {
    try {
      if (!inside(await fsp.realpath(probe))) throw new Error(`프로젝트 밖을 가리키는 경로입니다: ${rel}`);
      return abs;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const up = path.dirname(probe);
      if (up === probe) throw err;
      probe = up;
    }
  }
}

// 파일 크기를 알아볼 때 한꺼번에 여는 최대 수 (파일이 많은 폴더에서 하나씩 기다리지 않되, 너무 많이 열지 않게)
const STAT_CONCURRENCY = 16;

/** 폴더 안의 항목 목록: 이름, 종류(파일·폴더·바로가기), 크기 */
async function readDir(rel) {
  const abs = await resolveSafe(rel);
  const ents = await fsp.readdir(abs, { withFileTypes: true });
  // 순서는 readdir 그대로. 파일 크기만 여러 개를 함께 알아본 뒤 같은 자리에 채운다.
  const out = new Array(ents.length).fill(null);
  const files = [];
  ents.forEach((d, i) => {
    if (d.isSymbolicLink()) out[i] = { name: d.name, kind: 'link', size: 0 };
    else if (d.isDirectory()) out[i] = { name: d.name, kind: 'dir', size: 0 };
    else if (d.isFile()) files.push(i);
  });
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = files[next++];
      let size = 0;
      try {
        size = (await fsp.stat(path.join(abs, ents[i].name))).size;
      } catch {}
      out[i] = { name: ents[i].name, kind: 'file', size };
    }
  };
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, files.length) }, worker));
  return out.filter(Boolean); // 그 밖의 종류(장치 파일 등)는 예전처럼 뺀다
}

/** → { text, size } | { binary, size } | { tooLarge, size } | { missing } */
// 파일 읽기. 너무 크거나(기본 1MB 초과) 그림·실행 파일 같은 바이너리면 내용 대신 그 사실만 알려 줍니다.
async function readFile(rel, { maxBytes = MAX_FILE_BYTES } = {}) {
  const abs = await resolveSafe(rel);
  let st;
  try {
    st = await fsp.stat(abs);
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: true };
    throw err;
  }
  if (!st.isFile()) return { missing: true };
  if (st.size > maxBytes) return { tooLarge: true, size: st.size };
  const buf = await fsp.readFile(abs);
  if (looksBinary(buf)) return { binary: true, size: st.size };
  return { text: buf.toString('utf8'), size: st.size };
}

/** git 내부(.git 안쪽)에는 쓰거나 지우지 않는다 (훅·설정으로 코드가 실행될 수 있음) */
function refuseGitInternal(rel) {
  if (isGitInternal(rel)) throw new Error(`git 내부 파일은 바꿀 수 없습니다: ${rel}`);
}

/**
 * 쓰기·지우기 바로 직전 검사: 상위 폴더의 실제 위치가 프로젝트 안인지, 대상이 바로가기(링크)가 아닌지 다시 본다.
 * resolveSafe 뒤에 다른 프로그램이 폴더를 링크로 바꿔 치기하는 경우를 줄이기 위해서다.
 */
async function recheckTarget(abs, rel) {
  const parentReal = await fsp.realpath(path.dirname(abs));
  if (!inside(parentReal)) throw new Error(`프로젝트 밖을 가리키는 경로입니다: ${rel}`);
  try {
    const st = await fsp.lstat(abs);
    if (st.isSymbolicLink()) throw new Error(`바로가기(링크) 파일은 바꿀 수 없습니다: ${rel}`);
    if (st.isDirectory()) throw new Error(`폴더입니다: ${rel}`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return path.join(parentReal, path.basename(abs));
}

/** 파일 쓰기 (없으면 새로 만들고, 필요한 상위 폴더도 만듦). 쓰기 직전에 실제 경로가 프로젝트 안쪽인지 다시 확인합니다. */
async function writeFile(rel, text) {
  if (typeof text !== 'string') throw new Error('쓸 내용이 없습니다');
  refuseGitInternal(rel);
  const abs = await resolveSafe(rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await resolveSafe(rel); // 폴더를 만든 뒤에도 안쪽인지 다시 본다
  const target = await recheckTarget(abs, rel); // 쓰기 바로 직전: 실제 상위 폴더 기준 경로
  await atomicWrite(target, text);
  return true;
}

// 쓰는 도중 임시 파일 이름: 같은 폴더의 ".<이름>.mla-tmp-<무작위>" (다 쓰면 원래 이름으로 바꾼다)
const TMP_MARK = '.mla-tmp-';
const tmpNameFor = (target) => path.join(path.dirname(target), `.${path.basename(target)}${TMP_MARK}${crypto.randomBytes(6).toString('hex')}`);

/**
 * 한 번에 바꿔 쓰기: 같은 폴더의 임시 파일에 다 쓴 뒤 이름 바꾸기(rename)로 원래 파일을 덮는다.
 * 쓰다가 멈추거나 디스크가 꽉 차도 원래 파일은 반쯤 쓴 상태로 남지 않는다. 실패하면 임시 파일을 지운다.
 */
async function atomicWrite(target, text) {
  const tmp = tmpNameFor(target);
  try {
    // 원래 파일의 권한(실행 권한 등)은 그대로 둔다 (Windows에서는 의미 없음)
    let mode;
    try {
      mode = (await fsp.stat(target)).mode & 0o7777;
    } catch {}
    // 'wx': 같은 이름이 이미 있으면(링크 바꿔치기 포함) 쓰지 않는다
    await fsp.writeFile(tmp, text, { encoding: 'utf8', flag: 'wx', ...(mode === undefined ? {} : { mode }) });
    await renameRetry(tmp, target);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Windows에서는 다른 프로그램(백신 · 편집기)이 잠깐 파일을 잡고 있으면 이름 바꾸기가 실패하므로 몇 번 다시 해 본다 */
async function renameRetry(from, to, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      return await fsp.rename(from, to);
    } catch (err) {
      if (i >= tries - 1 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
}

/** 파일 지우기 (휴지통이 아니라 바로 지워짐 — 화면은 지우기 전에 확인을 받고, 적용 기록으로 되돌릴 수 있게 원본을 남깁니다). */
async function deleteFile(rel) {
  refuseGitInternal(rel);
  const abs = await resolveSafe(rel);
  const target = await recheckTarget(abs, rel);
  await fsp.unlink(target);
  return true;
}

/** git 전역 제외 파일 (core.excludesFile, 없으면 ~/.config/git/ignore) → { source, content } | null */
// git에서 "모든 저장소 공통으로 빼는 파일" 목록을 읽어, AI에게 보내지 않을 파일을 정하는 데 씁니다.
async function globalExclude() {
  const configured = await new Promise((resolve) => {
    execFile('git', ['config', '--get', 'core.excludesFile'], { timeout: 3000, windowsHide: true }, (err, out) =>
      resolve(err ? '' : String(out).trim()),
    );
  });
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const candidates = [configured.replace(/^~(?=$|[\\/])/, os.homedir()), path.join(xdg, 'git', 'ignore')].filter(Boolean);
  for (const file of candidates) {
    try {
      const content = await fsp.readFile(file, 'utf8');
      return { source: 'git 전역 제외 파일', content };
    } catch {}
  }
  return null;
}

// 프로젝트별 상태(켠 L3 규칙, 고른 파일, 적용 기록)는 사용자 데이터 폴더에 저장한다.
const stateFile = (id) =>
  path.join(app.getPath('userData'), 'projects', `${crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 16)}.json`);

/** 이 프로젝트의 지난 상태(고른 파일, 켠 규칙, 적용 기록 등)를 불러옵니다. 없으면 null. */
async function loadState(id) {
  return require('./secure-store').store().readJsonAsync(stateFile(id), null); // 암호화 (v0.22.1) — 적용 기록의 원본도 들어 있다
}

/** 이 프로젝트의 상태를 저장합니다. 파일 이름은 폴더 경로를 짧은 암호(sha1)로 바꾼 것입니다. */
async function saveState(id, data) {
  await require('./secure-store').store().writeJsonAsync(stateFile(id), data);
  return true;
}

module.exports = { READ_MAX_BYTES, TMP_MARK, pick, open, close, info, readDir, readFile, writeFile, deleteFile, globalExclude, loadState, saveState };
