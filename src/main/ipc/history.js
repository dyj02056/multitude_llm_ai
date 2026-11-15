'use strict';

// 화면 요청(IPC) — 질문·답변 기록 · 답변 복사 · 내보내기 저장 · 답변 읽기 (v0.24.0에서 main.js에서 옮김).
// 화면에서 온 값은 믿지 않고 모양을 먼저 확인한다. main.js가 register(ctx)로 연결한다.
//
// [쉽게 말하면] 기록 화면 · 답변 비교 화면이 "기록 보여 줘", "이 답변 복사해 줘", "파일로 저장해 줘" 할 때 처리하는 곳입니다.

const fs = require('fs');
const path = require('path');

// 내보내기 (v0.14.0): 저장 창에서 고른 곳에 Markdown · HTML 글을 씁니다. 이름은 화면이 정한 기본값, 종류는 md · html만.
const SAVE_KINDS = { md: { name: 'Markdown', ext: 'md' }, html: { name: 'HTML 문서', ext: 'html' } };

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
  ipcMain.handle('history:list', (_e, query) => history.list(typeof query === 'string' ? query : ''));
  ipcMain.handle('history:get', (_e, id) => history.get(id));
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
    if (!k || typeof text !== 'string' || text.length > 20 * 1024 * 1024) return { ok: false, error: '저장할 내용이 올바르지 않습니다' };
    const base = (typeof name === 'string' ? name : '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 120) || `답변.${k.ext}`;
    const { canceled, filePath } = await dialog.showSaveDialog(ctx.win(), {
      title: '내보내기',
      defaultPath: path.join(app.getPath('downloads'), base.endsWith(`.${k.ext}`) ? base : `${base}.${k.ext}`),
      filters: [{ name: k.name, extensions: [k.ext] }],
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

module.exports = { register, SAVE_KINDS };
