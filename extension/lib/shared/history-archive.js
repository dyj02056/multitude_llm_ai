// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/history-archive.js)
// 기록 보관 (v0.35.0): 최대 개수를 넘은 기록을 지우지 않고 달별 보관 묶음으로 옮긴다.
// Windows 앱은 사용자 데이터 폴더의 history-archive/archive-YYYY-MM.json(암호화), 크롬 확장은 chrome.storage.local의
// 'history:a:YYYY-MM' 칸에 둔다. 이 파일은 둘이 같이 쓰는 계산(달 계산 · 합치기)과 확장용 저장소를 가진다.
// Electron 앱(require)과 크롬 확장(전역 MLA.historyArchive)이 같이 쓴다.
//
// [쉽게 말하면] "오래돼서 목록에서 밀려난 기록"을 달마다 창고에 모아 두는 부품입니다. 창고는 평소 화면에 안 나오고,
// 기록 화면에서 "보관 포함"을 켜고 찾을 때만 읽습니다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).historyArchive = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_PER_MONTH = 3000; // 한 달 묶음 하나에 둘 수 있는 기록 (넘으면 가장 오래된 것부터 버림)
  const okMonth = (k) => typeof k === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(k);
  const okId = (id) => typeof id === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(id);

  /** 기록 시각 → 'YYYY-MM' (이 PC의 시간대) */
  function monthKey(at) {
    const d = new Date(Number.isFinite(at) && at > 0 ? at : 0);
    return `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  /** 기록들을 달별로 나눈다 → { 'YYYY-MM': [기록] } (기록이 아닌 것 · id가 안전하지 않은 것은 뺌) */
  function groupByMonth(records) {
    const out = {};
    for (const r of Array.isArray(records) ? records : []) {
      if (!r || typeof r !== 'object' || !okId(r.id)) continue;
      (out[monthKey(r.at)] = out[monthKey(r.at)] || []).push(r);
    }
    return out;
  }

  /** 달 묶음에 기록을 더한다: id가 겹치면 하나만(기존 것 유지), 최근 것부터, MAX_PER_MONTH까지 → 새 배열 */
  function mergeMonth(existing, added) {
    const seen = new Set();
    const out = [];
    for (const r of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(added) ? added : [])]) {
      if (!r || typeof r !== 'object' || !okId(r.id) || seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
    return out.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, MAX_PER_MONTH);
  }

  const AREA_MONTHS = 'history:a:months';
  const areaKey = (m) => `history:a:${m}`;

  /**
   * 크롬 확장용 보관 저장소. area: chrome.storage.local 모양 { get(keys) → Promise<obj>, set(obj), remove(keys) }
   * 쓰기는 한 줄로 세운다 (여러 번 연달아 불러도 서로 덮지 않게).
   * → { append(records), readAll(), find(id), remove(id), clear(), info() } (모두 Promise)
   */
  function createAreaArchive(area, { onError = () => {} } = {}) {
    let queue = Promise.resolve();
    const enqueue = (fn) => {
      const run = queue.then(fn);
      queue = run.catch(onError);
      return run;
    };
    const months = async () => {
      const got = await Promise.resolve(area.get(AREA_MONTHS)).catch(() => ({}));
      const list = got && got[AREA_MONTHS];
      return Array.isArray(list) ? [...new Set(list.filter(okMonth))].sort().reverse() : [];
    };
    const readMonth = async (m) => {
      const got = await Promise.resolve(area.get(areaKey(m))).catch(() => ({}));
      const v = got && got[areaKey(m)];
      return Array.isArray(v) ? v.filter((r) => r && typeof r === 'object' && okId(r.id)) : [];
    };

    return {
      append: (records) =>
        enqueue(async () => {
          const groups = groupByMonth(records);
          const keys = Object.keys(groups).filter(okMonth);
          if (!keys.length) return;
          const set = {};
          for (const m of keys) set[areaKey(m)] = mergeMonth(await readMonth(m), groups[m]);
          set[AREA_MONTHS] = [...new Set([...(await months()), ...keys])].sort().reverse();
          await area.set(set);
        }),
      readAll: () =>
        enqueue(async () => {
          const out = [];
          for (const m of await months()) out.push(...(await readMonth(m)));
          return out;
        }),
      find: (id) =>
        enqueue(async () => {
          if (!okId(id)) return null;
          for (const m of await months()) {
            const hit = (await readMonth(m)).find((r) => r.id === id);
            if (hit) return hit;
          }
          return null;
        }),
      remove: (id) =>
        enqueue(async () => {
          if (!okId(id)) return false;
          for (const m of await months()) {
            const list = await readMonth(m);
            if (!list.some((r) => r.id === id)) continue;
            const next = list.filter((r) => r.id !== id);
            if (next.length) await area.set({ [areaKey(m)]: next });
            else {
              await area.remove(areaKey(m));
              await area.set({ [AREA_MONTHS]: (await months()).filter((x) => x !== m) });
            }
            return true;
          }
          return false;
        }),
      clear: () =>
        enqueue(async () => {
          const ms = await months();
          if (ms.length) await area.remove([...ms.map(areaKey), AREA_MONTHS]);
        }),
      info: () =>
        enqueue(async () => {
          const rows = [];
          for (const m of await months()) rows.push({ month: m, count: (await readMonth(m)).length });
          return { months: rows, total: rows.reduce((n, x) => n + x.count, 0) };
        }),
    };
  }

  return { MAX_PER_MONTH, okMonth, monthKey, groupByMonth, mergeMonth, createAreaArchive, AREA_MONTHS };
});
