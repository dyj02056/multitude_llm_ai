// 로드맵 (v0.38.0): 프로젝트 계획서를 마일스톤 → 작업으로 쪼개고, 작업마다 진행 상태를 기록해 진행률 · 번다운을 계산한다.
// 이 파일은 (1) 계획서 → 단계 분해 요청 글 · AI 답(JSON) 읽기 · 검사 (2) 작업 상태 · 순서(선행 관계) · 편집
// (3) 작업별 구현 요청 글 (4) 진행률 · 번다운 계산을 한다. 화면(roadmap-ui.js), 그림(roadmap-charts.js), 문서(roadmap-docs.js)가 이 계산을 쓴다.
// Electron 앱(require)과 크롬 확장 프로그램(전역 MLA.roadmap)이 같이 쓴다. 파일 · 화면에는 손대지 않는 순수 계산이다.
//
// [쉽게 말하면] "계획서를 AI에게 보여 주고 일감(작업) 목록으로 나눠 받은 뒤, 일감마다 어디까지 했는지 세는" 부품입니다.
// AI가 준 목록이 이상하면(돌고 도는 선행 관계, 빈 제목 등) 여기서 걸러 내거나 경고합니다.
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./i18n') : root.MLA && root.MLA.i18n);
  if (isNode) module.exports = api;
  else (root.MLA = root.MLA || {}).roadmap = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (i18n) {
  'use strict';

  const STATUSES = ['todo', 'doing', 'verify', 'done', 'blocked'];
  // 진행률에 치는 몫: 완료 100% · 검증 중 80% · 진행 중 40% · 대기 · 막힘 0%
  const STATUS_SHARE = { todo: 0, doing: 0.4, verify: 0.8, done: 1, blocked: 0 };
  const MAX_TASKS = 200;
  const MAX_PLAN_CHARS = 60000;
  const MAX_TEXT = 4000;
  const FILE_VERSION = 1;
  const DEFAULT_SETTINGS = { docs: true, docsWhen: 'task', readmeMode: 'separate', docsLang: 'auto', mermaid: true, autoCommit: false };
  const DOCS_WHEN = ['task', 'milestone', 'manual'];
  const README_MODES = ['separate', 'merge', 'replace'];

  const langOf = (l) => (l === 'ko' || l === 'en' ? l : (i18n && i18n.getLang && i18n.getLang()) || 'ko');
  const str = (v, max = MAX_TEXT) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const uniq = (a) => [...new Set(a)];
  const isoOf = (now) => new Date(now instanceof Date ? now : now || Date.now()).toISOString();

  // ---------- 요청 글 ----------
  const TXT = {
    ko: {
      decompose: (plan, tree) =>
        `아래 프로젝트 계획서를 읽고, 프로젝트를 끝까지 구현하는 단계별 작업 목록으로 쪼개 주세요.\n\n[규칙]\n- 마일스톤(큰 단계) 3~8개, 마일스톤마다 작업 2~8개. 작업 하나는 한 번의 대화로 구현·확인할 수 있는 크기로 쪼갭니다.\n- 작업마다: id(t1, t2 …), title(짧게), desc(무엇을 만드는지), deps(먼저 끝나야 하는 작업 id 목록), files(건드릴 파일 경로 예상), accept(끝났다고 볼 조건 — 확인할 수 있게 구체적으로), weight(1~5, 작업 크기).\n- 선행 관계(deps)는 돌고 돌지 않게 하세요.\n- 아래 JSON 형식 그대로, 코드 블록 하나로만 답하세요. 설명 글은 쓰지 마세요.\n\n\`\`\`json\n{"title":"프로젝트 이름","milestones":[{"id":"m1","title":"마일스톤 이름","tasks":[{"id":"t1","title":"…","desc":"…","deps":[],"files":["src/a.js"],"accept":"…","weight":2}]}]}\n\`\`\`\n${tree ? `\n[현재 프로젝트 구조]\n${tree}\n` : ''}\n[프로젝트 계획서]\n${plan}`,
      task: (o) =>
        `프로젝트 "${o.title}"의 작업 하나를 구현해 주세요.\n\n[이번 작업] ${o.task.id} ${o.task.title}\n${o.task.desc ? `내용: ${o.task.desc}\n` : ''}${o.task.files.length ? `건드릴 파일(예상): ${o.task.files.join(', ')}\n` : ''}완료 조건: ${o.task.accept || '(정해지지 않음 — 스스로 합리적으로 정해 밝혀 주세요)'}\n\n${o.done.length ? `[이미 끝난 작업]\n${o.done.map((d) => `- ${d.id} ${d.title}`).join('\n')}\n\n` : ''}${o.next.length ? `[이 작업 뒤에 이어질 작업 — 미리 만들지 마세요]\n${o.next.map((d) => `- ${d.id} ${d.title}`).join('\n')}\n\n` : ''}[규칙]\n- 이번 작업 범위만 구현하세요.\n- 끝에 "완료 조건 점검"으로 조건마다 충족 여부를 한 줄씩 적어 주세요.`,
      docsAsk: (o) =>
        `아래는 프로젝트 "${o.title}"의 작업 목록입니다. README에 넣을 소개를 만들어 주세요.\n\n[규칙]\n- intro: 이 프로젝트가 무엇인지 1~2문장.\n- features: 주요 기능 3~8개, 각각 한 줄.\n- 아래 JSON 코드 블록 하나로만 답하세요.\n\n\`\`\`json\n{"intro":"…","features":["…"]}\n\`\`\`\n\n[작업 목록]\n${o.list}`,
      clipped: '…(이하 생략)',
    },
    en: {
      decompose: (plan, tree) =>
        `Read the project plan below and split it into step-by-step tasks that carry the project through to the end.\n\n[Rules]\n- 3-8 milestones, 2-8 tasks per milestone. Size each task so one conversation can implement and check it.\n- Per task: id (t1, t2 …), title (short), desc (what to build), deps (ids of tasks that must finish first), files (expected file paths), accept (a concrete, checkable done condition), weight (1-5, task size).\n- Keep deps free of cycles.\n- Answer with exactly one code block in the JSON shape below and no other prose.\n\n\`\`\`json\n{"title":"Project name","milestones":[{"id":"m1","title":"Milestone name","tasks":[{"id":"t1","title":"…","desc":"…","deps":[],"files":["src/a.js"],"accept":"…","weight":2}]}]}\n\`\`\`\n${tree ? `\n[Current project structure]\n${tree}\n` : ''}\n[Project plan]\n${plan}`,
      task: (o) =>
        `Implement one task of the project "${o.title}".\n\n[This task] ${o.task.id} ${o.task.title}\n${o.task.desc ? `Details: ${o.task.desc}\n` : ''}${o.task.files.length ? `Expected files: ${o.task.files.join(', ')}\n` : ''}Done condition: ${o.task.accept || '(not set — pick a reasonable one and state it)'}\n\n${o.done.length ? `[Already done]\n${o.done.map((d) => `- ${d.id} ${d.title}`).join('\n')}\n\n` : ''}${o.next.length ? `[Coming after this task — do not build ahead]\n${o.next.map((d) => `- ${d.id} ${d.title}`).join('\n')}\n\n` : ''}[Rules]\n- Implement only this task's scope.\n- End with a "Done check" listing, one line per condition, whether it is met.`,
      docsAsk: (o) =>
        `Below is the task list of the project "${o.title}". Write the intro for its README.\n\n[Rules]\n- intro: what this project is, in 1-2 sentences.\n- features: 3-8 main features, one line each.\n- Answer with exactly one JSON code block.\n\n\`\`\`json\n{"intro":"…","features":["…"]}\n\`\`\`\n\n[Task list]\n${o.list}`,
      clipped: '…(truncated)',
    },
  };

  const clip = (s, max, lang) => (s.length <= max ? s : `${s.slice(0, max)}\n${TXT[lang].clipped}`);

  /** 계획서(+프로젝트 구조) → "작업 목록으로 쪼개 달라"는 요청 글 */
  function buildDecomposePrompt({ plan, tree = '', lang } = {}) {
    const l = langOf(lang);
    return TXT[l].decompose(clip(str(plan, MAX_PLAN_CHARS * 2), MAX_PLAN_CHARS, l), clip(str(tree, 12000), 6000, l));
  }

  // ---------- AI 답 읽기 ----------
  /** 답 글에서 JSON 한 덩어리를 뽑는다: ```json 블록 → 아무 코드 블록 → 첫 { 부터 짝이 맞는 } 까지 */
  function extractJson(text) {
    const s = String(text || '');
    const tries = [];
    for (const m of s.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)) tries.push(m[1]);
    const first = s.indexOf('{');
    if (first >= 0) {
      let depth = 0;
      let inStr = false;
      for (let i = first; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
          if (c === '\\') i++;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) {
          tries.push(s.slice(first, i + 1));
          break;
        }
      }
    }
    for (const c of tries) {
      try {
        const v = JSON.parse(c.trim());
        if (v && typeof v === 'object') return v;
      } catch {}
    }
    return null;
  }

  const cleanList = (v, max) => (Array.isArray(v) ? uniq(v.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean)).slice(0, max) : []);
  const cleanWeight = (v) => Math.min(5, Math.max(1, Math.round(Number(v)) || 1));
  const cleanStatus = (v) => (STATUSES.includes(v) ? v : 'todo');

  /** 저장 · AI 답에서 온 로드맵 정리 (모르는 칸은 버리고, 빠진 id는 만들고, 선행 관계는 id나 제목으로 찾아 id로 바꾼다) */
  function normalizeRoadmap(raw, { now } = {}) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const usedIds = new Set();
    const idByRaw = new Map(); // AI가 쓴 id · 제목 → 정리된 id
    const milestones = [];
    let n = 0;
    let mn = 0;
    const takeId = (want, prefix, counter) => {
      let id = /^[A-Za-z0-9_-]{1,24}$/.test(want || '') ? want : '';
      while (!id || usedIds.has(id)) id = `${prefix}${++counter.n}`;
      usedIds.add(id);
      return id;
    };
    const tc = { n: 0 };
    const mc = { n: 0 };
    for (const rm of Array.isArray(r.milestones) ? r.milestones : []) {
      if (!rm || typeof rm !== 'object') continue;
      const mid = takeId(str(rm.id, 24), 'm', mc);
      const tasks = [];
      for (const rt of Array.isArray(rm.tasks) ? rm.tasks : []) {
        if (!rt || typeof rt !== 'object' || n >= MAX_TASKS) continue;
        const title = str(rt.title, 200);
        if (!title) continue;
        const id = takeId(str(rt.id, 24), 't', tc);
        n++;
        if (typeof rt.id === 'string') idByRaw.set(rt.id.trim(), id);
        idByRaw.set(title, id);
        tasks.push({
          id,
          title,
          desc: str(rt.desc),
          deps: cleanList(rt.deps, 30), // 아래에서 id로 바꾼다
          files: cleanList(rt.files, 20).map((f) => f.slice(0, 260)),
          accept: str(rt.accept),
          weight: cleanWeight(rt.weight),
          status: cleanStatus(rt.status),
          doneAt: typeof rt.doneAt === 'string' && !Number.isNaN(Date.parse(rt.doneAt)) ? rt.doneAt : '',
          note: str(rt.note, 600),
          commit: /^[0-9a-f]{7,40}$/i.test(rt.commit || '') ? rt.commit : '',
        });
      }
      if (tasks.length || str(rm.title)) milestones.push({ id: mid, title: str(rm.title, 200) || `M${++mn}`, tasks });
    }
    const all = new Set(milestones.flatMap((m) => m.tasks.map((t) => t.id)));
    for (const m of milestones) {
      for (const t of m.tasks) {
        t.deps = uniq(t.deps.map((d) => (all.has(d) ? d : idByRaw.get(d) || '')).filter((d) => d && d !== t.id && all.has(d)));
        if (t.status === 'done' && !t.doneAt) t.doneAt = isoOf(now);
        if (t.status !== 'done') t.doneAt = '';
      }
    }
    const s = r.settings && typeof r.settings === 'object' ? r.settings : {};
    const settings = {
      docs: s.docs !== false,
      docsWhen: DOCS_WHEN.includes(s.docsWhen) ? s.docsWhen : DEFAULT_SETTINGS.docsWhen,
      readmeMode: README_MODES.includes(s.readmeMode) ? s.readmeMode : DEFAULT_SETTINGS.readmeMode,
      docsLang: ['auto', 'ko', 'en'].includes(s.docsLang) ? s.docsLang : 'auto',
      mermaid: s.mermaid !== false,
      autoCommit: s.autoCommit === true,
    };
    const docs = r.docs && typeof r.docs === 'object' ? { intro: str(r.docs.intro, 600), features: cleanList(r.docs.features, 12).map((f) => f.slice(0, 200)) } : { intro: '', features: [] };
    const log = (Array.isArray(r.log) ? r.log : [])
      .filter((e) => e && typeof e === 'object' && all.has(e.task) && STATUSES.includes(e.status) && !Number.isNaN(Date.parse(e.at)))
      .slice(-500)
      .map((e) => ({ at: new Date(e.at).toISOString(), task: e.task, status: e.status, note: str(e.note, 300) }));
    const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : isoOf(now));
    return {
      version: FILE_VERSION,
      title: str(r.title, 120) || 'Project',
      plan: str(r.plan, MAX_PLAN_CHARS),
      createdAt: iso(r.createdAt),
      updatedAt: iso(r.updatedAt),
      milestones,
      settings,
      docs,
      log,
    };
  }

  // ---------- 순서 · 검사 ----------
  const tasksOf = (rm) => (rm?.milestones || []).flatMap((m) => m.tasks.map((t) => ({ ...t, milestone: m.id })));
  const findTask = (rm, id) => tasksOf(rm).find((t) => t.id === id) || null;

  /** 선행 관계가 돌고 도는 작업 id 목록 (없으면 []) */
  function findCycle(rm) {
    const deps = new Map(tasksOf(rm).map((t) => [t.id, t.deps]));
    const state = new Map(); // 1 방문 중 · 2 끝
    const stack = [];
    let found = [];
    const visit = (id) => {
      if (found.length) return;
      if (state.get(id) === 2) return;
      if (state.get(id) === 1) {
        found = stack.slice(stack.indexOf(id));
        return;
      }
      state.set(id, 1);
      stack.push(id);
      for (const d of deps.get(id) || []) visit(d);
      stack.pop();
      state.set(id, 2);
    };
    for (const id of deps.keys()) visit(id);
    return found;
  }

  /** → { errors: [글], warnings: [글] }. 오류가 있으면 쓸 수 없다 (작업 없음 · 선행 관계가 돎) */
  function validateRoadmap(rm, { lang } = {}) {
    const ko = langOf(lang) === 'ko';
    const errors = [];
    const warnings = [];
    const tasks = tasksOf(rm);
    if (!tasks.length) errors.push(ko ? '작업이 하나도 없습니다.' : 'There are no tasks.');
    const cyc = findCycle(rm);
    if (cyc.length) errors.push(ko ? `선행 관계가 돌고 돕니다: ${cyc.join(' → ')}` : `Dependencies form a cycle: ${cyc.join(' → ')}`);
    for (const t of tasks) {
      if (!t.accept) warnings.push(ko ? `${t.id} "${t.title}": 완료 조건이 비어 있습니다.` : `${t.id} "${t.title}": the done condition is empty.`);
      if (t.weight >= 5) warnings.push(ko ? `${t.id} "${t.title}": 작업이 너무 클 수 있습니다 — 더 쪼개 보세요.` : `${t.id} "${t.title}": may be too big — consider splitting it.`);
    }
    for (const m of rm?.milestones || []) if (!m.tasks.length) warnings.push(ko ? `마일스톤 "${m.title}"에 작업이 없습니다.` : `Milestone "${m.title}" has no tasks.`);
    return { errors, warnings };
  }

  /**
   * AI 답 글 → { ok: true, roadmap, warnings } | { ok: false, error }
   * JSON을 못 읽거나, 작업이 없거나, 선행 관계가 돌고 돌면 실패. 고쳐 달라고 다시 요청할 수 있게 이유를 돌려준다.
   */
  function parseDecomposition(text, { plan = '', now, lang } = {}) {
    const ko = langOf(lang) === 'ko';
    const json = extractJson(text);
    if (!json) return { ok: false, error: ko ? 'JSON 코드 블록을 찾지 못했습니다. AI에게 형식대로 다시 답해 달라고 하세요.' : 'No JSON code block found. Ask the AI to answer in the requested format.' };
    const rm = normalizeRoadmap({ ...json, plan }, { now });
    const v = validateRoadmap(rm, { lang });
    if (v.errors.length) return { ok: false, error: v.errors.join(' ') };
    return { ok: true, roadmap: rm, warnings: v.warnings };
  }

  /** README 소개 요청에 대한 AI 답 → { intro, features } | null */
  function parseDocsInfo(text) {
    const j = extractJson(text);
    if (!j) return null;
    const intro = str(j.intro, 600);
    const features = cleanList(j.features, 12).map((f) => f.slice(0, 200));
    return intro || features.length ? { intro, features } : null;
  }

  function buildDocsPrompt(rm, { lang } = {}) {
    const l = langOf(lang);
    const list = tasksOf(rm)
      .map((t) => `- ${t.title}${t.desc ? `: ${t.desc}` : ''}`)
      .join('\n');
    return TXT[l].docsAsk({ title: rm.title, list: clip(list, 8000, l) });
  }

  // ---------- 진행 ----------
  /** 작업이 잠겼는지: 선행 작업이 모두 완료돼야 열린다 */
  function blockedBy(rm, task) {
    const byId = new Map(tasksOf(rm).map((t) => [t.id, t]));
    return (task.deps || []).filter((d) => byId.get(d) && byId.get(d).status !== 'done');
  }
  const isUnlocked = (rm, task) => blockedBy(rm, task).length === 0;

  /** 지금 할 만한 작업: 진행 중 → 검증 중 → 열려 있는 대기 작업(위에서부터). 없으면 null */
  function nextTask(rm) {
    const all = tasksOf(rm);
    return all.find((t) => t.status === 'doing') || all.find((t) => t.status === 'verify') || all.find((t) => t.status === 'todo' && isUnlocked(rm, t)) || null;
  }

  /** 가중치 기준 진행률 · 상태별 개수 · 마일스톤별 */
  function progress(rm) {
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    const wsum = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    const part = (tasks) => {
      let total = 0;
      let got = 0;
      const c = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      for (const t of tasks) {
        total += t.weight;
        got += t.weight * STATUS_SHARE[t.status];
        c[t.status]++;
      }
      return { total, got, counts: c, n: tasks.length };
    };
    for (const t of tasksOf(rm)) {
      counts[t.status]++;
      wsum[t.status] += t.weight;
    }
    const all = part(tasksOf(rm));
    const ms = (rm?.milestones || []).map((m) => {
      const p = part(m.tasks);
      return { id: m.id, title: m.title, counts: p.counts, n: p.n, pct: p.total ? Math.round((p.got / p.total) * 100) : 0, done: p.n > 0 && p.counts.done === p.n };
    });
    return {
      pct: all.total ? Math.round((all.got / all.total) * 100) : 0,
      done: counts.done,
      total: all.n,
      weightTotal: all.total,
      weightDone: wsum.done,
      counts,
      weights: wsum,
      milestones: ms,
    };
  }

  /**
   * 상태 바꾸기 → { ok: true, roadmap, changed } | { ok: false, error }
   * 선행 작업이 끝나지 않은 작업은 진행 · 검증 · 완료로 못 옮긴다 (막힘 · 대기로는 가능).
   * 완료로 옮기면 doneAt을 적고, 완료에서 되돌리면 지운다. 바뀔 때마다 기록(log)에 남긴다.
   */
  function setStatus(rm, id, status, { now, note = '', commit = '', lang } = {}) {
    const ko = langOf(lang) === 'ko';
    const cur = findTask(rm, id);
    if (!cur) return { ok: false, error: ko ? '없는 작업입니다.' : 'No such task.' };
    if (!STATUSES.includes(status)) return { ok: false, error: ko ? '알 수 없는 상태입니다.' : 'Unknown status.' };
    if (['doing', 'verify', 'done'].includes(status)) {
      const wait = blockedBy(rm, cur);
      if (wait.length) return { ok: false, error: ko ? `먼저 끝내야 할 작업이 있습니다: ${wait.join(', ')}` : `Finish these first: ${wait.join(', ')}` };
    }
    if (cur.status === status && !note && !commit) return { ok: true, roadmap: rm, changed: false };
    const at = isoOf(now);
    const next = {
      ...rm,
      updatedAt: at,
      milestones: rm.milestones.map((m) => ({
        ...m,
        tasks: m.tasks.map((t) =>
          t.id !== id
            ? t
            : { ...t, status, doneAt: status === 'done' ? t.doneAt || at : '', note: str(note, 600) || t.note, commit: /^[0-9a-f]{7,40}$/i.test(commit) ? commit : t.commit },
        ),
      })),
      log: [...rm.log, { at, task: id, status, note: str(note, 300) }].slice(-500),
    };
    return { ok: true, roadmap: next, changed: true };
  }

  // ---------- 편집 ----------
  const mapTasks = (rm, fn) => ({ ...rm, milestones: rm.milestones.map((m) => ({ ...m, tasks: m.tasks.map(fn) })) });

  function nextTaskId(rm) {
    const used = new Set(tasksOf(rm).map((t) => t.id));
    let n = used.size;
    while (used.has(`t${++n}`));
    return `t${n}`;
  }

  /** 작업 추가: 마일스톤 맨 뒤에 붙인다 */
  function addTask(rm, milestoneId, fields = {}) {
    const title = str(fields.title, 200);
    if (!title || !rm.milestones.some((m) => m.id === milestoneId)) return rm;
    const id = nextTaskId(rm);
    const task = normalizeRoadmap({ milestones: [{ id: 'x', tasks: [{ ...fields, id, title, status: 'todo' }] }] }).milestones[0].tasks[0];
    const ids = new Set(tasksOf(rm).map((t) => t.id));
    task.id = id;
    task.deps = cleanList(fields.deps, 30).filter((d) => ids.has(d));
    return { ...rm, milestones: rm.milestones.map((m) => (m.id === milestoneId ? { ...m, tasks: [...m.tasks, task] } : m)) };
  }

  /** 작업 고치기 (제목 · 내용 · 파일 · 완료 조건 · 가중치 · 선행). 선행이 돌고 돌게 되면 고치지 않는다 */
  function updateTask(rm, id, patch = {}) {
    const ids = new Set(tasksOf(rm).map((t) => t.id));
    const next = mapTasks(rm, (t) => {
      if (t.id !== id) return t;
      const o = { ...t };
      if (typeof patch.title === 'string' && patch.title.trim()) o.title = str(patch.title, 200);
      if (typeof patch.desc === 'string') o.desc = str(patch.desc);
      if (typeof patch.accept === 'string') o.accept = str(patch.accept);
      if (Array.isArray(patch.files)) o.files = cleanList(patch.files, 20);
      if (patch.weight !== undefined) o.weight = cleanWeight(patch.weight);
      if (Array.isArray(patch.deps)) o.deps = cleanList(patch.deps, 30).filter((d) => d !== id && ids.has(d));
      return o;
    });
    return findCycle(next).length ? rm : { ...next, updatedAt: rm.updatedAt };
  }

  /** 작업 지우기: 다른 작업의 선행 목록에서도 뺀다 */
  function removeTask(rm, id) {
    return {
      ...rm,
      milestones: rm.milestones.map((m) => ({ ...m, tasks: m.tasks.filter((t) => t.id !== id).map((t) => ({ ...t, deps: t.deps.filter((d) => d !== id) })) })),
      log: rm.log.filter((e) => e.task !== id),
    };
  }

  /** 작업을 같은 마일스톤 안에서 위(-1) · 아래(+1)로 옮긴다 */
  function moveTask(rm, id, dir) {
    return {
      ...rm,
      milestones: rm.milestones.map((m) => {
        const i = m.tasks.findIndex((t) => t.id === id);
        const j = i + (dir < 0 ? -1 : 1);
        if (i < 0 || j < 0 || j >= m.tasks.length) return m;
        const tasks = m.tasks.slice();
        [tasks[i], tasks[j]] = [tasks[j], tasks[i]];
        return { ...m, tasks };
      }),
    };
  }

  /** 두 작업 합치기: b를 a에 합친다 (제목 · 내용 · 조건은 이어 붙이고, 파일 · 선행은 합치고, 가중치는 더한다(최대 5)). b를 가리키던 선행은 a로 바꾼다 */
  function mergeTasks(rm, aId, bId) {
    const a = findTask(rm, aId);
    const b = findTask(rm, bId);
    if (!a || !b || aId === bId) return rm;
    const join = (x, y, sep) => [x, y].filter(Boolean).join(sep);
    const merged = {
      ...a,
      title: join(a.title, b.title, ' + ').slice(0, 200),
      desc: join(a.desc, b.desc, '\n').slice(0, MAX_TEXT),
      accept: join(a.accept, b.accept, '\n').slice(0, MAX_TEXT),
      files: uniq([...a.files, ...b.files]).slice(0, 20),
      deps: uniq([...a.deps, ...b.deps]).filter((d) => d !== aId && d !== bId),
      weight: Math.min(5, a.weight + b.weight),
      status: a.status === 'done' && b.status === 'done' ? 'done' : a.status === 'done' || b.status === 'done' ? 'doing' : a.status,
    };
    delete merged.milestone;
    const fixed = {
      ...rm,
      milestones: rm.milestones.map((m) => ({
        ...m,
        tasks: m.tasks
          .filter((t) => t.id !== bId)
          .map((t) => (t.id === aId ? merged : { ...t, deps: uniq(t.deps.map((d) => (d === bId ? aId : d)).filter((d) => d !== t.id)) })),
      })),
      log: rm.log.filter((e) => e.task !== bId),
    };
    return findCycle(fixed).length ? rm : fixed;
  }

  /** 마일스톤 추가 (맨 뒤) */
  function addMilestone(rm, title) {
    const t = str(title, 200);
    if (!t) return rm;
    const used = new Set(rm.milestones.map((m) => m.id));
    let n = used.size;
    while (used.has(`m${++n}`));
    return { ...rm, milestones: [...rm.milestones, { id: `m${n}`, title: t, tasks: [] }] };
  }

  // ---------- 작업별 구현 요청 글 ----------
  /** 한 작업을 구현해 달라는 요청 글 (끝난 작업 · 뒤에 이어질 작업의 제목만 덧붙인다 — 새 대화로 시작해도 맥락이 이어지게) */
  function buildTaskPrompt(rm, taskId, { lang } = {}) {
    const l = langOf(lang);
    const task = findTask(rm, taskId);
    if (!task) return '';
    const all = tasksOf(rm);
    return TXT[l].task({
      title: rm.title,
      task,
      done: all.filter((t) => t.status === 'done' && t.id !== taskId).slice(-30),
      next: all.filter((t) => t.deps.includes(taskId)).slice(0, 10),
    });
  }

  // ---------- 번다운 ----------
  /**
   * 번다운: 처음 가중치 합에서 완료된 작업(doneAt 순)의 가중치를 빼 간다.
   * → { total, points: [{ at(ms), remaining }], start(ms), estimate(ms) | null }
   * estimate: 지금까지 하루 평균 완료 가중치로 남은 양을 끝내는 날 (완료가 2건 미만이거나 기간이 0이면 null)
   */
  function burndown(rm, { now } = {}) {
    const tasks = tasksOf(rm);
    const total = tasks.reduce((s, t) => s + t.weight, 0);
    const start = Date.parse(rm?.createdAt) || Date.now();
    const done = tasks.filter((t) => t.status === 'done' && t.doneAt).sort((a, b) => Date.parse(a.doneAt) - Date.parse(b.doneAt));
    let remaining = total;
    const points = [{ at: start, remaining: total }];
    for (const t of done) {
      remaining -= t.weight;
      points.push({ at: Math.max(Date.parse(t.doneAt), start), remaining });
    }
    const nowMs = now === undefined ? Date.now() : +new Date(now);
    let estimate = null;
    const spanDays = (Math.max(nowMs, points[points.length - 1].at) - start) / 86400000;
    if (done.length >= 2 && spanDays > 0 && remaining > 0) {
      const perDay = (total - remaining) / spanDays;
      if (perDay > 0) estimate = nowMs + (remaining / perDay) * 86400000;
    }
    return { total, points, start, estimate, now: nowMs };
  }

  return {
    STATUSES,
    STATUS_SHARE,
    DEFAULT_SETTINGS,
    DOCS_WHEN,
    README_MODES,
    MAX_TASKS,
    MAX_PLAN_CHARS,
    buildDecomposePrompt,
    extractJson,
    normalizeRoadmap,
    parseDecomposition,
    parseDocsInfo,
    buildDocsPrompt,
    validateRoadmap,
    findCycle,
    tasksOf,
    findTask,
    blockedBy,
    isUnlocked,
    nextTask,
    progress,
    setStatus,
    addTask,
    updateTask,
    removeTask,
    moveTask,
    mergeTasks,
    addMilestone,
    buildTaskPrompt,
    burndown,
  };
});
