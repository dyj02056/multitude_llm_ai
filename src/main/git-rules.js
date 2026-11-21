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

// [쉽게 말하면]
// git은 코드의 변경 기록을 관리하는 도구입니다. 앱 안의 "git 콘솔"에서 사용자가 git 명령을 칠 수 있는데,
// 잘못 쓰면 컴퓨터에서 엉뚱한 프로그램이 실행되거나 작업 내용이 사라질 수 있습니다.
// 이 파일은 "이 명령을 실행해도 되는지" 검사하는 "경비원"입니다.
//   - 허락된 명령(status, commit, push …)만 통과
//   - 위험한 옵션은 거절
//   - 되돌리기 어려운 명령은 "정말 할까요?" 확인 창을 띄우도록 이유를 알려 줌

// 허락하는 git 하위 명령 목록 (git 다음에 오는 단어)
const SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'shortlog', 'reflog', 'ls-files', 'rev-parse', 'describe',
  'add', 'rm', 'mv', 'restore', 'reset', 'commit', 'revert', 'cherry-pick',
  'branch', 'switch', 'checkout', 'merge', 'tag', 'stash',
  'fetch', 'pull', 'push', 'remote', 'init', 'config', 'version',
]);

const { t } = require('../shared/i18n');

// 어느 하위 명령에서든 받지 않는 옵션 (둘째 값은 사전 키 — 쓸 때 t()로 바꾼다)
const BLOCKED_OPTS = [
  [/^--(upload-pack|receive-pack|exec)(=|$)/, 'main.git.opt.external'],
  [/^--output(=|$)/, 'main.git.opt.output'],
  [/^--(ext-diff|textconv)$/, 'main.git.opt.extDiff'],
  [/^--(git-dir|work-tree|namespace|exec-path|config-env|separate-git-dir)(=|$)/, 'main.git.opt.otherRepo'],
  [/^--template(=|$)/, 'main.git.opt.template'],
  [/^--rebase=(i|interactive)$/, 'main.git.opt.interactive'],
];
// 이 하위 명령들에서는 -p · -i · -e가 대화형(줄마다 묻기·편집기)이라 받지 않는다 (log · show · diff의 -p는 괜찮다)
const INTERACTIVE_SUBS = new Set(['add', 'checkout', 'restore', 'reset', 'stash', 'commit', 'switch']);
const INTERACTIVE_OPT = /^(--interactive|--patch|--edit|-[ipe])$/;

/** 명령 줄을 인자로 나눈다. "…" · '…' 묶음만 알아듣고 다른 셸 문법은 해석하지 않는다. → string[] | null(따옴표가 안 닫힘) */
// 예: git commit -m "첫 커밋"  →  ['git', 'commit', '-m', '첫 커밋']
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
// 검사 순서: 따옴표·빈 명령 확인 → 'git'으로 시작하는지 → 허락된 하위 명령인지 → 막는 옵션이 없는지
//           → config는 읽기만, commit은 메시지 필수 등 명령별 규칙 → 위험도(danger) 판단
function checkCommand(line) {
  const parts = splitArgs(String(line || '').trim());
  if (!parts) return { ok: false, error: t('main.git.unclosedQuote') };
  if (!parts.length) return { ok: false, error: t('main.git.enterCommand') };
  if (parts[0] !== 'git') return { ok: false, error: t('main.git.onlyGit') };
  const args = parts.slice(1);
  if (!args.length) return { ok: false, error: t('main.git.enterSub') };
  if (args[0].startsWith('-')) return { ok: false, error: t('main.git.globalOpt', { opt: args[0] }) };
  const sub = args[0];
  if (!SUBCOMMANDS.has(sub)) return { ok: false, error: t('main.git.notAllowedSub', { sub }) };
  if (args.some((a) => a.length > 1000 || /[\0\r\n]/.test(a))) return { ok: false, error: t('main.git.badArg') };
  const rest = args.slice(1);
  for (const a of rest) {
    if (a === '--') break; // 그 뒤는 경로
    for (const [re, why] of BLOCKED_OPTS) if (re.test(a)) return { ok: false, error: t('main.git.blocked', { why: t(why), arg: a }) };
    if (INTERACTIVE_SUBS.has(sub) && INTERACTIVE_OPT.test(a)) return { ok: false, error: t('main.git.interactiveOpt', { arg: a }) };
  }

  if (sub === 'config') {
    const read = rest.length && rest.every((a) => /^(--get|--get-all|--get-regexp|--list|-l|--show-origin|--global|--local|--system|--name-only)$/.test(a) || !a.startsWith('-'));
    const wantsRead = hasAny(rest, ['--get', '--get-all', '--get-regexp', '--list', '-l']) || (rest.filter((a) => !a.startsWith('-')).length === 1);
    if (!read || !wantsRead) return { ok: false, error: t('main.git.configReadOnly') };
  }
  if (sub === 'commit' && !rest.some((a) => /^(-m|--message(=.*)?|-F|--file(=.*)?|--no-edit|-C|--reuse-message(=.*)?)$/.test(a) || /^-[a-zA-Z]*m/.test(a))) {
    return { ok: false, error: t('main.git.commitNeedsMessage') };
  }
  if (sub === 'remote' && rest[0] && !['-v', '--verbose', 'show', 'get-url', 'add', 'remove', 'rm', 'rename', 'set-url', 'prune'].includes(rest[0])) {
    return { ok: false, error: t('main.git.remoteNotAllowed', { cmd: rest[0] }) };
  }
  if (sub === 'stash' && rest[0] && !['list', 'show', 'push', 'save', 'pop', 'apply', 'drop', 'clear', '-u', '-m', '--include-untracked', '--message'].includes(rest[0])) {
    return { ok: false, error: t('main.git.stashNotAllowed', { cmd: rest[0] }) };
  }
  return { ok: true, args, danger: dangerOf(sub, rest) };
}

/** 되돌리기 어려운 명령이면 이유 (확인 창에 씀), 아니면 null */
function dangerOf(sub, rest) {
  const has = (...xs) => hasAny(rest, xs);
  if (sub === 'reset' && has('--hard', '--merge', '--keep')) return t('main.git.danger.uncommitted');
  if (sub === 'push' && (has('--force', '-f', '--force-with-lease', '--mirror', '--delete', '-d', '--prune') || rest.some((a) => /^\+|^:|^--force-with-lease=/.test(a)))) {
    return t('main.git.danger.remoteHistory');
  }
  if (sub === 'branch' && (has('-D', '--delete', '-d') || has('-f', '--force'))) return t('main.git.danger.branch');
  if ((sub === 'checkout' || sub === 'switch') && has('-f', '--force', '--discard-changes')) return t('main.git.danger.uncommitted');
  if (sub === 'checkout' && rest.includes('--')) return t('main.git.danger.fileUncommitted');
  if (sub === 'restore' && !has('--staged', '-S')) return t('main.git.danger.fileUncommitted');
  if (sub === 'stash' && ['drop', 'clear'].includes(rest[0])) return t('main.git.danger.stash');
  if (sub === 'tag' && has('-d', '--delete', '-f', '--force')) return t('main.git.danger.tag');
  if (sub === 'rm' && !has('--cached')) return t('main.git.danger.rm');
  if (sub === 'remote' && ['remove', 'rm', 'set-url'].includes(rest[0])) return t('main.git.danger.remote');
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
// 예: https://사용자:비밀토큰@github.com  →  https://***@github.com  (화면에 비밀번호가 보이지 않게)
function maskOutput(text, patterns = []) {
  let s = String(text).replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@');
  for (const p of patterns) {
    if (p.name === '비밀번호·토큰 대입') continue; // git 출력(diff)에서는 오탐이 많다
    s = s.replace(new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`), (m) => `${m.slice(0, 4)}${t('main.git.masked')}`);
  }
  return s;
}

const MAX_PENDING_LINE = 64 * 1024; // 줄바꿈 없이 이만큼 쌓이면 그냥 내보낸다

/**
 * 출력 조각(Buffer)을 줄 단위로 모아 가려 주는 도우미 (스트림마다 하나씩).
 * 조각 경계에 걸린 한글(UTF-8 여러 바이트)이 깨지지 않게 StringDecoder로 풀고,
 * 조각 경계에 걸린 토큰도 가려지도록 완성된 줄(\n 또는 \r까지)만 가려서 내보낸다. 남은 끝 줄은 end()에서 내보낸다.
 * → { push(buf): 가린 글자(없으면 ''), end(): 남은 글자를 가려서 }
 */
function createLineMasker(patterns = []) {
  const { StringDecoder } = require('string_decoder');
  const decoder = new StringDecoder('utf8');
  let pending = '';
  return {
    push(buf) {
      const text = pending + decoder.write(buf);
      const cut = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r')) + 1;
      if (!cut && text.length < MAX_PENDING_LINE) {
        pending = text;
        return '';
      }
      const done = cut ? text.slice(0, cut) : text;
      pending = cut ? text.slice(cut) : '';
      return maskOutput(done, patterns);
    },
    end() {
      const text = pending + decoder.end();
      pending = '';
      return text ? maskOutput(text, patterns) : '';
    },
  };
}

module.exports = { splitArgs, checkCommand, FORCED_PREFIX, FORCED_ENV, maskOutput, createLineMasker };
