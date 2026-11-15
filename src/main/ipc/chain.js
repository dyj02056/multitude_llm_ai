'use strict';

// 화면 요청(IPC) — AI끼리 이어 묻기 (v0.26.0): 넘기기(검토 · 반박 · 이어서) · 다시 보내기 · 다른 AI로 보내기 · 토론 시작/멈춤.
// main.js가 register(ctx)로 연결한다. 화면이 넘긴 값(패널 id · 의도 · 토론 설정)은 여기서 다시 검사하고 rounds(shared/rounds.js)에 넘긴다.
//
// [쉽게 말하면] 패널 머리줄의 → 넘기기, 패널 아래 [다시 보내기] · [다른 AI로], 토론 창의 [시작] · [멈추기]가 부르는 곳입니다.

const { INTENTS, MAX_ROUNDS } = require('../../shared/chain');
const { t } = require('../../shared/i18n');

const okId = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v);

/** 화면이 보낸 토론 설정에서 아는 칸만 (참가 AI는 문자열 id 6개까지 — 개수 · 열림 검사는 shared/chain.js normalizeDebate) */
function cleanDebateCfg(cfg) {
  const c = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  return {
    participants: Array.isArray(c.participants) ? c.participants.filter(okId).slice(0, 6) : [],
    rounds: Number.isInteger(c.rounds) && c.rounds >= 1 && c.rounds <= MAX_ROUNDS ? c.rounds : undefined,
    judge: okId(c.judge) ? c.judge : undefined,
  };
}

/** ctx: { ipcMain, rounds(), hasPanel(id) } */
function register(ctx) {
  const { ipcMain } = ctx;
  const closed = { ok: false, error: t('handoff.errClosed') };

  ipcMain.handle('chain:handoff', (_e, from, to, intent) => {
    if (!okId(from) || !okId(to) || !INTENTS.includes(intent)) return { ok: false, error: t('handoff.errIntent') };
    if (!ctx.hasPanel(from) || !ctx.hasPanel(to)) return closed;
    return ctx.rounds().handoff(from, to, intent);
  });
  ipcMain.handle('prompt:resend', (_e, id) => (okId(id) && ctx.hasPanel(id) ? ctx.rounds().resend(id) : closed));
  ipcMain.handle('prompt:elsewhere', (_e, from, to) => (okId(from) && okId(to) && ctx.hasPanel(to) ? ctx.rounds().sendElsewhere(from, to) : closed));
  ipcMain.handle('debate:start', (_e, cfg) => ctx.rounds().startDebate(cleanDebateCfg(cfg)));
  ipcMain.handle('debate:stop', () => ctx.rounds().stopDebate());
}

module.exports = { register, cleanDebateCfg };
