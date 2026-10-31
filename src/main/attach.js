'use strict';

// 공통 입력창에 올린 파일을 서비스 패널에 첨부한다.
//
// 1) 파일 내용을 패널 페이지의 격리된 공간(isolated world — 사이트 스크립트가 볼 수 없는 곳)으로 나눠 옮기고
//    File로 되살린 뒤, shared/page.js의 pageAttachFiles로 붙여넣기 · 파일 선택 칸 · 끌어다 놓기를 차례로 시도한다.
// 2) 그래도 안 되면 크롬 개발자 프로토콜(DOM.setFileInputFiles)로 파일 선택 칸에 직접 넣는다.
//    사람이 파일을 고른 것과 똑같은(신뢰된) 이벤트가 나서, 자바스크립트로 넣은 파일을 무시하는 사이트도 받는다.

// [쉽게 말하면]
// 사용자가 입력창에 올린 사진·문서를 각 AI 사이트의 "파일 첨부" 칸에 대신 넣어 주는 파일입니다.
// 사람이 하는 방법(붙여넣기 → 파일 고르기 → 끌어다 놓기)을 차례로 흉내 내고,
// 그래도 안 되면 브라우저의 개발자 기능으로 파일 고르기 칸에 직접 넣습니다.
// "격리된 공간"은 사이트의 자바스크립트가 들여다볼 수 없는 별도의 방이라, 파일 내용이 사이트 코드와 섞이지 않습니다.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pageAttachFiles } = require('../shared/page');
const { uploadOf, isServiceUrl } = require('../shared/services');
const { log } = require('./dev');

const WORLD = 1001; // 첨부용 격리 공간 번호 (사이트 스크립트와 분리)
const CHUNK = 2 * 1024 * 1024; // 한 번에 옮기는 base64 글자 수
const TEMP_TTL_MS = 10 * 60 * 1000; // 개발자 프로토콜용 임시 파일을 지울 때까지
// 임시 파일은 이 앱 전용 폴더 안에만 만들고, 앱 시작·종료 때 통째로 지운다 (중간에 앱이 꺼져도 남지 않게).
const TEMP_ROOT = path.join(os.tmpdir(), 'multitude-llm-attach');

/** 첨부용 임시 폴더를 통째로 지웁니다 (앱을 켤 때와 끌 때). 실패해도 앱은 계속 돌아갑니다. */
function cleanupTemp() {
  try {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch (err) {
    log('attach', 'temp cleanup failed', err.message);
  }
}

// 패널 페이지의 격리 공간에서 자바스크립트 한 덩어리를 실행하는 짧은 도우미
const inWorld = (wc, code) => wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }], true);

/** 파일을 격리 공간의 window.__mlaFiles[key]에 File 배열로 만든다. */
// 파일은 글자(base64)로 바꿔 2MB씩 조각내어 보낸 뒤, 페이지 안에서 다시 이어 붙여 File로 되살립니다.
// 한 번에 큰 덩어리를 보내면 느리거나 실패할 수 있어서 나눠 보냅니다.
async function transfer(wc, key, files) {
  await inWorld(wc, `(window.__mlaParts = {}, window.__mlaFiles = window.__mlaFiles || {}, true)`);
  for (let i = 0; i < files.length; i++) {
    const b64 = Buffer.from(files[i].data).toString('base64');
    for (let at = 0; at < b64.length; at += CHUNK) {
      const piece = JSON.stringify(b64.slice(at, at + CHUNK));
      await inWorld(wc, `((window.__mlaParts[${i}] = window.__mlaParts[${i}] || []).push(${piece}), true)`);
    }
  }
  const meta = JSON.stringify(files.map(({ name, type, lastModified }) => ({ name, type, lastModified })));
  await inWorld(
    wc,
    `(() => {
      const meta = ${meta};
      window.__mlaFiles[${JSON.stringify(key)}] = meta.map((m, i) => {
        const bin = atob((window.__mlaParts[i] || []).join(''));
        const bytes = new Uint8Array(bin.length);
        for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
        return new File([bytes], m.name, { type: m.type, lastModified: m.lastModified || Date.now() });
      });
      window.__mlaParts = {};
      return true;
    })()`,
  );
}

/** 격리 공간에 옮겨 둔 조각(__mlaParts)과 이번 파일(__mlaFiles[key])을 지운다. 페이지가 이미 닫혔으면 조용히 넘어간다. */
async function clearTransfer(wc, key) {
  try {
    if (wc.isDestroyed()) return;
    await inWorld(
      wc,
      `(() => { window.__mlaParts = {}; if (window.__mlaFiles) delete window.__mlaFiles[${JSON.stringify(key)}]; return true; })()`,
    );
  } catch (err) {
    log('attach', 'cleanup failed', err.message);
  }
}

/** 개발자 프로토콜로 파일 선택 칸에 넣는다. 성공하면 true */
// 마지막 수단: 파일을 잠깐 임시 폴더에 저장하고, 개발자 기능으로 사이트의 파일 고르기 칸에 그 경로를 넣습니다.
// 임시 파일은 10분 뒤 지웁니다.
async function attachWithDebugger(wc, svc, files) {
  if (!isServiceUrl(svc, wc.getURL())) return false; // 서비스 밖 사이트의 파일 선택 칸에는 넣지 않는다
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TEMP_ROOT, 'files-'));
  // 사이트가 보는 파일 이름이 원래 이름과 같도록 파일마다 하위 폴더를 만든다 (같은 이름 파일이 여럿이어도 된다).
  const paths = files.map((f, i) => {
    fs.mkdirSync(path.join(dir, String(i)));
    const file = path.join(dir, String(i), path.basename(f.name).replace(/[\\/:*?"<>|]/g, '_') || 'file');
    fs.writeFileSync(file, Buffer.from(f.data));
    return file;
  });
  setTimeout(() => fs.rm(dir, { recursive: true, force: true }, () => {}), TEMP_TTL_MS);

  const dbg = wc.debugger;
  const attachedHere = !dbg.isAttached();
  try {
    if (attachedHere) dbg.attach('1.3');
    const { root } = await dbg.sendCommand('DOM.getDocument', { depth: 0 });
    for (const selector of uploadOf(svc).fileInput) {
      const { nodeIds } = await dbg.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
      if (!nodeIds.length) continue;
      if (!isServiceUrl(svc, wc.getURL())) return false;
      await dbg.sendCommand('DOM.setFileInputFiles', { nodeId: nodeIds[0], files: paths });
      return true;
    }
    return false;
  } catch (err) {
    log('attach', svc.id, 'debugger failed', err.message);
    return false;
  } finally {
    if (attachedHere && dbg.isAttached()) dbg.detach();
  }
}

/**
 * 패널에 파일을 첨부한다. files: [{ name, type, size, lastModified, data }]
 * 결과: { ok: true, via } | { ok: false, error }
 */
// 순서: (1) 파일을 페이지로 옮김 → (2) 사람 방식으로 첨부 시도 → (3) 실패하면 개발자 기능으로 시도
async function attachFiles(wc, svc, files) {
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const cfg = { input: svc.input || [], upload: uploadOf(svc) };
  if (!isServiceUrl(svc, wc.getURL())) return { ok: false, error: '패널이 서비스 주소가 아닙니다' };
  let res;
  try {
    await transfer(wc, key, files);
    res = await inWorld(
      wc,
      `(async () => {
        const files = window.__mlaFiles[${JSON.stringify(key)}];
        return await (${pageAttachFiles.toString()})(${JSON.stringify(cfg)}, files);
      })()`,
    );
  } catch (err) {
    res = { ok: false, error: err.message };
  } finally {
    // 성공·실패·중간 오류와 상관없이 페이지에 옮겨 둔 조각과 파일을 항상 지운다
    await clearTransfer(wc, key);
  }
  log('attach', svc.id, JSON.stringify(res));
  if (res?.ok || !cfg.upload.methods.includes('input')) return res || { ok: false, error: '첨부하지 못했습니다' };

  if (await attachWithDebugger(wc, svc, files)) {
    // 사이트가 파일을 읽고 미리보기를 만들 시간을 준다. 업로드가 끝났는지는 보내기 버튼이 켜지는 것으로 본다.
    await new Promise((r) => setTimeout(r, 1500));
    return { ok: true, via: 'debugger' };
  }
  return res;
}

module.exports = { attachFiles, cleanupTemp, clearTransfer };
