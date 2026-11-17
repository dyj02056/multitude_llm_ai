// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/roadmap-docs.js)
// 로드맵 문서 만들기 (v0.38.0): 프로젝트 폴더에 docs/procedure.md(구현 단계 과정 설명서)와 README.md(한눈에 보는 소개)를 만든다.
// 문서는 앱이 가진 사실(작업 목록 · 상태 · 커밋 · 기록 · package.json · 폴더 구조)에서 직접 채우고, AI는 소개 문장(intro · features)만 맡는다.
// 갱신할 때는 표식 구역(<!-- mla:이름:start --> … <!-- mla:이름:end -->)만 바꿔서 사용자가 직접 쓴 글을 지키고,
// 표식 없는 기존 파일은 "별도 파일 · 끝에 붙이기 · 교체" 중 설정대로 다룬다 (기본: 별도 파일 — 있던 README를 덮어쓰지 않는다).
// 글을 쓰기 전에 비밀 정보 검사(scanDocs)를 한다. 파일을 쓰는 일은 화면(roadmap-ui.js)이 host.project로 한다 — 이 파일은 글만 만든다.
// Electron 앱(require)과 크롬 확장(전역 MLA.roadmapDocs)이 같이 쓴다.
//
// [쉽게 말하면] 진행 상황을 "구현 과정 설명서"와 "README"로 정리해 주는 부품입니다. 내가 따로 쓴 글은 건드리지 않습니다.
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(
    isNode ? require('./roadmap') : root.MLA && root.MLA.roadmap,
    isNode ? require('./secret-scan') : root.MLA && root.MLA.secretScan,
    isNode ? require('./i18n') : root.MLA && root.MLA.i18n,
  );
  if (isNode) module.exports = api;
  else (root.MLA = root.MLA || {}).roadmapDocs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (RM, SS, i18n) {
  'use strict';

  const PROCEDURE_PATH = 'docs/procedure.md';
  const README_PATH = 'README.md';
  const README_ALT = 'README.generated.md';
  const PROCEDURE_ALT = 'docs/procedure.generated.md';
  const STATE_PATH = '.mla/roadmap.json';
  const PROC_PARTS = ['overview', 'table', 'detail', 'progress', 'history'];
  const README_PARTS = ['intro', 'features', 'status', 'structure', 'usage'];

  const langOf = (l) => (l === 'ko' || l === 'en' ? l : (i18n && i18n.getLang && i18n.getLang()) || 'ko');

  const TXT = {
    ko: {
      procTitle: (n) => `${n} — 구현 절차`,
      procIntro: '이 문서는 계획서를 단계별 작업으로 나눈 결과와 진행 상황을 기록합니다. 표식 주석(`mla:`) 안쪽은 앱이 갱신하고, 바깥에 쓴 글은 그대로 남습니다.',
      overview: '개요',
      table: '단계 표',
      detail: '단계별 상세',
      progress: '진행 요약',
      history: '변경 이력',
      cols: ['마일스톤', '작업', '상태', '선행', '완료 조건'],
      status: { todo: '대기', doing: '진행 중', verify: '검증 중', done: '완료', blocked: '막힘' },
      total: (p) => `전체 진행률 **${p.pct}%** · 완료 ${p.done}/${p.total}개 작업`,
      updated: (d) => `마지막 갱신: ${d} (UTC)`,
      planNote: '계획서 요약',
      detailFields: { desc: '내용', files: '파일', accept: '완료 조건', deps: '선행 작업', note: '메모', commit: '커밋', done: '완료 시각' },
      none: '(없음)',
      noHistory: '아직 기록이 없습니다.',
      mermaidHead: '선행 관계 지도',
      statusCount: '상태별 작업 수',
      by: (m) => `마일스톤 ${m}`,
      readmeTitleSuffix: '',
      features: '주요 기능',
      statusH: '진행 현황',
      structure: '폴더 구조',
      usage: '사용 방법',
      stack: '기술 스택',
      install: '설치',
      run: '실행',
      scripts: '스크립트',
      moreDocs: (p) => `구현 단계 설명은 [${p}](${p})를 보세요.`,
      noIntro: '(소개 문장이 아직 없습니다 — 앱의 로드맵에서 "소개 문장 받기"를 눌러 채울 수 있습니다.)',
      noFeatures: '(주요 기능 목록이 아직 없습니다.)',
      progressLine: (p) => `진행률 ${p.pct}% (${p.done}/${p.total})`,
      nextUp: '다음 할 일',
    },
    en: {
      procTitle: (n) => `${n} — Implementation procedure`,
      procIntro: 'This document records how the plan was split into steps and how far each step has come. Text inside the `mla:` marker comments is refreshed by the app; text you write outside them is kept.',
      overview: 'Overview',
      table: 'Step table',
      detail: 'Step details',
      progress: 'Progress summary',
      history: 'Change history',
      cols: ['Milestone', 'Task', 'Status', 'Depends on', 'Done condition'],
      status: { todo: 'To do', doing: 'In progress', verify: 'Verifying', done: 'Done', blocked: 'Blocked' },
      total: (p) => `Overall progress **${p.pct}%** · ${p.done}/${p.total} tasks done`,
      updated: (d) => `Last updated: ${d} (UTC)`,
      planNote: 'Plan summary',
      detailFields: { desc: 'Details', files: 'Files', accept: 'Done condition', deps: 'Depends on', note: 'Note', commit: 'Commit', done: 'Finished' },
      none: '(none)',
      noHistory: 'No history yet.',
      mermaidHead: 'Dependency map',
      statusCount: 'Tasks by status',
      by: (m) => `Milestone ${m}`,
      readmeTitleSuffix: '',
      features: 'Features',
      statusH: 'Status',
      structure: 'Structure',
      usage: 'Usage',
      stack: 'Tech stack',
      install: 'Install',
      run: 'Run',
      scripts: 'Scripts',
      moreDocs: (p) => `See [${p}](${p}) for the implementation steps.`,
      noIntro: '(No intro yet — press "Get intro text" in the app\'s roadmap to fill it.)',
      noFeatures: '(No feature list yet.)',
      progressLine: (p) => `Progress ${p.pct}% (${p.done}/${p.total})`,
      nextUp: 'Up next',
    },
  };

  const GLYPH = { done: '✓', doing: '▶', verify: '◐', todo: '○', blocked: '✕' };
  const mdCell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
  const bar = (pct, n = 20) => `${'█'.repeat(Math.round((pct / 100) * n))}${'░'.repeat(n - Math.round((pct / 100) * n))}`;
  const stamp = (iso) => String(iso || '').slice(0, 16).replace('T', ' ');
  const block = (name, body) => `<!-- mla:${name}:start -->\n${String(body).replace(/\n+$/g, '')}\n<!-- mla:${name}:end -->`;

  // ---------- procedure.md ----------
  function mermaidOf(rm, tx) {
    const tasks = RM.tasksOf(rm);
    if (!tasks.length || tasks.length > 60) return '';
    const safe = (s) => String(s).replace(/["\\\n\r[\]{}()<>|#;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    const lines = ['```mermaid', 'flowchart LR'];
    rm.milestones.forEach((m, i) => {
      if (!m.tasks.length) return;
      lines.push(`  subgraph M${i + 1}["${safe(m.title)}"]`);
      for (const tk of m.tasks) lines.push(`    ${tk.id.replace(/[^A-Za-z0-9_]/g, '_')}["${GLYPH[tk.status]} ${safe(tk.title)}"]:::${tk.status}`);
      lines.push('  end');
    });
    for (const tk of tasks) for (const d of tk.deps) lines.push(`  ${d.replace(/[^A-Za-z0-9_]/g, '_')} --> ${tk.id.replace(/[^A-Za-z0-9_]/g, '_')}`);
    lines.push('  classDef done fill:#1f7a4d,color:#fff,stroke:#145a37', '  classDef verify fill:#2d6cb5,color:#fff,stroke:#1d4d83', '  classDef doing fill:#c98a0a,color:#fff,stroke:#8f6207', '  classDef blocked fill:#b3322f,color:#fff,stroke:#7f2321', '  classDef todo fill:#eceff3,color:#222,stroke:#9aa3ad', '```');
    return lines.join('\n');
  }

  /** procedure.md의 구역별 글 → { overview, table, detail, progress, history } */
  function buildProcedureSections(rm, { lang, mermaid = true } = {}) {
    const l = langOf(lang);
    const tx = TXT[l];
    const p = RM.progress(rm);
    const tasks = RM.tasksOf(rm);
    const next = RM.nextTask(rm);

    const overview = [
      `${tx.total(p)}`,
      '',
      `\`${bar(p.pct)}\` ${p.pct}%`,
      '',
      `${tx.updated(stamp(rm.updatedAt))}${next ? ` · ${tx.nextUp}: ${next.id} ${next.title}` : ''}`,
      ...(rm.plan ? ['', `> **${tx.planNote}**: ${rm.plan.replace(/\s+/g, ' ').trim().slice(0, 300)}${rm.plan.length > 300 ? '…' : ''}`] : []),
    ].join('\n');

    const rows = [`| ${tx.cols.join(' | ')} |`, `| ${tx.cols.map(() => '---').join(' | ')} |`];
    for (const m of rm.milestones) {
      for (const tk of m.tasks) rows.push(`| ${mdCell(m.title)} | ${mdCell(`${tk.id} ${tk.title}`)} | ${GLYPH[tk.status]} ${tx.status[tk.status]} | ${tk.deps.length ? tk.deps.join(', ') : '-'} | ${mdCell(tk.accept) || '-'} |`);
    }
    const table = rows.join('\n');

    const detail = rm.milestones
      .map((m) => {
        const mp = p.milestones.find((x) => x.id === m.id);
        const head = `### ${m.title} (${mp ? mp.pct : 0}%)`;
        const body = m.tasks.map((tk) => {
          const f = tx.detailFields;
          const out = [`#### ${GLYPH[tk.status]} ${tk.id} ${tk.title} — ${tx.status[tk.status]}`];
          if (tk.desc) out.push(`- ${f.desc}: ${tk.desc.replace(/\n+/g, ' ')}`);
          if (tk.files.length) out.push(`- ${f.files}: ${tk.files.map((x) => `\`${x}\``).join(', ')}`);
          if (tk.accept) out.push(`- ${f.accept}: ${tk.accept.replace(/\n+/g, ' ')}`);
          if (tk.deps.length) out.push(`- ${f.deps}: ${tk.deps.join(', ')}`);
          if (tk.commit) out.push(`- ${f.commit}: \`${tk.commit}\``);
          if (tk.doneAt) out.push(`- ${f.done}: ${stamp(tk.doneAt)}`);
          if (tk.note) out.push(`- ${f.note}: ${tk.note.replace(/\n+/g, ' ')}`);
          return out.join('\n');
        });
        return [head, ...body].join('\n\n');
      })
      .join('\n\n');

    const counts = RM.STATUSES.map((s) => `| ${GLYPH[s]} ${tx.status[s]} | ${p.counts[s]} | \`${bar(p.total ? (p.counts[s] / p.total) * 100 : 0, 12)}\` |`);
    const msLines = p.milestones.map((m) => `- ${tx.by(m.title)}: \`${bar(m.pct, 12)}\` ${m.pct}%`);
    const progress = [
      `| ${tx.statusCount} | # | |`,
      '| --- | ---: | --- |',
      ...counts,
      '',
      ...msLines,
      ...(mermaid && mermaidOf(rm, tx) ? ['', `**${tx.mermaidHead}**`, '', mermaidOf(rm, tx)] : []),
    ].join('\n');

    const history = rm.log.length
      ? rm.log
          .slice(-60)
          .reverse()
          .map((e) => {
            const tk = tasks.find((x) => x.id === e.task);
            return `- ${stamp(e.at)} — ${e.task} ${tk ? tk.title : ''}: ${GLYPH[e.status]} ${tx.status[e.status]}${e.note ? ` (${e.note.replace(/\n+/g, ' ')})` : ''}`;
          })
          .join('\n')
      : tx.noHistory;

    return { overview, table, detail, progress, history };
  }

  const PROC_HEAD = (rm, tx, lang) => ({
    overview: tx.overview,
    table: tx.table,
    detail: tx.detail,
    progress: tx.progress,
    history: tx.history,
  });

  function renderProcedure(rm, opts = {}) {
    const l = langOf(opts.lang);
    const tx = TXT[l];
    const s = buildProcedureSections(rm, opts);
    const heads = PROC_HEAD(rm, tx, l);
    return `# ${tx.procTitle(rm.title)}\n\n${tx.procIntro}\n\n${PROC_PARTS.map((k) => `## ${heads[k]}\n\n${block(k, s[k])}`).join('\n\n')}\n`;
  }

  // ---------- README ----------
  /**
   * 프로젝트 사실에서 README 구역 글을 만든다.
   * info: { pkg: package.json 내용 | null, top: [{ name, kind: 'dir'|'file' }] } — 화면이 폴더에서 읽어 넘긴다.
   */
  function buildReadmeSections(rm, { lang, pkg = null, top = [] } = {}) {
    const l = langOf(lang);
    const tx = TXT[l];
    const p = RM.progress(rm);
    const intro = [rm.docs?.intro || pkg?.description || tx.noIntro, `\n\n\`${bar(p.pct)}\` **${tx.progressLine(p)}**`].join('');
    const features = rm.docs?.features?.length ? rm.docs.features.map((f) => `- ${f}`).join('\n') : tx.noFeatures;

    const doneList = RM.tasksOf(rm).filter((t) => t.status === 'done').slice(-5).reverse();
    const next = RM.nextTask(rm);
    const status = [
      `| ${tx.cols[0]} | % |`,
      '| --- | ---: |',
      ...p.milestones.map((m) => `| ${mdCell(m.title)} | ${m.pct}% |`),
      '',
      tx.moreDocs(PROCEDURE_PATH),
      ...(next ? ['', `**${tx.nextUp}**: ${next.id} ${next.title}`] : []),
      ...(doneList.length ? ['', doneList.map((t) => `- ✓ ${t.id} ${t.title}`).join('\n')] : []),
    ].join('\n');

    const shown = top
      .filter((e) => e && typeof e.name === 'string' && !/^\.(git|mla)$/.test(e.name) && e.name !== 'node_modules')
      .slice(0, 30)
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
    const structure = shown.length ? `\`\`\`text\n${shown.map((e) => `${e.name}${e.kind === 'dir' ? '/' : ''}`).join('\n')}\n\`\`\`` : tx.none;

    const usage = [];
    if (pkg) {
      const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }).slice(0, 8);
      if (deps.length) usage.push(`**${tx.stack}**: ${deps.map((d) => `\`${d}\``).join(', ')}`);
      usage.push('', `**${tx.install}**`, '', '```bash', 'npm install', '```');
      const scripts = Object.keys(pkg.scripts || {}).slice(0, 8);
      if (scripts.length) usage.push('', `**${tx.scripts}**`, '', ...scripts.map((k) => `- \`npm run ${k}\``));
    } else usage.push(tx.none);

    return { intro, features, status, structure, usage: usage.join('\n') };
  }

  function renderReadme(rm, opts = {}) {
    const l = langOf(opts.lang);
    const tx = TXT[l];
    const s = buildReadmeSections(rm, opts);
    const heads = { features: tx.features, status: tx.statusH, structure: tx.structure, usage: tx.usage };
    return `# ${rm.title}\n\n${block('intro', s.intro)}\n\n${['features', 'status', 'structure', 'usage'].map((k) => `## ${heads[k]}\n\n${block(k, s[k])}`).join('\n\n')}\n`;
  }

  // ---------- 표식 구역 갱신 ----------
  const markerRe = (name) => new RegExp(`<!-- mla:${name}:start -->[\\s\\S]*?<!-- mla:${name}:end -->`);
  const hasMarkers = (text) => /<!-- mla:[a-z]+:start -->/.test(String(text || ''));

  /** 기존 글의 표식 구역만 새 글로 바꾼다. 표식이 없는 구역(새로 생긴 것)은 끝에 붙인다. → { text, replaced: [이름], added: [이름] } */
  function applyMarkers(existing, sections, heads = {}) {
    let text = String(existing || '');
    const replaced = [];
    const added = [];
    for (const [name, body] of Object.entries(sections)) {
      const re = markerRe(name);
      if (re.test(text)) {
        text = text.replace(re, () => block(name, body)); // 함수로 넘겨 $ 기호를 그대로 둔다
        replaced.push(name);
      } else {
        text = `${text.replace(/\n*$/, '\n\n')}${heads[name] ? `## ${heads[name]}\n\n` : ''}${block(name, body)}\n`;
        added.push(name);
      }
    }
    return { text, replaced, added };
  }

  /**
   * 어떻게 쓸지 정한다 (파일은 쓰지 않는다).
   * kind: 'procedure' | 'readme', existing: 기본 경로의 글(없으면 null), existingAlt: 별도 파일 경로의 글(없으면 null)
   * mode: 'separate' | 'merge' | 'replace' (표식 있는 파일은 모드와 상관없이 그 자리에서 표식 구역만 갱신)
   * → { path, text, action: 'create' | 'update' | 'separate' | 'merge' | 'replace' | 'unchanged' }
   */
  function planWrite({ kind, rm, existing = null, existingAlt = null, mode = 'separate', lang, mermaid = true, pkg = null, top = [] }) {
    const isProc = kind === 'procedure';
    const l = langOf(lang);
    const tx = TXT[l];
    const path = isProc ? PROCEDURE_PATH : README_PATH;
    const alt = isProc ? PROCEDURE_ALT : README_ALT;
    const opts = { lang: l, mermaid, pkg, top };
    const sections = isProc ? buildProcedureSections(rm, opts) : buildReadmeSections(rm, opts);
    const heads = isProc ? PROC_HEAD(rm, tx, l) : { features: tx.features, status: tx.statusH, structure: tx.structure, usage: tx.usage };
    const full = () => (isProc ? renderProcedure(rm, opts) : renderReadme(rm, opts));
    const done = (p, text, action, prev) => ({ path: p, text, action: text === prev ? 'unchanged' : action });

    if (existing == null) return { path, text: full(), action: 'create' };
    if (hasMarkers(existing)) return done(path, applyMarkers(existing, sections, heads).text, 'update', existing);
    if (mode === 'replace') return done(path, full(), 'replace', existing);
    if (mode === 'merge') {
      const parts = Object.entries(sections).map(([k, v]) => `## ${heads[k] || k}\n\n${block(k, v)}`);
      return done(path, `${existing.replace(/\n*$/, '\n\n')}${parts.join('\n\n')}\n`, 'merge', existing);
    }
    // separate: 있던 파일은 그대로 두고 별도 파일에 쓴다 (별도 파일이 이미 있으면 그 표식 구역만 갱신)
    if (existingAlt != null && hasMarkers(existingAlt)) return done(alt, applyMarkers(existingAlt, sections, heads).text, 'separate', existingAlt);
    return { path: alt, text: full(), action: 'separate' };
  }

  /** 쓸 글들에 비밀 정보로 보이는 것이 있는지 → [{ path, labels: [글] }] (비어 있으면 안전) */
  function scanDocs(files) {
    const out = [];
    for (const f of files || []) {
      const hits = SS && SS.scanSecrets ? SS.scanSecrets(String(f.text || '')) : [];
      if (hits && hits.length) out.push({ path: f.path, labels: hits.map((h) => h.name || h.label || '?') });
    }
    return out;
  }

  return {
    PROCEDURE_PATH,
    README_PATH,
    README_ALT,
    PROCEDURE_ALT,
    STATE_PATH,
    PROC_PARTS,
    README_PARTS,
    buildProcedureSections,
    renderProcedure,
    buildReadmeSections,
    renderReadme,
    hasMarkers,
    applyMarkers,
    planWrite,
    scanDocs,
    mermaidOf,
  };
});
