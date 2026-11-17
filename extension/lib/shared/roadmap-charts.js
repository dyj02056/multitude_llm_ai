// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/roadmap-charts.js)
// 로드맵 진행 그림 (v0.38.0): 진행 링 · 마일스톤 누적 막대 · 선행 관계 지도 · 번다운을 인라인 SVG 글로 만든다.
// 외부 그림 라이브러리 없이 글(문자열)만 만들어, 화면(innerHTML)과 내보내기 HTML 어디서나 쓴다.
// 색은 이 파일의 CSS(.rm-s-<상태> 클래스의 --c 색 + 대기는 점선)로 입힌다. 앱 화면은 CSP 때문에 <style>을 끼워 넣을 수 없어
// 같은 규칙을 src/renderer/styles.css에 복사해 두고(테스트가 같은지 검사), 내보내기 HTML은 CSS + CSS_LIGHT를 파일 안에 넣는다.
// 상태마다 기호(✓ ▶ ◐ ○ ✕)도 같이 그려 색만으로 구분하지 않게 한다.
// 글자는 글자 수가 아니라 대략의 폭(한글 · 한자 · 전각은 1em, 나머지는 약 0.54em)으로 잘라 칸 밖으로 넘치지 않게 한다 (v0.38.1).
// Electron 앱(require)과 크롬 확장(전역 MLA.roadmapCharts)이 같이 쓴다. 글은 모두 이스케이프한다.
//
// [쉽게 말하면] 진행률을 한눈에 보여 주는 도넛 · 막대 · 지도 · 꺾은선 그림을 만들어 주는 부품입니다.
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./roadmap') : root.MLA && root.MLA.roadmap, isNode ? require('./i18n') : root.MLA && root.MLA.i18n);
  if (isNode) module.exports = api;
  else (root.MLA = root.MLA || {}).roadmapCharts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (RM, i18n) {
  'use strict';

  const t = (key, vars) => (i18n ? i18n.t(key, vars) : key);
  const GLYPH = { done: '✓', doing: '▶', verify: '◐', todo: '○', blocked: '✕' };
  const ORDER = ['done', 'verify', 'doing', 'blocked', 'todo']; // 막대에서 왼쪽부터 쌓는 순서

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  // 글자 하나의 대략 폭(em): 한글 · 한자 · 가나 · 전각 기호는 1, 나머지(영문 · 숫자 · 공백)는 0.54
  const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
  const emOf = (c) => (WIDE.test(c) ? 1 : 0.54);
  /** maxPx 폭(글자 크기 px 기준)에 들어가게 자르고, 자르면 끝에 … */
  function fit(s, maxPx, px = 12) {
    const chars = [...String(s ?? '')];
    const max = maxPx / px;
    let w = 0;
    for (const c of chars) w += emOf(c);
    if (w <= max) return chars.join('');
    let out = '';
    w = 0.6; // … 자리
    for (const c of chars) {
      if (w + emOf(c) > max) break;
      w += emOf(c);
      out += c;
    }
    return `${out.trimEnd()}…`;
  }
  const statusName = (s) => t(`ui.roadmap.status.${s}`);
  const num = (x) => Math.round(x * 100) / 100;

  /** 전체 진행 링: 도넛 + 가운데 큰 % + "12/19 작업" */
  function ringSvg(rm) {
    const p = RM.progress(rm);
    const R = 62;
    const C = 2 * Math.PI * R;
    // 상태마다 호 하나: 그 상태가 진행률에 보탠 몫(가중치 × 완료 100% · 검증 80% · 진행 40%)만큼 칠한다.
    // 그래서 칠한 부분의 합 = 가운데 % 이고, 나머지(대기 · 막힘 · 아직 안 한 몫)는 회색 바탕으로 남는다 (v0.38.1).
    let offset = 0;
    const arcs = ORDER.map((s) => {
      const frac = p.weightTotal ? (p.weights[s] * RM.STATUS_SHARE[s]) / p.weightTotal : 0;
      const len = frac * C;
      const out = frac > 0 ? `<circle class="rm-arc rm-s-${s}" cx="80" cy="80" r="${R}" fill="none" stroke-width="18" stroke-dasharray="${num(len)} ${num(C - len)}" stroke-dashoffset="${num(-offset)}" transform="rotate(-90 80 80)"><title>${esc(statusName(s))}: ${p.counts[s]}</title></circle>` : '';
      offset += len;
      return out;
    }).join('');
    const label = t('ui.roadmap.ring.label', { pct: p.pct, done: p.done, total: p.total });
    return `<svg class="rm-ring" viewBox="0 0 160 160" role="img" aria-label="${esc(label)}"><circle class="rm-track" cx="80" cy="80" r="${R}" fill="none" stroke-width="18"/>${arcs}<text class="rm-ring-pct" x="80" y="82" text-anchor="middle">${p.pct}%</text><text class="rm-ring-sub" x="80" y="104" text-anchor="middle">${esc(t('ui.roadmap.ring.sub', { done: p.done, total: p.total }))}</text></svg>`;
  }

  /** 마일스톤마다 가로 누적 막대 (작업 개수 기준 완료 · 검증 · 진행 · 막힘 · 대기) */
  function barsSvg(rm) {
    const p = RM.progress(rm);
    const rowH = 34;
    const left = 150;
    const width = 560;
    const barW = width - left - 56;
    const h = Math.max(rowH, p.milestones.length * rowH) + 8;
    const rows = p.milestones
      .map((m, i) => {
        const y = 4 + i * rowH;
        let x = left;
        const segs = ORDER.map((s) => {
          const w = m.n ? (m.counts[s] / m.n) * barW : 0;
          if (w <= 0) return '';
          const seg = `<rect class="rm-seg rm-s-${s}" x="${num(x)}" y="${y + 6}" width="${num(w)}" height="18" rx="2"><title>${esc(statusName(s))}: ${m.counts[s]}</title></rect>${w >= 16 ? `<text class="rm-glyph rm-s-${s}" x="${num(x + w / 2)}" y="${y + 19}" text-anchor="middle">${GLYPH[s]}</text>` : ''}`;
          x += w;
          return seg;
        }).join('');
        const empty = m.n ? '' : `<rect class="rm-seg rm-s-todo" x="${left}" y="${y + 6}" width="${barW}" height="18" rx="2"/>`;
        return `<g><text class="rm-label" x="${left - 8}" y="${y + 19}" text-anchor="end">${esc(fit(m.title, left - 12))}</text>${empty}${segs}<text class="rm-pct" x="${left + barW + 8}" y="${y + 19}">${m.pct}%</text></g>`;
      })
      .join('');
    return `<svg class="rm-bars" viewBox="0 0 ${width} ${h}" role="img" aria-label="${esc(t('ui.roadmap.bars.label'))}">${rows}</svg>`;
  }

  /**
   * 선행 관계 지도: 마일스톤을 열로, 작업을 노드로. 선행 → 후속은 화살표.
   * 다른 열로 가는 화살표는 앞 노드의 오른쪽 → 뒤 노드의 왼쪽, 같은 열(같은 마일스톤) 안의 화살표는
   * 노드 뒤로 숨지 않게 열 왼쪽 여백으로 돌아 들어간다 (v0.38.1).
   */
  function mapSvg(rm, { current = '' } = {}) {
    const colW = 200;
    const nodeW = 164;
    const nodeH = 38;
    const gapY = 14;
    const top = 30;
    const padL = 26; // 열 왼쪽 여백 — 같은 열 안의 화살표가 지나간다
    const pos = new Map();
    const colX = (ci) => padL + ci * colW;
    const cols = rm.milestones.map((m, ci) => {
      m.tasks.forEach((tk, ri) => pos.set(tk.id, { x: colX(ci), y: top + ri * (nodeH + gapY), ci, ri }));
      return `<text class="rm-col" x="${colX(ci)}" y="18">${esc(fit(m.title, nodeW, 12.5))}</text>`;
    });
    const rowsMax = Math.max(1, ...rm.milestones.map((m) => m.tasks.length));
    const w = Math.max(200, padL + (rm.milestones.length - 1) * colW + nodeW + 16);
    const h = top + rowsMax * (nodeH + gapY);
    const edges = [];
    for (const tk of RM.tasksOf(rm)) {
      for (const d of tk.deps) {
        const a = pos.get(d);
        const b = pos.get(tk.id);
        if (!a || !b) continue;
        if (a.ci === b.ci) {
          // 같은 열: 왼쪽 가장자리끼리, 행이 멀수록 더 바깥으로 돌아 겹침을 줄인다
          const y1 = a.y + nodeH / 2;
          const y2 = b.y + nodeH / 2;
          const bend = a.x - Math.min(padL - 4, 10 + 4 * Math.abs(b.ri - a.ri));
          edges.push(`<path class="rm-edge" d="M${a.x} ${y1} C${bend} ${y1} ${bend} ${y2} ${b.x} ${y2}" fill="none" marker-end="url(#rmArrow)"/>`);
          continue;
        }
        const x1 = a.x + nodeW;
        const y1 = a.y + nodeH / 2;
        const x2 = b.x;
        const y2 = b.y + nodeH / 2;
        const mx = x1 < x2 ? (x1 + x2) / 2 : x1 + 14;
        edges.push(`<path class="rm-edge" d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}" fill="none" marker-end="url(#rmArrow)"/>`);
      }
    }
    const nodes = RM.tasksOf(rm)
      .map((tk) => {
        const q = pos.get(tk.id);
        const locked = tk.status === 'todo' && !RM.isUnlocked(rm, tk);
        const cls = `rm-node rm-s-${tk.status}${tk.id === current ? ' rm-current' : ''}${locked ? ' rm-locked' : ''}`;
        return `<g class="${cls}" data-task="${esc(tk.id)}" tabindex="0" role="button" aria-label="${esc(`${tk.id} ${tk.title} — ${statusName(tk.status)}`)}"><rect x="${q.x}" y="${q.y}" width="${nodeW}" height="${nodeH}" rx="6"/><text class="rm-glyph" x="${q.x + 12}" y="${q.y + 24}">${GLYPH[tk.status]}</text><text class="rm-node-t" x="${q.x + 26}" y="${q.y + 24}">${esc(fit(`${tk.id} ${tk.title}`, nodeW - 26 - 8))}</text><title>${esc(`${tk.title} (${statusName(tk.status)})`)}</title></g>`;
      })
      .join('');
    const defs = '<defs><marker id="rmArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="rm-arrowhead"/></marker></defs>';
    return `<svg class="rm-map" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="group" aria-label="${esc(t('ui.roadmap.map.label'))}">${defs}${cols.join('')}${edges.join('')}${nodes}</svg>`;
  }


  // 그림 CSS: 상태 색(--c)은 여기서만 정한다. 앱은 styles.css의 변수(--text · --border …)를, 내보내기 HTML은 CSS_LIGHT를 쓴다.
  const CSS = [
    '.rm-s-done{--c:#2ea043}.rm-s-verify{--c:#388bfd}.rm-s-doing{--c:#d29922}.rm-s-blocked{--c:#f85149}.rm-s-todo{--c:#8b949e}',
    '.rm-ring,.rm-bars,.rm-map,.rm-burn{--rm-text:var(--text,#c9d1d9);--rm-sub:var(--text-2,#8b949e);--rm-track:var(--border,#30363d);--rm-node:var(--bg-2,#161b22);max-width:100%}',
    '.rm-ring{width:170px;height:170px;flex:none}.rm-bars,.rm-burn{width:100%;max-width:560px;height:auto}',
    '.rm-arc{stroke:var(--c)}.rm-track{stroke:var(--rm-track)}.rm-seg{fill:var(--c)}.rm-seg.rm-s-todo{fill:none;stroke:var(--c);stroke-dasharray:3 3}',
    // 막대 위 기호: 칠한 칸은 흰색, 노랑(진행 중) 위는 짙은 색, 칠하지 않은 대기 칸은 상태 색 — 흰 바탕 내보내기에서도 보이게 (v0.38.1)
    '.rm-glyph{fill:#fff;font:700 11px system-ui,sans-serif}.rm-glyph.rm-s-doing{fill:#1f2328}.rm-glyph.rm-s-todo{fill:var(--c)}.rm-node .rm-glyph{fill:var(--c);font-size:13px}',
    '.rm-ring-pct{fill:var(--rm-text);font:700 28px system-ui,sans-serif}.rm-ring-sub{fill:var(--rm-sub);font:12px system-ui,sans-serif}',
    '.rm-label,.rm-pct,.rm-node-t,.rm-col,.rm-tick{fill:var(--rm-text);font:12px system-ui,sans-serif}.rm-col{font-weight:700}.rm-tick{fill:var(--rm-sub);font-size:11px}',
    '.rm-node rect{fill:var(--rm-node);stroke:var(--c);stroke-width:2}.rm-node.rm-s-todo rect{stroke-dasharray:4 3}.rm-node.rm-locked{opacity:.55}.rm-node.rm-current rect{stroke-width:4}.rm-node{cursor:pointer}.rm-node:focus{outline:none}.rm-node:focus rect{stroke-width:4}',
    '.rm-edge{stroke:var(--rm-sub);stroke-width:1.4}.rm-arrowhead{fill:var(--rm-sub)}',
    '.rm-axis{stroke:var(--rm-sub);stroke-width:1}.rm-est{stroke:#d29922;stroke-width:2;stroke-dasharray:2 4}',
    '.rm-burn-line{stroke:#388bfd;stroke-width:2.5}.rm-dot{fill:#388bfd}',
    '.rm-dash-top{display:flex;gap:20px;align-items:center;flex-wrap:wrap}.rm-dash-bars{flex:1 1 320px;min-width:0}.rm-scroll{overflow:auto}.rm-dash h3{margin:14px 0 6px;font-size:13px}.rm-note{font-size:12px;opacity:.8}',
  ].join('\n');
  const CSS_LIGHT = '.rm-ring,.rm-bars,.rm-map,.rm-burn{--rm-text:#1f2328;--rm-sub:#57606a;--rm-track:#d8dee4;--rm-node:#fff}';

  const fmtDate = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  /**
   * 번다운: 남은 가중치가 줄어드는 계단선 + 예상선 + 예상 완료일.
   * 예상선은 시작점에서 지금까지의 평균 속도로 0에 닿는 점선이다 (마감일이 없으므로 "이상선"은 그리지 않는다, v0.38.1).
   */
  function burndownSvg(rm, { now } = {}) {
    const b = RM.burndown(rm, { now });
    const W = 560;
    const H = 220;
    const L = 40;
    const R = 16;
    const T = 16;
    const B = 34;
    const endMs = Math.max(b.now, b.estimate || 0, b.points[b.points.length - 1].at, b.start + 86400000);
    const x = (ms) => L + ((ms - b.start) / (endMs - b.start)) * (W - L - R);
    const y = (v) => T + (1 - (b.total ? v / b.total : 0)) * (H - T - B);
    // 계단 모양: 완료 시각까지 이전 값을 유지하다가 떨어진다
    let d = `M${num(x(b.points[0].at))} ${num(y(b.points[0].remaining))}`;
    for (let i = 1; i < b.points.length; i++) d += ` H${num(x(b.points[i].at))} V${num(y(b.points[i].remaining))}`;
    d += ` H${num(x(Math.max(b.now, b.points[b.points.length - 1].at)))}`;
    const dots = b.points
      .slice(1)
      .map((q) => `<circle class="rm-dot" cx="${num(x(q.at))}" cy="${num(y(q.remaining))}" r="3.5"><title>${esc(fmtDate(q.at))}: ${q.remaining}</title></circle>`)
      .join('');
    const est = b.estimate ? `<line class="rm-est" x1="${num(x(b.start))}" y1="${num(y(b.total))}" x2="${num(x(b.estimate))}" y2="${num(y(0))}"><title>${esc(fmtDate(b.estimate))}</title></line>` : '';
    const axes = `<line class="rm-axis" x1="${L}" y1="${T}" x2="${L}" y2="${H - B}"/><line class="rm-axis" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"/><text class="rm-tick" x="${L - 6}" y="${T + 4}" text-anchor="end">${b.total}</text><text class="rm-tick" x="${L - 6}" y="${H - B + 4}" text-anchor="end">0</text><text class="rm-tick" x="${L}" y="${H - B + 18}">${esc(fmtDate(b.start))}</text><text class="rm-tick" x="${W - R}" y="${H - B + 18}" text-anchor="end">${esc(fmtDate(endMs))}</text>`;
    const note = b.estimate ? t('ui.roadmap.burn.estimate', { date: fmtDate(b.estimate) }) : t('ui.roadmap.burn.noEstimate');
    return {
      svg: `<svg class="rm-burn" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('ui.roadmap.burn.label'))}">${axes}${est}<path class="rm-burn-line" d="${d}" fill="none"/>${dots}</svg>`,
      note,
      estimate: b.estimate,
    };
  }

  /** 네 그림을 한 장으로 (HTML 내보내기용). CSS는 호출하는 쪽이 붙인다 */
  function dashboardHtml(rm, opts) {
    const burn = burndownSvg(rm, opts);
    return `<section class="rm-dash"><div class="rm-dash-top">${ringSvg(rm)}<div class="rm-dash-bars">${barsSvg(rm)}</div></div><h3>${esc(t('ui.roadmap.map.title'))}</h3><div class="rm-scroll">${mapSvg(rm, opts)}</div><h3>${esc(t('ui.roadmap.burn.title'))}</h3>${burn.svg}<p class="rm-note">${esc(burn.note)}</p></section>`;
  }

  return { CSS, CSS_LIGHT, GLYPH, ORDER, esc, fit, ringSvg, barsSvg, mapSvg, burndownSvg, dashboardHtml, fmtDate };
});
