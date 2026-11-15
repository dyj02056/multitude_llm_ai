'use strict';

// 화면 요청(IPC) — 질문·답변 기록 · 답변 복사 · 내보내기 저장 · 답변 읽기 (v0.24.0에서 main.js에서 옮김).
// 화면에서 온 값은 믿지 않고 모양을 먼저 확인한다. main.js가 register(ctx)로 연결한다.
//
// [쉽게 말하면] 기록 화면 · 답변 비교 화면이 "기록 보여 줘", "이 답변 복사해 줘", "파일로 저장해 줘" 할 때 처리하는 곳입니다.

const fs = require('fs');
const path = require('path');
const { cleanFilters } = require('../../shared/history-search');
const { okRecordId } = require('../../shared/history-core');
const { t } = require('../../shared/i18n');

// 내보내기 (v0.14.0): 저장 창에서 고른 곳에 Markdown · HTML 글을 씁니다. 이름은 화면이 정한 기본값, 종류는 md · html만.
// mla: 설정 옮기기 파일 (v0.29.0, .mla.json — 설정 · 라이브러리, 비밀번호를 걸면 암호화된 글)
const SAVE_KINDS = { md: { name: 'Markdown', ext: 'md' }, html: { nameKey: 'main.save.html', ext: 'html' }, mla: { nameKey: 'main.save.mla', ext: 'mla.json', filter: 'json' } }; // nameKey: 사전 키 (저장 창을 열 때 t()로)

/**
 * ctx: { ipcMain, history, rounds(), roundHistoryId(), clipboard, dialog, app, win() }
 * (rounds · roundHistoryId · win은 바뀌므로 함수로 받는다)
 */
function register(ctx) {
  const { ipcMain, history, clipboard, dialog, app } = ctx;

  // 최신 답변을 Markdown으로 복사. id가 '*'이면 열린 패널 전부를 "## 이름" 머리말로 묶는다.
  ipcMain.handle('answer:copy', async (_e, id) => {
    const { text, copied, total } = await ctx.rounds().collectMarkdown(id);
    if (copied) clipboard.writeText(text);
    return { copied, total };
  });

  // 질문·답변 기록
  // filters (v0.27.0): 기간 · AI · 평가 · 보낸 곳 · 프로젝트 · 종합/분석/이어 묻기 · 태그 · 즐겨찾기 — 아는 칸만 남긴다
  ipcMain.handle('history:list', (_e, query, filters) => history.list(typeof query === 'string' ? query.slice(0, 500) : '', cleanFilters(filters)));
  ipcMain.handle('history:get', (_e, id) => history.get(id));
  // 태그 · 즐겨찾기 (v0.27.0): 기록 id 모양 · 태그 글자 수를 먼저 보고, 다듬기(10개 · 30자)는 history-core가 한다
  ipcMain.handle('history:setTags', (_e, id, tags) => (okRecordId(id) && okTagInput(tags) ? history.setTags(id, tags) : null));
  ipcMain.handle('history:setStar', (_e, id, on) => (okRecordId(id) && typeof on === 'boolean' ? history.setStar(id, on) : null));
  // 대화 줄기 (v0.27.0): 같은 threadId의 기록 전부 (오래된 것부터)
  ipcMain.handle('history:thread', (_e, threadId) => (okRecordId(threadId) ? history.thread(threadId) : []));
  ipcMain.handle('history:tags', () => history.tags());
  // 질문 종류별 추천 조합 (v0.27.0, shared/recommend.js)
  ipcMain.handle('history:recommend', () => history.recommend());
  ipcMain.handle('history:stats', () => history.stats());
  // 답변 평가: 지금 라운드 기록의 그 AI 답변에 1(좋았음) · -1(별로였음) · 0(지우기) → 남긴 값 | null
  ipcMain.handle('history:feedback', (_e, svcId, value) => {
    const id = ctx.roundHistoryId();
    return id && typeof svcId === 'string' && [1, -1, 0].includes(value) ? history.setFeedback(id, svcId, value) : null;
  });
  ipcMain.handle('history:delete', (_e, id) => history.remove(id));
  ipcMain.handle('history:clear', () => history.clear());
  ipcMain.handle('clipboard:write', (_e, text) => {
    if (typeof text === 'string') clipboard.writeText(text);
  });

  ipcMain.handle('file:save', async (_e, { name, text, kind } = {}) => {
    const k = SAVE_KINDS[kind];
    if (!k || typeof text !== 'string' || text.length > 20 * 1024 * 1024) return { ok: false, error: t('main.save.badContent') };
    const base = (typeof name === 'string' ? name : '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 120) || `${t('main.answerFileName')}.${k.ext}`;
    const { canceled, filePath } = await dialog.showSaveDialog(ctx.win(), {
      title: t('main.save.title'),
      defaultPath: path.join(app.getPath('downloads'), base.endsWith(`.${k.ext}`) ? base : `${base}.${k.ext}`),
      filters: [{ name: k.nameKey ? t(k.nameKey) : k.name, extensions: [k.filter || k.ext] }],
    });
    if (canceled || !filePath) return { ok: false, cancelled: true };
    await fs.promises.writeFile(filePath, text, 'utf8');
    return { ok: true, path: filePath };
  });

  // 답변 비교 화면용: 열린 패널마다 최신 답변 글과 마지막 공통 질문
  ipcMain.handle('answers:get', () => ctx.rounds().answers());
  // 패널 하나의 최신 답변 (답변이 끝난 패널만 읽을 때: 파일 모아보기 버튼, NEED_FILES 확인)
  ipcMain.handle('answer:get', (_e, id) => (typeof id === 'string' ? ctx.rounds().answer(id) : null));
}

/** 화면이 보낸 태그 목록: 글자 50개 이하, 하나 200자 이하 (그보다 큰 값은 통째로 받지 않는다) */
function okTagInput(tags) {
  return Array.isArray(tags) && tags.length <= 50 && tags.every((x) => typeof x === 'string' && x.length <= 200);
}

module.exports = { register, SAVE_KINDS, okTagInput };
