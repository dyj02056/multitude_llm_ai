// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/page.js)
// 서비스 페이지 안에서 실행되는 함수들.
// Electron 앱은 toString()으로 페이지에 주입하고(executeJavaScript), 크롬 확장 프로그램은 content script에서 바로 부른다.
// 그래서 함수마다 바깥 변수를 쓰면 안 된다 (필요한 것은 함수 안에 둔다).
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.page)이 같이 쓴다.
//
// [쉽게 말하면]
// AI 사이트 페이지 "안에서" 실행되는 작은 일꾼 함수 모음입니다.
//   - 입력창 찾아서 클릭하기 / 파일 첨부하기 / 보내기 버튼 누르기
//   - 지금 답변을 쓰는 중인지, 최신 답변 글이 무엇인지 읽기
//   - 로그아웃 상태인지 확인하기
// 함수를 글자로 바꿔 페이지 안에 넣어 실행하기 때문에, 각 함수는 필요한 것을 모두 자기 안에 갖고 있어야 합니다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).page = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 입력창을 찾아 포커스를 주고 적혀 있던 내용을 지운다. cfg: { input } */
  function pageFocusInput(cfg) {
    const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    // 같은 셀렉터에 숨은 요소가 먼저 걸리는 사이트가 있어 보이는 것을 고른다.
    const input = cfg.input.flatMap((s) => [...document.querySelectorAll(s)]).find(visible);
    if (!input) return { ok: false, error: '입력창을 찾지 못했습니다' };
    input.focus();
    // 이미 적혀 있던 내용은 지우고 새로 쓴다.
    document.execCommand('selectAll');
    document.execCommand('delete');
    return { ok: document.activeElement === input || input.contains(document.activeElement) };
  }

  /** 입력창에 포커스만 다시 준다 (내용은 그대로). cfg: { input } */
  function pageRefocusInput(cfg) {
    const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const input = cfg.input.flatMap((s) => [...document.querySelectorAll(s)]).find(visible);
    if (!input) return false;
    input.focus();
    // 편집기(contenteditable)는 커서를 맨 끝으로 옮긴다. 첨부가 앞에 끼어들었어도 글은 뒤에 붙는다.
    if (input.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return true;
  }

  /**
   * 파일을 입력창에 첨부한다. 사람이 하는 방법(붙여넣기 · 파일 선택 칸 · 끌어다 놓기)을 cfg.upload.methods 순서로 시도한다.
   * cfg: { input, upload: { methods, fileInput, attached, busy } }, files: File[]
   * 결과: { ok: true, via } | { ok: false, error }
   *
   * 첨부됐는지는 (1) 사이트가 이벤트를 처리했는지(preventDefault), (2) 첨부 표시 요소·미리보기 이미지·파일 이름이
   * 새로 나타났는지로 본다. 첨부된 뒤에는 업로드 중 표시(busy)가 사라질 때까지 기다린다.
   */
  async function pageAttachFiles(cfg, files) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const up = cfg.upload;
    const input = cfg.input.flatMap((s) => [...document.querySelectorAll(s)]).find(visible);
    if (!input) return { ok: false, error: '입력창을 찾지 못했습니다' };

    const transfer = () => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      return dt;
    };
    const count = (sel) => sel.reduce((n, s) => n + document.querySelectorAll(s).length, 0);
    const occurrences = (text, word) => (word ? text.split(word).length - 1 : 0);
    const evidence = () => {
      const text = document.body.innerText;
      return {
        marks: count(up.attached),
        images: [...document.images].filter((i) => /^(blob|data):/.test(i.currentSrc || i.src)).length,
        names: files.reduce((n, f) => n + occurrences(text, f.name), 0),
      };
    };
    const before = evidence();
    const changed = () => {
      const now = evidence();
      return now.marks > before.marks || now.images > before.images || now.names > before.names;
    };
    async function waitAttached(handled) {
      if (handled) return true;
      for (let i = 0; i < 15; i++) {
        await sleep(200);
        if (changed()) return true;
      }
      return false;
    }

    const tries = {
      paste() {
        input.focus();
        const ev = new ClipboardEvent('paste', { clipboardData: transfer(), bubbles: true, cancelable: true });
        input.dispatchEvent(ev);
        return ev.defaultPrevented;
      },
      input() {
        const accepts = (el) => {
          const acc = (el.getAttribute('accept') || '').trim();
          if (!acc) return true;
          const rules = acc.split(',').map((a) => a.trim().toLowerCase());
          return files.every((f) =>
            rules.some((r) =>
              r.startsWith('.') ? f.name.toLowerCase().endsWith(r) : r.endsWith('/*') ? f.type.startsWith(r.slice(0, -1)) : f.type === r,
            ),
          );
        };
        const el = up.fileInput.flatMap((s) => [...document.querySelectorAll(s)]).find((e) => !e.disabled && accepts(e));
        if (!el) return null; // 이 방법은 쓸 수 없다
        if (!el.multiple && files.length > 1) return null;
        el.files = transfer().files;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return false;
      },
      drop() {
        const target = input.closest('form') || input.parentElement || input;
        const dt = transfer();
        for (const type of ['dragenter', 'dragover']) {
          target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
        }
        const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
        target.dispatchEvent(ev);
        return ev.defaultPrevented;
      },
    };

    let attachedVia = null;
    for (const method of up.methods) {
      if (!tries[method]) continue;
      let handled;
      try {
        handled = tries[method]();
      } catch {
        continue;
      }
      if (handled === null) continue;
      if (await waitAttached(handled)) {
        attachedVia = method;
        break;
      }
    }
    if (!attachedVia) return { ok: false, error: '사이트가 파일을 받지 않았습니다' };

    // 업로드 중 표시가 사라질 때까지 기다린다 (최대 60초). 보내기 버튼이 다시 켜지는 것은 보낼 때 따로 기다린다.
    const busy = () => up.busy.some((s) => [...document.querySelectorAll(s)].some(visible));
    for (let i = 0; i < 120 && busy(); i++) await sleep(500);
    return { ok: true, via: attachedVia };
  }

  /**
   * 보내기 버튼을 찾아 누른다. cfg: { send, sendText, dry }
   * 결과: true(눌렀음) · null(버튼은 있지만 꺼져 있음 — 업로드 중 등) · false(버튼이 없음)
   */
  // 보내기 버튼을 찾아 누릅니다. 결과: true(눌렀음) / null(버튼은 있는데 꺼져 있음 — 업로드 중 등) / false(못 찾음)
  function pageClickSend(cfg) {
    const usable = (el) =>
      !!el &&
      !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
      !el.disabled &&
      el.getAttribute('aria-disabled') !== 'true' &&
      // Tailwind의 "disabled:opacity-50" 같은 클래스는 상태가 아니라서 걸러내지 않는다.
      !/(^|\s)([\w-]*--)?disabled(\s|$)/.test(String(el.className));
    let btn = cfg.send.flatMap((s) => [...document.querySelectorAll(s)]).find(usable);
    if (!btn && cfg.sendText) {
      const re = new RegExp(cfg.sendText, 'i');
      btn = [...document.querySelectorAll('button,[role="button"]')].find(
        (el) => usable(el) && re.test(String(el.innerText || el.getAttribute('aria-label') || '').trim()),
      );
    }
    if (!btn) {
      const seen = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      return cfg.send.some((s) => [...document.querySelectorAll(s)].some(seen)) ? null : false;
    }
    if (!cfg.dry) btn.click();
    return true;
  }

  /**
   * 지금 상태: { stop: 중지 버튼이 보이는지, count: 답변 덩어리 수, text: 최신 답변 글, md: Markdown }
   * cfg: { stop, response, messages }. toMarkdown이 있으면 최신 답변을 Markdown으로도 바꿔 md에 담는다.
   */
  // 페이지의 "지금 사진"을 찍습니다: 멈춤 버튼이 보이는지(=답변 쓰는 중), 답변 덩어리 개수, 최신 답변 글.
  // 답변 감시원(watch.js)이 이 사진을 여러 번 비교해 답변이 끝났는지 판단합니다.
  function pageSnapshot(cfg, toMarkdown) {
    const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const stop = cfg.stop.some((s) => [...document.querySelectorAll(s)].some(visible));
    let list = [];
    // 메시지 블록에 역할 이름(USER/ASSISTANT)이 붙는 사이트는 역할로 고른다.
    if (cfg.messages) {
      const re = new RegExp(cfg.messages.role, 'i');
      list = [...document.querySelectorAll(cfg.messages.container)]
        .filter((el) => visible(el) && re.test(el.innerText.trim()))
        .map((el) => el.querySelector(cfg.messages.content) || el);
    }
    for (const s of list.length ? [] : cfg.response) {
      const els = [...document.querySelectorAll(s)].filter(visible);
      if (els.length) {
        // 넓게 잡는 셀렉터([class*="markdown"] 등)는 답변 안쪽 요소까지 걸린다. 가장 바깥 것만 남긴다.
        list = els.filter((el) => !els.some((o) => o !== el && o.contains(el)));
        break;
      }
    }
    const last = list[list.length - 1];
    const text = last ? textWithoutButtons(last) : '';
    const md = toMarkdown && last ? toMarkdown(last) : undefined;
    return { stop, count: list.length, text, md };

    // 답변 안의 버튼 글자("예", "복사" 등)는 빼고 읽는다.
    // innerText는 화면에 붙어 있어야 줄바꿈이 살아서, 복제본을 화면 밖에 잠깐 붙였다가 뗀다.
    function textWithoutButtons(el) {
      if (!el.querySelector('button,[role="button"]')) return el.innerText.trim();
      const clone = el.cloneNode(true);
      clone.querySelectorAll('button,[role="button"]').forEach((b) => b.remove());
      Object.assign(clone.style, { position: 'fixed', left: '-100000px', top: '0', width: `${el.clientWidth}px` });
      document.body.appendChild(clone);
      const text = clone.innerText.trim();
      clone.remove();
      return text;
    }
  }

  /** 로그아웃 상태인지. cfg: 서비스 설정 (loggedOut 사용) */
  // 로그아웃 상태인지: 로그인 화면 주소이거나, "로그인" 버튼·링크가 보이면 로그아웃으로 봅니다.
  function pageIsLoggedOut(cfg) {
    const visible = (el) =>
      !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
      getComputedStyle(el).visibility !== 'hidden';
    const label = (el) => String(el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
    const lo = cfg.loggedOut || {};
    if (lo.url && new RegExp(lo.url).test(location.href)) return true;
    if ((lo.selectors || []).some((s) => visible(document.querySelector(s)))) return true;
    if (lo.text) {
      const re = new RegExp(lo.text, 'i');
      if ([...document.querySelectorAll('button,a,[role="button"]')].some((el) => visible(el) && re.test(label(el)))) return true;
    }
    return false;
  }

  return { pageFocusInput, pageRefocusInput, pageAttachFiles, pageClickSend, pageSnapshot, pageIsLoggedOut };
});
