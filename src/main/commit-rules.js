'use strict';

// 적용 후 커밋 (v0.28.0, Windows 앱) 규칙: 화면에서 받은 경로 · 메시지 검사와 git 인자 만들기. 실행은 gitcommit.js가 한다.
//
// [쉽게 말하면] "AI 수정안을 적용한 파일만 커밋" 기능의 규칙집입니다.
//   - 경로는 프로젝트 안의 상대 경로만 (.., 절대 경로, .git 안쪽은 거절), 메시지는 한 개 (편집기를 열지 않음)
//   - git add -- <경로들> 다음 git commit -m <메시지> -- <경로들>: 경로를 붙인 commit은 그 경로만 커밋하므로,
//     이미 스테이징해 둔 다른 파일은 커밋에 들어가지 않고 그대로 스테이징된 채 남습니다
//   - 경로는 글자 그대로(--literal-pathspecs) 봅니다 — 이름에 * 같은 글자가 있어도 다른 파일을 고르지 않게
//   - push는 만들지 않습니다 (이 파일에는 네트워크 명령이 없음)

const { safeRelPath, isGitInternal } = require('../shared/patch');
const { FORCED_PREFIX } = require('./git-rules');
const { t } = require('../shared/i18n');

const MAX_PATHS = 200;
const MAX_MESSAGE = 4000;
const MAX_ARGS_CHARS = 24000; // Windows 명령 줄 길이(32767자) 안쪽으로

/**
 * 화면에서 받은 커밋 요청 검사: { paths: [상대 경로], message }
 * → { ok: true, paths(정리한 경로, 겹침 제거), message(줄바꿈 LF) } | { ok: false, error }
 */
function checkCommitRequest(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: t('commit.badRequest') };
  const message = typeof raw.message === 'string' ? raw.message.replace(/\r\n?/g, '\n').trim() : '';
  if (!message) return { ok: false, error: t('commit.noMessage') };
  if (message.length > MAX_MESSAGE || message.includes('\0')) return { ok: false, error: t('commit.badMessage', { max: MAX_MESSAGE }) };
  const paths = checkPaths(raw.paths);
  if (!paths.ok) return paths;
  return { ok: true, paths: paths.paths, message };
}

/** 경로 목록 검사 → { ok: true, paths } | { ok: false, error } */
function checkPaths(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_PATHS) return { ok: false, error: t('commit.badPaths', { max: MAX_PATHS }) };
  const out = [];
  for (const p of list) {
    const clean = safeRelPath(p);
    if (!clean) return { ok: false, error: t('commit.badPath', { path: String(p).slice(0, 200) }) };
    if (isGitInternal(clean)) return { ok: false, error: t('commit.gitInternal', { path: clean }) };
    if (!out.includes(clean)) out.push(clean);
  }
  if (out.join('').length + out.length * 3 > MAX_ARGS_CHARS) return { ok: false, error: t('commit.tooLong') };
  return { ok: true, paths: out };
}

// 앱이 항상 붙이는 앞 옵션 (git 콘솔과 같음: 페이저 · 편집기 · fsmonitor 끔) + 경로를 글자 그대로
const PREFIX = [...FORCED_PREFIX, '--literal-pathspecs'];

/** git add: 고친 파일 · 새 파일 · 지운 파일 모두 (-A, 경로 안에서만) */
const addArgs = (paths) => [...PREFIX, 'add', '-A', '--', ...paths];
/** git commit: 그 경로만 커밋 (다른 스테이징은 남김). 메시지는 -m 하나로, 편집기를 열지 않는다 */
const commitArgs = (paths, message) => [...PREFIX, 'commit', '-m', message, '--', ...paths];
/** 이미 스테이징된 파일 (저장소 맨 위 기준 경로, NUL로 나눔) */
const stagedArgs = () => [...PREFIX, 'diff', '--cached', '--name-only', '-z'];
/** git이 아는(추적 중인) 파일 중 이 경로들 (지금 폴더 기준 경로, NUL로 나눔) */
const trackedArgs = (paths) => [...PREFIX, 'ls-files', '-z', '--', ...paths];

/** NUL로 나눈 git 출력 → 경로 목록 (빈 칸 제외, 역슬래시는 /로) */
const splitNul = (out) => String(out || '').split('\0').map((s) => s.replace(/\\/g, '/')).filter(Boolean);

/**
 * 이미 스테이징된 파일 중 이번 커밋에 들어가지 않는 것 (경고용).
 * staged: 저장소 맨 위 기준 경로, prefix: 프로젝트 폴더의 저장소 안 위치(git rev-parse --show-prefix, 예: "app/"), paths: 프로젝트 기준
 */
function otherStaged(staged, prefix, paths) {
  const mine = new Set(paths.map((p) => `${prefix || ''}${p}`));
  return staged.filter((p) => !mine.has(p));
}

/**
 * 커밋할 경로 고르기: 디스크에 있거나(고친 · 새 파일) git이 아는(지운 파일) 것만. 둘 다 아니면 커밋할 것이 없어 뺀다
 * (그대로 넘기면 git add가 "pathspec did not match"로 멈춘다).
 */
function pickCommitPaths(paths, { exists, tracked }) {
  const known = new Set(tracked);
  return paths.filter((p) => exists(p) || known.has(p));
}

// ---------- 새 브랜치에 적용 (v0.34.0) ----------
// 수정안을 적용하기 전에 사용자가 체크했을 때만 "git switch -c mla/<날짜>-<이름>"을 한다 (이미 있는 브랜치 · 저장소가 아닌 폴더는 거절). 이름 규칙은 shared/branch-name.js.
const { checkBranchName, suggestBranchName } = require('../shared/branch-name');

/** 그 이름의 브랜치가 이미 있는지 (종료 코드 0이면 있음) / 새 브랜치로 옮겨 가며 만들기 */
const branchExistsArgs = (name) => [...PREFIX, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`];
const branchSwitchArgs = (name) => [...PREFIX, 'switch', '-c', name];

/** 하는 일이 정해진 모양인지 마지막으로 확인 (gitcommit.js가 실행 직전에 부른다): add · commit · diff · ls-files · rev-parse, 그리고 switch -c <mla/…>만 */
function isAllowedCommitStep(args) {
  if (!Array.isArray(args) || args.length <= PREFIX.length) return false;
  if (PREFIX.some((a, i) => args[i] !== a)) return false;
  const sub = args[PREFIX.length];
  if (sub === 'switch') return args.length === PREFIX.length + 3 && args[PREFIX.length + 1] === '-c' && checkBranchName(args[PREFIX.length + 2]).ok;
  return ['add', 'commit', 'diff', 'ls-files', 'rev-parse'].includes(sub);
}

module.exports = { checkBranchName, suggestBranchName, branchExistsArgs, branchSwitchArgs, checkCommitRequest, checkPaths, addArgs, commitArgs, stagedArgs, trackedArgs, splitNul, otherStaged, pickCommitPaths, isAllowedCommitStep, PREFIX };
