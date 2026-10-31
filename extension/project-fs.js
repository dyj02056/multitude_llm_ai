'use strict';

// 프로젝트 모드: 사용자가 고른 로컬 폴더를 읽고 쓴다 (크롬 확장 쪽, File System Access API).
// Windows 앱의 src/main/project.js와 같은 일을 한다. host.js가 window.host.project로 화면에 넘긴다.
// 고른 폴더(핸들)는 IndexedDB에 기억하지만, 크롬 정책상 탭을 새로 열면 "폴더 접근 허용"을 한 번 다시 눌러야 한다.

// [쉽게 말하면] 크롬 확장에서 프로젝트 폴더를 읽고 쓰는 "파일 담당자"입니다 (Windows 앱의 src/main/project.js와 같은 일).
// 크롬의 "파일 시스템 접근" 기능을 써서, 사용자가 허락한 폴더 안에서만 읽고 씁니다.
// 폴더 밖 경로, .git 안쪽 쓰기는 Windows 앱과 똑같이 거절합니다.
(() => {
  const { looksBinary, MAX_FILE_BYTES } = MLA.projectIgnore;
  const { safeRelPath, isGitInternal } = MLA.patch;

  const DB = 'mla-project';
  const STORE = 'handles';
  const KNOWN = 'known'; // [{ id, handle }] 지금까지 연 폴더 (같은 폴더면 같은 id를 다시 쓴다)
  const CURRENT = 'current'; // 지금 연 폴더의 id
  const LEGACY_ROOT = 'root'; // 예전 버전(~v0.10.0): 폴더 핸들만 저장
  const MAX_KNOWN = 50;
  let rootHandle = null;
  let rootId = null;

  // IndexedDB: 브라우저 안의 작은 데이터베이스. 고른 폴더(핸들)를 기억해 두는 데 씁니다.
  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbDo(mode, fn) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  }

  const idbGet = (key) => idbDo('readonly', (s) => s.get(key));
  const idbSet = (key, value) => idbDo('readwrite', (s) => s.put(value, key));
  const idbDel = (key) => idbDo('readwrite', (s) => s.delete(key));

  // 프로젝트 id: 폴더 이름이 아니라 처음 열 때 만든 고유 값. 이름이 같은 두 폴더도 상태를 따로 저장한다.
  const newId = () =>
    `p-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;

  const info = () => (rootHandle ? { name: rootHandle.name, id: rootId } : null);
  const permission = async (h, ask) => {
    if (typeof h.queryPermission !== 'function') return 'granted';
    const state = await h.queryPermission({ mode: 'readwrite' });
    if (state === 'granted' || !ask) return state;
    return h.requestPermission({ mode: 'readwrite' });
  };

  const knownList = async () => {
    const list = await idbGet(KNOWN).catch(() => null);
    return Array.isArray(list) ? list.filter((e) => e && typeof e.id === 'string' && e.handle) : [];
  };

  /** 이미 연 적이 있는 폴더인지 isSameEntry()로 찾는다 (이름이 아니라 실제 같은 폴더인지) */
  async function findKnown(list, h) {
    for (const e of list) {
      try {
        if (await e.handle.isSameEntry(h)) return e;
      } catch {}
    }
    return null;
  }

  // ~v0.10.0은 화면이 id 없이 저장을 불러 모든 프로젝트의 상태가 이 키 하나에 들어 있었다 (가장 최근에 쓴 프로젝트의 상태)
  const LEGACY_STATE_KEY = 'project-state:undefined';

  /**
   * 예전 상태가 있으면 새 id로 옮긴다 (새 id에 상태가 없을 때만, 한 번).
   * 폴더 이름 키(project-state:폴더이름)가 먼저, 없으면 예전 버전이 실제로 쓰던 키 하나(LEGACY_STATE_KEY)를
   * 업데이트 뒤 처음 여는 폴더에 옮긴다 — 예전 버전은 마지막에 연 폴더만 기억했으므로 보통 그 폴더다.
   */
  async function migrateState(name, id) {
    try {
      const nameKey = stateKey(name);
      const got = await chrome.storage.local.get([nameKey, LEGACY_STATE_KEY, stateKey(id)]);
      if (got[stateKey(id)]) return;
      const oldKey = got[nameKey] ? nameKey : got[LEGACY_STATE_KEY] ? LEGACY_STATE_KEY : null;
      if (!oldKey) return;
      await chrome.storage.local.set({ [stateKey(id)]: got[oldKey] });
      await chrome.storage.local.remove(oldKey);
    } catch {}
  }

  /** 폴더 핸들의 id를 정하고(같은 폴더면 예전 id) 지금 폴더로 기억한다 → id */
  async function remember(h) {
    const list = await knownList();
    let entry = await findKnown(list, h);
    const fresh = !entry;
    if (!entry) entry = { id: newId(), handle: h };
    const rest = list.filter((e) => e !== entry);
    await idbSet(KNOWN, [{ id: entry.id, handle: h }, ...rest].slice(0, MAX_KNOWN));
    await idbSet(CURRENT, entry.id);
    if (fresh) await migrateState(h.name, entry.id);
    return entry.id;
  }

  /** 지금 폴더 { id, handle } (예전 버전의 'root' 저장값은 새 방식으로 옮긴다) */
  async function currentEntry() {
    const legacy = await idbGet(LEGACY_ROOT).catch(() => null);
    if (legacy && typeof legacy === 'object' && legacy.kind === 'directory') {
      await remember(legacy);
      await idbDel(LEGACY_ROOT).catch(() => {});
    }
    const id = await idbGet(CURRENT).catch(() => null);
    if (!id) return null;
    return (await knownList()).find((e) => e.id === id) || null;
  }

  async function pick() {
    if (typeof window.showDirectoryPicker !== 'function') throw new Error('이 크롬에서는 폴더 열기를 쓸 수 없습니다');
    let h;
    try {
      h = await window.showDirectoryPicker({ id: 'mla-project', mode: 'readwrite' });
    } catch (err) {
      if (err.name === 'AbortError') return null; // 사용자가 취소
      throw err;
    }
    rootId = await remember(h);
    rootHandle = h;
    return info();
  }

  /** 지난번 폴더. 접근 허용이 다시 필요하면 { name, needsPermission: true } */
  async function restore() {
    const e = await currentEntry();
    if (!e) return null;
    if ((await permission(e.handle, false)) === 'granted') {
      rootHandle = e.handle;
      rootId = e.id;
      return info();
    }
    return { name: e.handle.name, id: e.id, needsPermission: true };
  }

  /** "폴더 접근 다시 허용" (버튼을 눌렀을 때만 부를 수 있다) */
  async function reconnect() {
    const e = await currentEntry();
    if (!e) return null;
    if ((await permission(e.handle, true)) !== 'granted') throw new Error('폴더 접근을 허용하지 않았습니다');
    rootHandle = e.handle;
    rootId = e.id;
    return info();
  }

  // 닫아도 연 적 있는 폴더 목록(KNOWN)은 남긴다 — 다시 열면 같은 id로 지난 상태를 이어 쓴다.
  async function close() {
    rootHandle = null;
    rootId = null;
    await idbDel(CURRENT).catch(() => {});
  }

  // 상대 경로를 안전하게 다듬어 폴더 이름 조각 목록으로 나눕니다 (밖으로 나가는 경로면 오류).
  function parts(rel) {
    if (rel === '') return [];
    const clean = safeRelPath(rel);
    if (clean === null) throw new Error(`허용되지 않는 경로입니다: ${rel}`);
    return clean.split('/');
  }

  // 경로 조각을 따라 폴더를 찾아 들어갑니다. create가 true면 없는 폴더를 만듭니다.
  async function dirHandle(segs, create = false) {
    if (!rootHandle) throw new Error('프로젝트가 열려 있지 않습니다');
    let h = rootHandle;
    for (const s of segs) h = await h.getDirectoryHandle(s, { create });
    return h;
  }

  async function readDir(rel) {
    const h = await dirHandle(parts(rel));
    const out = [];
    for await (const [name, e] of h.entries()) {
      if (e.kind === 'directory') out.push({ name, kind: 'dir', size: 0 });
      else {
        let size = 0;
        try {
          size = (await e.getFile()).size;
        } catch {}
        out.push({ name, kind: 'file', size });
      }
    }
    return out;
  }

  const notFound = (err) => err && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError');

  async function readFile(rel, { maxBytes = MAX_FILE_BYTES } = {}) {
    const segs = parts(rel);
    let file;
    try {
      const dir = await dirHandle(segs.slice(0, -1));
      file = await (await dir.getFileHandle(segs[segs.length - 1])).getFile();
    } catch (err) {
      if (notFound(err)) return { missing: true };
      throw err;
    }
    if (file.size > maxBytes) return { tooLarge: true, size: file.size };
    if (looksBinary(new Uint8Array(await file.slice(0, 8192).arrayBuffer()))) return { binary: true, size: file.size };
    return { text: await file.text(), size: file.size };
  }

  // git 내부(.git 안쪽)에는 쓰거나 지우지 않는다 (훅·설정으로 코드가 실행될 수 있음)
  function refuseGitInternal(rel) {
    if (isGitInternal(rel)) throw new Error(`git 내부 파일은 바꿀 수 없습니다: ${rel}`);
  }

  /** 파일 쓰기 (필요한 폴더는 만듦). .git 안쪽에는 쓰지 않습니다. */
  async function writeFile(rel, text) {
    if (typeof text !== 'string') throw new Error('쓸 내용이 없습니다');
    refuseGitInternal(rel);
    const segs = parts(rel);
    const dir = await dirHandle(segs.slice(0, -1), true);
    const fh = await dir.getFileHandle(segs[segs.length - 1], { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
    return true;
  }

  async function deleteFile(rel) {
    refuseGitInternal(rel);
    const segs = parts(rel);
    const dir = await dirHandle(segs.slice(0, -1));
    await dir.removeEntry(segs[segs.length - 1]);
    return true;
  }

  // 프로젝트별 상태는 지금 연 폴더의 id로 저장한다 (화면은 id 없이 loadState() · saveState(data)로 부른다 — Windows 앱과 같음).
  function stateKey(id) {
    return `project-state:${id}`;
  }
  async function loadState() {
    if (!rootId) return null;
    try {
      return (await chrome.storage.local.get(stateKey(rootId)))[stateKey(rootId)] || null;
    } catch {
      return null;
    }
  }
  async function saveState(data) {
    if (!rootId) return false;
    await chrome.storage.local.set({ [stateKey(rootId)]: data });
    return true;
  }

  window.MLA_PROJECT_FS = {
    pick,
    restore,
    reconnect,
    close,
    readDir,
    readFile,
    writeFile,
    deleteFile,
    globalExclude: async () => null, // 확장 프로그램은 git 설정을 읽을 수 없다
    loadState,
    saveState,
  };
})();
