'use strict';

// 프로젝트 모드: 사용자가 고른 로컬 폴더를 읽고 쓴다 (크롬 확장 쪽, File System Access API).
// Windows 앱의 src/main/project.js와 같은 일을 한다. host.js가 window.host.project로 화면에 넘긴다.
// 고른 폴더(핸들)는 IndexedDB에 기억하지만, 크롬 정책상 탭을 새로 열면 "폴더 접근 허용"을 한 번 다시 눌러야 한다.

(() => {
  const { looksBinary, MAX_FILE_BYTES } = MLA.projectIgnore;
  const { safeRelPath } = MLA.patch;

  const DB = 'mla-project';
  const STORE = 'handles';
  let rootHandle = null;

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

  const info = () => (rootHandle ? { name: rootHandle.name, id: rootHandle.name } : null);
  const permission = async (h, ask) => {
    if (typeof h.queryPermission !== 'function') return 'granted';
    const state = await h.queryPermission({ mode: 'readwrite' });
    if (state === 'granted' || !ask) return state;
    return h.requestPermission({ mode: 'readwrite' });
  };

  async function pick() {
    if (typeof window.showDirectoryPicker !== 'function') throw new Error('이 크롬에서는 폴더 열기를 쓸 수 없습니다');
    let h;
    try {
      h = await window.showDirectoryPicker({ id: 'mla-project', mode: 'readwrite' });
    } catch (err) {
      if (err.name === 'AbortError') return null; // 사용자가 취소
      throw err;
    }
    rootHandle = h;
    await idbSet('root', h);
    return info();
  }

  /** 지난번 폴더. 접근 허용이 다시 필요하면 { name, needsPermission: true } */
  async function restore() {
    const h = await idbGet('root').catch(() => null);
    if (!h) return null;
    if ((await permission(h, false)) === 'granted') {
      rootHandle = h;
      return info();
    }
    return { name: h.name, id: h.name, needsPermission: true };
  }

  /** "폴더 접근 다시 허용" (버튼을 눌렀을 때만 부를 수 있다) */
  async function reconnect() {
    const h = await idbGet('root');
    if (!h) return null;
    if ((await permission(h, true)) !== 'granted') throw new Error('폴더 접근을 허용하지 않았습니다');
    rootHandle = h;
    return info();
  }

  async function close() {
    rootHandle = null;
    await idbDel('root').catch(() => {});
  }

  function parts(rel) {
    if (rel === '') return [];
    const clean = safeRelPath(rel);
    if (clean === null) throw new Error(`허용되지 않는 경로입니다: ${rel}`);
    return clean.split('/');
  }

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

  async function writeFile(rel, text) {
    if (typeof text !== 'string') throw new Error('쓸 내용이 없습니다');
    const segs = parts(rel);
    const dir = await dirHandle(segs.slice(0, -1), true);
    const fh = await dir.getFileHandle(segs[segs.length - 1], { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
    return true;
  }

  async function deleteFile(rel) {
    const segs = parts(rel);
    const dir = await dirHandle(segs.slice(0, -1));
    await dir.removeEntry(segs[segs.length - 1]);
    return true;
  }

  const stateKey = (id) => `project-state:${id}`;
  async function loadState(id) {
    try {
      return (await chrome.storage.local.get(stateKey(id)))[stateKey(id)] || null;
    } catch {
      return null;
    }
  }
  async function saveState(id, data) {
    await chrome.storage.local.set({ [stateKey(id)]: data });
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
