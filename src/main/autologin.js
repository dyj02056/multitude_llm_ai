'use strict';

// 서비스 패널에서 "Google로 계속하기"를 대신 눌러 준다. 비밀번호는 다루지 않는다.
// Google 계정 선택·동의 화면(accounts.google.com)은 건드리지 않고 사용자가 직접 누른다.

const MAX_ATTEMPTS = 6; // 창 하나에서 연속으로 누르는 최대 횟수
const WINDOW_MS = 2 * 60 * 1000; // 이 시간이 지나면 횟수를 다시 센다

// pageLoginStep은 toString()으로 페이지 안에 주입되어 실행된다. 바깥 변수를 쓰면 안 된다.
// 로그아웃 상태 확인(pageIsLoggedOut)은 크롬 확장 프로그램과 같이 쓰는 shared/page.js에 있다.
function pageLoginStep(cfg) {
  const visible = (el) =>
    !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
    getComputedStyle(el).visibility !== 'hidden';
  const label = (el) => String(el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
  // 버튼이 button/a가 아니라 div로 만들어진 사이트도 있어서 tabindex·class까지 본다.
  // 캡차가 떠 있으면 사람이 풀어야 한다. 아무것도 누르지 않고 멈춘다.
  const captcha = [...document.querySelectorAll('iframe')].some(
    (f) => /hcaptcha|recaptcha|challenges\.cloudflare|turnstile/i.test(f.src) && f.offsetWidth > 100 && f.offsetHeight > 100,
  );
  if (captcha) return { step: 'captcha' };

  const clickables = [
    ...document.querySelectorAll('button,a,[role="button"],[tabindex],[class*="google" i]'),
  ].filter(visible);
  const hit = (step, el) => {
    el.click();
    return { step, label: label(el).slice(0, 60), tag: el.tagName };
  };

  // 가장 안쪽(작은) 요소부터 보도록 텍스트가 짧은 순으로 고른다.
  // "Google 약관" 같은 링크를 누르지 않도록 로그인 동사가 같이 있는 버튼만 고른다.
  const isGoogleLogin = (t) => /google/i.test(t) && /로그인|계속|가입|continue|sign|log ?in/i.test(t);
  const google = clickables
    .filter((el) => isGoogleLogin(label(el)) && label(el).length < 40)
    .sort((a, b) => label(a).length - label(b).length)[0];
  if (google) return hit('google', google);
  if (cfg.loginButton) {
    const el = document.querySelector(cfg.loginButton);
    if (visible(el)) return hit('login', el);
  }
  const login = clickables.find((el) => /^(로그인|로그인하기|log ?in|sign ?in|sign in to \w+)$/i.test(label(el)));
  if (login) return hit('login', login);
  return { step: 'idle', candidates: clickables.map(label).filter(Boolean).slice(0, 15) };
}

const { log: devLog } = require('./dev');
const { pageIsLoggedOut } = require('../shared/page');
const { isServiceUrl, isLoginUrl } = require('../shared/services');
const log = (svc, ...args) => devLog('autologin', svc.id, ...args);

const run = (wc, fn, arg) => wc.executeJavaScript(`(${fn.toString()})(${JSON.stringify(arg)})`, true);

const isGoogleAuthPage = (url) => /^https:\/\/accounts\.google\.com\//.test(url);

// 서비스 주소(예: duck.ai → duckduckgo.com)로 옮겨 가도 같은 서비스로 본다 (https만).
const onServiceHost = isServiceUrl;

/**
 * 서비스 패널 하나를 감시한다.
 * onState(state): 'needs-login' | 'logging-in' | 'google' | 'captcha' | 'ready'
 */
function attach(wc, svc, onState) {
  const st = { running: false, count: 0, since: 0, timer: null };

  async function check() {
    if (wc.isDestroyed() || st.running) return;
    const url = wc.getURL();
    if (isGoogleAuthPage(url)) {
      log(svc, 'google page', url.slice(0, 120));
      return onState('google'); // 계정 선택·동의는 사용자 몫
    }

    st.running = true;
    try {
      const loggedOut = !onServiceHost(svc, url) || (await run(wc, pageIsLoggedOut, svc));
      if (!loggedOut) {
        log(svc, 'ready', url.slice(0, 120));
        st.count = 0;
        return onState('ready');
      }
      if (Date.now() - st.since > WINDOW_MS) {
        st.count = 0;
        st.since = Date.now();
      }
      if (st.count >= MAX_ATTEMPTS) {
        log(svc, 'gave up after', st.count, 'attempts');
        return onState('needs-login');
      }

      // 버튼은 서비스 페이지와 그 서비스의 로그인 화면(authHosts)에서만 누른다. 다른 사이트에 가 있으면 사용자에게 맡긴다.
      if (!isLoginUrl(svc, url)) {
        log(svc, 'not a login page, not clicking', url.slice(0, 120));
        return onState('needs-login');
      }
      const res = await run(wc, pageLoginStep, { loginButton: svc.loginButton || null });
      log(svc, 'logged out at', url.slice(0, 120), '→', JSON.stringify(res));
      if (res.step === 'idle') return onState('needs-login');
      if (res.step === 'captcha') {
        schedule(4000); // 사용자가 캡차를 풀 때까지 기다렸다가 다시 본다
        return onState('captcha');
      }
      st.count++;
      onState('logging-in');
      schedule(2500); // 버튼을 눌렀으니 다음 화면을 다시 살핀다
    } catch (err) {
      // 페이지가 바뀌는 중이면 실패할 수 있다. 다음 로드 이벤트에서 다시 본다.
      log(svc, 'check failed', err.message);
    } finally {
      st.running = false;
    }
  }

  function schedule(ms = 1200) {
    clearTimeout(st.timer);
    st.timer = setTimeout(check, ms);
  }

  wc.on('did-finish-load', () => schedule());
  wc.on('did-navigate-in-page', () => schedule());
  wc.once('destroyed', () => clearTimeout(st.timer));

  return {
    retry() {
      st.count = 0;
      st.since = Date.now();
      schedule(0);
    },
  };
}

module.exports = { attach };
