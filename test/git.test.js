'use strict';
// git 콘솔 명령 검사 (v0.8.0) 단위 테스트:  npm test
// [쉽게 말하면] 테스트 = "코드가 약속대로 동작하는지 자동으로 확인하는 시험지"입니다. npm test 로 모든 시험을 한 번에 돌립니다.
// 이 파일: git 콘솔이 위험한 명령은 막고 괜찮은 명령은 통과시키는지 확인합니다.
// assert.equal(실제, 기대) = "실제 값이 기대 값과 같아야 한다" (다르면 시험 실패)
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/main/git-rules');
const { PATTERNS } = require('../src/shared/secret-scan');

test('인자 나누기: 따옴표만 알아듣고 셸 문법은 그냥 글자', () => {
  assert.deepEqual(G.splitArgs('git commit -m "고친 점; rm -rf /"'), ['git', 'commit', '-m', '고친 점; rm -rf /']);
  assert.deepEqual(G.splitArgs("git log --format='%h %s' && calc"), ['git', 'log', '--format=%h %s', '&&', 'calc']);
  assert.deepEqual(G.splitArgs('git commit -m ""'), ['git', 'commit', '-m', '']);
  assert.equal(G.splitArgs('git commit -m "안 닫힘'), null);
});

test('받는 명령', () => {
  for (const line of ['git status', 'git log --oneline -20', 'git log -p', 'git diff --stat', 'git add -A', 'git commit -am "x"', 'git commit -m x', 'git push', 'git pull --rebase', 'git switch -c feat', 'git config --get user.name', 'git config user.email', 'git config --list', 'git remote -v', 'git stash list', 'git init', 'git ls-files -o']) {
    assert.equal(G.checkCommand(line).ok, true, line);
  }
});

test('막는 명령: git 밖·앞 옵션·허용 안 된 하위 명령·위험 옵션·설정 쓰기·편집기', () => {
  const bad = [
    'calc.exe',
    'status',
    'git',
    'git -c core.pager=calc log',
    'git -C .. status',
    'git --exec-path=. status',
    'git clean -fdx',
    'git grep -O calc foo',
    'git submodule update',
    'git difftool',
    'git rebase -i HEAD~3',
    'git help log',
    'git fetch --upload-pack="calc" origin',
    'git push --receive-pack=calc',
    'git log --output=C:/Windows/x.txt',
    'git diff --ext-diff',
    'git add -p',
    'git add --interactive',
    'git checkout -p',
    'git config core.pager calc',
    'git config --unset user.name',
    'git config --add alias.x "!calc"',
    'git commit',
    'git pull --rebase=interactive',
    'git init --template=evil',
    'git status --git-dir=../other',
    'git remote update',
  ];
  for (const line of bad) assert.equal(G.checkCommand(line).ok, false, line);
});

test('되돌리기 어려운 명령은 확인 이유가 붙는다', () => {
  for (const line of ['git reset --hard HEAD~1', 'git push --force', 'git push -f origin main', 'git push origin +main', 'git push origin :old', 'git branch -D x', 'git checkout -- .', 'git restore src/a.js', 'git stash drop', 'git rm a.js', 'git checkout -f main']) {
    const r = G.checkCommand(line);
    assert.equal(r.ok, true, line);
    assert.ok(r.danger, line);
  }
  for (const line of ['git status', 'git push', 'git restore --staged a.js', 'git rm --cached a.js', 'git reset HEAD a.js', 'git branch feat']) {
    assert.equal(G.checkCommand(line).danger, null, line);
  }
});

test('항상 붙는 앞 옵션과 실행 환경: 페이저·편집기·fsmonitor·ext:: 끔', () => {
  const pre = G.FORCED_PREFIX.join(' ');
  for (const s of ['--no-pager', 'core.fsmonitor=false', 'core.editor=:', 'protocol.ext.allow=never']) assert.ok(pre.includes(s), s);
  assert.equal(G.FORCED_ENV.GIT_TERMINAL_PROMPT, '0');
  assert.equal(G.FORCED_ENV.GIT_EDITOR, ':');
});

test('출력 가리기: 주소의 아이디·토큰과 알려진 키', () => {
  const out = G.maskOutput('origin\thttps://me:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/a/b.git (fetch)\n+ key = AKIAABCDEFGHIJKLMNOP\n', PATTERNS);
  assert.ok(!out.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.ok(out.includes('https://***@github.com/a/b.git'));
  assert.ok(!out.includes('AKIAABCDEFGHIJKLMNOP'));
});
