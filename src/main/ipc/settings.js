'use strict';

// 화면 요청(IPC) — 설정 화면 · 종합 담당 · 로컬 LLM 설정 · 원격 셀렉터 · 앱 업데이트 · 단축키 목록 · 라이브러리 저장
// (v0.24.0에서 main.js에서 옮김). main.js가 register(ctx)로 연결한다.
//
// [쉽게 말하면] 설정(?) 화면과 라이브러리 화면에서 바꾼 값을 검사해 저장하는 곳입니다.

const L = require('../../shared/local-llm');
const { RELEASES_URL } = require('../../shared/update-core');
const { normalizeLibrary } = require('../../shared/prompt-lib');
const notifyCore = require('../../shared/notify');
const { t, LANG_PREFS, getLang } = require('../../shared/i18n');

const ASK_MAX = 200000; // local:ask 글자 수 한도 (v0.29.0)

/**
 * ctx: { ipcMain, history, remote, guard, net, shell, TIMEOUT_CHOICES, MAX_CHOICES, prefs(), savePrefs, pushState,
 *        allServices(), refreshRemote(), localChat(), closeLocalPanel(), focusId(), setFocusId(id), updater(),
 *        shortcutList(), librarySaver, readLibrary(), askLocal(text), applyLang() }
 */
function register(ctx) {
  const { ipcMain, history, remote, guard, net, shell } = ctx;
  const isLocal = (id) => id === L.LOCAL_ID;

  // 설정 화면(?)에서 바꾼 값 저장: 답변 최대 대기 시간, 기록 최대 개수, 사이트 셀렉터 자동 갱신, 새 버전 자동 확인,
  // OS 알림 종류별 켜기 · 보내기 전 미리보기 (v0.25.0)
  ipcMain.on('settings:set', (_e, { answerTimeoutMin, remoteSelectors, autoUpdate, historyMax, notify, sendPreview, retryOnce, autoRecommend, commitOffer, lang } = {}) => {
    const prefs = ctx.prefs();
    // 화면 언어 (v0.30.0): 'auto' · 'ko' · 'en'만. 본체 글(창 · 알림 · 오류)은 바로 바뀌고, 화면은 state.uiLang을 보고 다시 그린다
    if (LANG_PREFS.includes(lang) && lang !== prefs.lang) {
      prefs.lang = lang;
      ctx.applyLang();
    }
    const notifyPatch = notifyCore.cleanPatch(notify); // 아는 종류의 true/false만
    if (notifyPatch) prefs.notify = notifyCore.normalizePrefs({ ...prefs.notify, ...notifyPatch });
    if (typeof sendPreview === 'boolean') prefs.sendPreview = sendPreview;
    if (typeof retryOnce === 'boolean') prefs.retryOnce = retryOnce; // 실패하면 한 번 다시 보내기 (v0.26.0)
    if (typeof autoRecommend === 'boolean') prefs.autoRecommend = autoRecommend; // 추천 조합 제안 (v0.27.0)
    if (typeof commitOffer === 'boolean') prefs.commitOffer = commitOffer; // 적용 후 커밋 제안 (v0.28.0, Windows 앱)
    if (ctx.TIMEOUT_CHOICES.includes(answerTimeoutMin)) prefs.answerTimeoutMin = answerTimeoutMin;
    if (ctx.MAX_CHOICES.includes(historyMax)) {
      prefs.historyMax = historyMax;
      history.setMax(historyMax); // 줄이면 오래된 기록부터 지운다 (화면에서 확인을 받은 뒤 보낸다)
    }
    if (typeof autoUpdate === 'boolean') prefs.autoUpdate = autoUpdate;
    if (typeof remoteSelectors === 'boolean' && remoteSelectors !== prefs.remoteSelectors) {
      prefs.remoteSelectors = remoteSelectors;
      if (remoteSelectors) ctx.refreshRemote();
      else remote.reset();
    }
    ctx.savePrefs();
    ctx.pushState();
  });

  // 종합 담당 AI와 "완료 후 자동 종합" 켜기/끄기 저장
  ipcMain.on('synth:set', (_e, { target, auto } = {}) => {
    const prefs = ctx.prefs();
    if (typeof target === 'string' && ctx.allServices().some((s) => s.id === target)) prefs.synthTarget = target;
    if (typeof auto === 'boolean') prefs.autoSynth = auto;
    ctx.savePrefs();
    ctx.pushState();
  });

  // 로컬 LLM 설정: 켜기 · 끄기, 주소(localhost만), 모델. 끄면 열린 로컬 패널을 닫고 고른 목록에서도 뺀다.
  ipcMain.handle('local:setPrefs', (_e, next = {}) => {
    const prefs = ctx.prefs();
    const cur = prefs.local;
    const baseUrl = next.baseUrl === undefined ? cur.baseUrl : L.normalizeBaseUrl(next.baseUrl);
    if (!baseUrl) return { ok: false, error: t('main.settings.localOnly') };
    prefs.local = {
      enabled: typeof next.enabled === 'boolean' ? next.enabled : cur.enabled,
      baseUrl,
      model: next.model === undefined ? cur.model : L.cleanModel(next.model),
      contextTokens: next.contextTokens === undefined ? L.normalizeContext(cur.contextTokens) : L.normalizeContext(next.contextTokens), // v0.29.0
    };
    if (!prefs.local.enabled) {
      prefs.selected = prefs.selected.filter((x) => !isLocal(x));
      if (isLocal(prefs.synthTarget)) prefs.synthTarget = prefs.selected[0];
      if (ctx.localChat()) {
        ctx.closeLocalPanel();
        if (ctx.focusId() && isLocal(ctx.focusId())) ctx.setFocusId(null);
      }
    }
    ctx.savePrefs();
    ctx.pushState();
    return { ok: true, local: { ...prefs.local } };
  });
  // 연결 확인: 그 주소의 모델 목록 (/v1/models)
  ipcMain.handle('local:models', async (_e, baseUrl) => {
    // 화면이 준 주소도 이 PC 주소인지 앱 쪽에서 다시 본다 (아니면 요청을 보내지 않는다)
    const base = baseUrl === undefined || baseUrl === null ? ctx.prefs().local.baseUrl : guard.localBaseUrl(baseUrl);
    if (!base) return { ok: false, error: t('main.settings.localOnly') };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      return { ok: true, models: await L.listModels((u, o) => net.fetch(u, o), base, { signal: ctrl.signal }) };
    } catch (err) {
      return { ok: false, error: err.name === 'AbortError' ? t('main.settings.noReply5s') : err.message };
    } finally {
      clearTimeout(timer);
    }
  });

  // 패널 없이 로컬 LLM에 한 번 묻기 (v0.29.0, 스킬 압축): 글만 받는다 (20만 자까지). 주소는 설정의 localhost 주소뿐
  ipcMain.handle('local:ask', (_e, text) => {
    if (typeof text !== 'string' || !text.trim() || text.length > ASK_MAX) return { ok: false, error: t('main.settings.badAsk') };
    return ctx.askLocal(text);
  });

  // 사이트 셀렉터 원격 갱신 (설정 화면의 [지금 확인])
  ipcMain.handle('remote:refresh', () => ctx.refreshRemote());

  // 앱 업데이트 (v0.20.0): 확인은 자동(켜 두었을 때) 또는 [지금 확인]. 받기 · 설치는 사용자가 누를 때만.
  ipcMain.handle('update:check', () => ctx.updater()?.check());
  ipcMain.handle('update:download', () => ctx.updater()?.download());
  ipcMain.handle('update:install', () => ctx.updater()?.install() || false);
  ipcMain.on('update:openReleases', () => shell.openExternal(RELEASES_URL));

  ipcMain.handle('shortcuts:list', () => ctx.shortcutList());

  // 화면이 시작할 때 한 번 묻는 지금 언어 (v0.30.0, preload의 동기 요청): 첫 그림부터 맞는 언어로 그리게
  ipcMain.on('i18n:lang', (e) => {
    e.returnValue = getLang();
  });

  // 프롬프트 라이브러리·스킬: 모양을 검사하고 길이를 잘라서 이 PC에만 저장한다 (shared/prompt-lib.js)
  ipcMain.handle('library:load', () => {
    try {
      const pending = ctx.librarySaver.current(); // 아직 파일에 안 들어갔을 수도 있는 마지막 저장본이 먼저
      return normalizeLibrary(pending !== undefined ? pending : ctx.readLibrary());
    } catch {
      return normalizeLibrary({});
    }
  });
  ipcMain.handle('library:save', (_e, data) => {
    try {
      ctx.librarySaver.save(normalizeLibrary(data)); // 쓰기 실패는 librarySaver가 터미널에 남긴다
      return true;
    } catch (err) {
      console.error('[library] 저장하지 못했습니다:', err.message);
      return false;
    }
  });
}

module.exports = { register };
