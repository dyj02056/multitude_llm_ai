'use strict';

// 프로젝트 모드: 사용자가 고른 로컬 폴더를 읽고 쓴다 (Windows 앱 쪽).
// 화면은 파일 목록·내용을 받아 공통 모듈(shared/project-ignore · project-context · patch)로 제외 규칙·맥락·diff를 처리하고,
// 여기서는 "고른 폴더 안에서만" 읽기·쓰기·지우기를 해 준다. 경로는 상대 경로만 받고, 바로가기 링크로 밖에 나가는 것도 막는다.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { dialog, app } = require('electron');
const { looksBinary, MAX_FILE_BYTES } = require('../shared/project-ignore');
const { safeRelPath, isGitInternal } = require('../shared/patch');

let root = null; // 고른 폴더 (절대 경로)
let realRoot = null; // 바로가기 링크를 푼 실제 경로

const info = () => (root ? { name: path.basename(root) || root, id: root } : null);

async function open(dir) {
  const abs = path.resolve(dir);
  const st = await fsp.stat(abs);
  if (!st.isDirectory()) throw new Error('폴더가 아닙니다');
  root = abs;
  realRoot = await fsp.realpath(abs);
  return info();
}

async function pick(win) {
  const r = await dialog.showOpenDialog(win, { title: '프로젝트 폴더 선택', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths?.[0]) return null;
  return open(r.filePaths[0]);
}

function close() {
  root = null;
  realRoot = null;
}

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

async function readDir(rel) {
  const abs = await resolveSafe(rel);
  const ents = await fsp.readdir(abs, { withFileTypes: true });
  const out = [];
  for (const d of ents) {
    if (d.isSymbolicLink()) out.push({ name: d.name, kind: 'link', size: 0 });
    else if (d.isDirectory()) out.push({ name: d.name, kind: 'dir', size: 0 });
    else if (d.isFile()) {
      let size = 0;
      try {
        size = (await fsp.stat(path.join(abs, d.name))).size;
      } catch {}
      out.push({ name: d.name, kind: 'file', size });
    }
  }
  return out;
}

/** → { text, size } | { binary, size } | { tooLarge, size } | { missing } */
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

async function writeFile(rel, text) {
  if (typeof text !== 'string') throw new Error('쓸 내용이 없습니다');
  refuseGitInternal(rel);
  const abs = await resolveSafe(rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await resolveSafe(rel); // 폴더를 만든 뒤에도 안쪽인지 다시 본다
  await fsp.writeFile(abs, text, 'utf8');
  return true;
}

async function deleteFile(rel) {
  refuseGitInternal(rel);
  const abs = await resolveSafe(rel);
  await fsp.unlink(abs);
  return true;
}

/** git 전역 제외 파일 (core.excludesFile, 없으면 ~/.config/git/ignore) → { source, content } | null */
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

async function loadState(id) {
  try {
    return JSON.parse(await fsp.readFile(stateFile(id), 'utf8'));
  } catch {
    return null;
  }
}

async function saveState(id, data) {
  const file = stateFile(id);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data));
  return true;
}

module.exports = { pick, open, close, info, readDir, readFile, writeFile, deleteFile, globalExclude, loadState, saveState };
