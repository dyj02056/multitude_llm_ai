'use strict';

// git 콘솔(Windows 앱)이 받을 명령인지 검사한다. 실행은 gitconsole.js가 셸 없이 git을 직접 띄워서 한다.
//
// 막는 것
//   - 셸 문법: 셸을 거치지 않으므로 ; && | > 같은 글자는 그냥 git 인자가 된다 (따로 해석하지 않음)
//   - git 앞 옵션(-c, -C, --git-dir, --exec-path …): 설정으로 임의 명령을 실행하거나(core.pager 등) 다른 폴더를 건드릴 수 있다
//   - 허용 목록에 없는 하위 명령 (clean, filter-branch, submodule, grep(-O로 프로그램 실행), difftool …)
//   - 외부 프로그램을 띄우거나 아무 곳에나 쓰는 옵션 (--upload-pack, --exec, --output, --ext-diff, -i 대화형 …)
//   - 설정 쓰기 (git config는 읽기만)
// 되돌리기 어려운 명령(reset --hard, push --force, branch -D …)은 확인 창을 띄우도록 이유를 돌려준다.

const SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'shortlog', 'reflog', 'ls-files', 'rev-parse', 'describe',
  'add', 'rm', 'mv', 'restore', 'reset', 'commit', 'revert', 'cherry-pick',
  'branch', 'switch', 'checkout', 'merge', 'tag', 'stash',
  'fetch', 'pull', 'push', 'remote', 'init', 'config', 'version',
]);

// 어느 하위 명령에서든 받지 않는 옵션
const BLOCKED_OPTS = [
  [/^--(upload-pack|receive-pack|exec)(=|$)/, '외부 프로그램을 실행하는 옵션'],
  [/^--output(=|$)/, '결과를 다른 파일에 쓰는 옵션'],
  [/^--(ext-diff|textconv)$/, '외부 diff 프로그램을 쓰는 옵션'],
  [/^--(git-dir|work-tree|namespace|exec-path|config-env|separate-git-dir)(=|$)/, '다른 저장소·설정을 가리키는 옵션'],
  [/^--template(=|$)/, '다른 템플릿(훅 포함)을 쓰는 옵션'],
  [/^--rebase=(i|interactive)$/, '대화형 옵션 (이 콘솔에서는 입력을 받을 수 없음)'],
];
// 이 하위 명령들에서는 -p · -i · -e가 대화형(줄마다 묻기·편집기)이라 받지 않는다 (log · show · diff의 -p는 괜찮다)
const INTERACTIVE_SUBS = new Set(['add', 'checkout', 'restore', 'reset', 'stash', 'commit', 'switch']);
const INTERACTIVE_OPT = /^(--interactive|--patch|--edit|-[ipe])$/;

/** 명령 줄을 인자로 나눈다. "…" · '…' 묶음만 알아듣고 다른 셸 문법은 해석하지 않는다. → string[] | null(따옴표가 안 닫힘) */
function splitArgs(line) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of String(line)) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) return null;
  if (has || cur) out.push(cur);
  return out;
}

const hasAny = (args, list) => args.some((a) => list.includes(a));

/**
 * 명령 줄 검사 → { ok: true, args(git 뒤 인자), danger(확인할 이유 | null) } | { ok: false, error }
 */
function checkCommand(line) {
  const parts = splitArgs(String(line || '').trim());
  if (!parts) return { ok: false, error: '따옴표가 닫히지 않았습니다' };
  if (!parts.length) return { ok: false, error: '명령을 입력하세요' };
  if (parts[0] !== 'git') return { ok: false, error: 'git 명령만 실행할 수 있습니다 (예: git status)' };
  const args = parts.slice(1);
  if (!args.length) return { ok: false, error: '하위 명령을 입력하세요 (예: git status)' };
  if (args[0].startsWith('-')) return { ok: false, error: `git 앞 옵션(${args[0]})은 쓸 수 없습니다. 하위 명령 뒤에 쓰세요` };
  const sub = args[0];
  if (!SUBCOMMANDS.has(sub)) return { ok: false, error: `이 콘솔에서 쓸 수 없는 명령입니다: git ${sub}` };
  if (args.some((a) => a.length > 1000 || /[\0\r\n]/.test(a))) return { ok: false, error: '인자가 너무 길거나 줄바꿈이 있습니다' };
  const rest = args.slice(1);
  for (const a of rest) {
    if (a === '--') break; // 그 뒤는 경로
    for (const [re, why] of BLOCKED_OPTS) if (re.test(a)) return { ok: false, error: `${why}은(는) 쓸 수 없습니다: ${a}` };
    if (INTERACTIVE_SUBS.has(sub) && INTERACTIVE_OPT.test(a)) return { ok: false, error: `대화형 옵션은 쓸 수 없습니다 (이 콘솔에서는 입력을 받을 수 없음): ${a}` };
  }

  if (sub === 'config') {
    const read = rest.length && rest.every((a) => /^(--get|--get-all|--get-regexp|--list|-l|--show-origin|--global|--local|--system|--name-only)$/.test(a) || !a.startsWith('-'));
    const wantsRead = hasAny(rest, ['--get', '--get-all', '--get-regexp', '--list', '-l']) || (rest.filter((a) => !a.startsWith('-')).length === 1);
    if (!read || !wantsRead) return { ok: false, error: 'git config는 읽기만 할 수 있습니다 (예: git config --get user.name, git config --list)' };
  }
  if (sub === 'commit' && !rest.some((a) => /^(-m|--message(=.*)?|-F|--file(=.*)?|--no-edit|-C|--reuse-message(=.*)?)$/.test(a) || /^-[a-zA-Z]*m/.test(a))) {
    return { ok: false, error: '메시지를 붙여 주세요: git commit -m "메시지" (편집기는 열 수 없습니다)' };
  }
  if (sub === 'remote' && rest[0] && !['-v', '--verbose', 'show', 'get-url', 'add', 'remove', 'rm', 'rename', 'set-url', 'prune'].includes(rest[0])) {
    return { ok: false, error: `이 콘솔에서 쓸 수 없는 remote 명령입니다: ${rest[0]}` };
  }
  if (sub === 'stash' && rest[0] && !['list', 'show', 'push', 'save', 'pop', 'apply', 'drop', 'clear', '-u', '-m', '--include-untracked', '--message'].includes(rest[0])) {
    return { ok: false, error: `이 콘솔에서 쓸 수 없는 stash 명령입니다: ${rest[0]}` };
  }
  return { ok: true, args, danger: dangerOf(sub, rest) };
}

/** 되돌리기 어려운 명령이면 이유 (확인 창에 씀), 아니면 null */
function dangerOf(sub, rest) {
  const has = (...xs) => hasAny(rest, xs);
  if (sub === 'reset' && has('--hard', '--merge', '--keep')) return '커밋하지 않은 변경이 사라집니다';
  if (sub === 'push' && (has('--force', '-f', '--force-with-lease', '--mirror', '--delete', '-d', '--prune') || rest.some((a) => /^\+|^:|^--force-with-lease=/.test(a)))) {
    return '원격 저장소의 기록을 덮어쓰거나 지웁니다';
  }
  if (sub === 'branch' && (has('-D', '--delete', '-d') || has('-f', '--force'))) return '브랜치를 지우거나 덮어씁니다';
  if ((sub === 'checkout' || sub === 'switch') && has('-f', '--force', '--discard-changes')) return '커밋하지 않은 변경이 사라집니다';
  if (sub === 'checkout' && rest.includes('--')) return '파일의 커밋하지 않은 변경이 사라집니다';
  if (sub === 'restore' && !has('--staged', '-S')) return '파일의 커밋하지 않은 변경이 사라집니다';
  if (sub === 'stash' && ['drop', 'clear'].includes(rest[0])) return '보관한 변경이 사라집니다';
  if (sub === 'tag' && has('-d', '--delete', '-f', '--force')) return '태그를 지우거나 덮어씁니다';
  if (sub === 'rm' && !has('--cached')) return '파일을 지웁니다';
  if (sub === 'remote' && ['remove', 'rm', 'set-url'].includes(rest[0])) return '원격 저장소 설정을 바꿉니다';
  return null;
}

// 앱이 항상 붙이는 git 앞 옵션: 페이저·편집기를 띄우지 않고, 저장소 설정의 fsmonitor 프로그램과 ext:: 주소(명령 실행)를 쓰지 않는다.
const FORCED_PREFIX = [
  '--no-pager',
  '-c', 'core.pager=cat',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.editor=:',
  '-c', 'sequence.editor=:',
  '-c', 'protocol.ext.allow=never',
  '-c', 'color.ui=never',
];

// 실행 환경: 비밀번호를 터미널로 묻지 않고(창은 git 자격 증명 관리자가 띄울 수 있음), 편집기를 열지 않는다.
const FORCED_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: ':',
  GIT_SEQUENCE_EDITOR: ':',
  GIT_MERGE_AUTOEDIT: 'no',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_OPTIONAL_LOCKS: '0',
};

/** 출력에서 주소에 든 아이디·토큰(https://user:token@host)과 알려진 키 모양을 가린다 */
function maskOutput(text, patterns = []) {
  let s = String(text).replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@');
  for (const p of patterns) {
    if (p.name === '비밀번호·토큰 대입') continue; // git 출력(diff)에서는 오탐이 많다
    s = s.replace(new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`), (m) => `${m.slice(0, 4)}…(가림)`);
  }
  return s;
}

module.exports = { SUBCOMMANDS, splitArgs, checkCommand, FORCED_PREFIX, FORCED_ENV, maskOutput };
