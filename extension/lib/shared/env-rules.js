// 자동 생성 파일 — 직접 고치지 말고 원본을 고친 뒤 npm run build:ext (원본: src/shared/env-rules.js)
// 로컬 환경 점검 규칙 (v0.41.0) — 프로젝트에 어떤 도구가 필요한지 고르고, 점검 결과를 판정한다.
// Windows 앱(require)과 화면 · 크롬 확장(전역 MLA.envRules)이 같이 쓴다. 실제 실행(--version)은 main/envcheck.js만 한다.
//
// [쉽게 말하면]
//   1. 프로젝트 맨 위 폴더의 파일 이름(package.json · pom.xml · CMakeLists.txt …)을 보고 "이 프로젝트에 필요한 도구"를 고릅니다.
//   2. package.json의 engines · .nvmrc · pyproject.toml의 requires-python 같은 곳에서 "필요한 버전"을 읽습니다.
//   3. 본체가 알려 준 "이 PC에 있는 도구와 버전"과 맞춰 ✓ 있음 · ⚠ 버전 안 맞음 · ⚠ PATH에 없음 · ✗ 없음을 정합니다.
//   4. 설치는 하지 않습니다. 설치 안내(winget 명령 · 공식 주소)만 보여 줍니다.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MLA = root.MLA || {}).envRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 도구 목록. exe: 찾을 실행 파일 이름(확장자 없이, 앞의 것부터) · args: 버전을 묻는 인자(고정) · cat: 묶음
  // via: 'npm' | 'npx' (npm-cli.js 옆 package.json에서 버전을 읽음, 실행하지 않음) · 'python' (찾은 python으로 args 실행)
  //      'vswhere' (Visual Studio 설치 도구로 C++ 빌드 도구를 찾음) · 'dir' (폴더가 있는지만)
  // winget: 설치 명령에 쓰는 winget id · cmd: winget이 없는 도구의 설치 명령 · url: 공식 설치 안내(이 목록에 있는 주소만 연다)
  const TOOLS = {
    git: { name: 'git', cat: 'core', exe: ['git'], args: ['--version'], winget: 'Git.Git', url: 'https://git-scm.com/download/win' },
    node: { name: 'Node.js', cat: 'js', exe: ['node'], args: ['--version'], winget: 'OpenJS.NodeJS.LTS', url: 'https://nodejs.org/' },
    npm: { name: 'npm', cat: 'js', via: 'npm', cmd: 'winget install --id OpenJS.NodeJS.LTS -e', url: 'https://docs.npmjs.com/downloading-and-installing-node-js-and-npm' },
    npx: { name: 'npx', cat: 'js', via: 'npx', cmd: 'winget install --id OpenJS.NodeJS.LTS -e', url: 'https://docs.npmjs.com/cli/commands/npx' },
    pnpm: { name: 'pnpm', cat: 'js', exe: ['pnpm'], args: ['--version'], winget: 'pnpm.pnpm', url: 'https://pnpm.io/installation' },
    yarn: { name: 'Yarn', cat: 'js', exe: ['yarn'], args: ['--version'], cmd: 'corepack enable', url: 'https://yarnpkg.com/getting-started/install' },
    bun: { name: 'Bun', cat: 'js', exe: ['bun'], args: ['--version'], winget: 'Oven-sh.Bun', url: 'https://bun.sh/' },
    deno: { name: 'Deno', cat: 'js', exe: ['deno'], args: ['--version'], winget: 'DenoLand.Deno', url: 'https://deno.com/' },
    python: { name: 'Python', cat: 'python', exe: ['python', 'python3'], args: ['--version'], winget: 'Python.Python.3.12', url: 'https://www.python.org/downloads/' },
    pip: { name: 'pip', cat: 'python', via: 'python', args: ['-m', 'pip', '--version'], cmd: 'py -m ensurepip --upgrade', url: 'https://pip.pypa.io/en/stable/installation/' },
    poetry: { name: 'Poetry', cat: 'python', exe: ['poetry'], args: ['--version'], cmd: 'py -m pip install --user pipx && py -m pipx install poetry', url: 'https://python-poetry.org/docs/#installation' },
    uv: { name: 'uv', cat: 'python', exe: ['uv'], args: ['--version'], winget: 'astral-sh.uv', url: 'https://docs.astral.sh/uv/' },
    pipenv: { name: 'Pipenv', cat: 'python', exe: ['pipenv'], args: ['--version'], cmd: 'py -m pip install --user pipenv', url: 'https://pipenv.pypa.io/' },
    conda: { name: 'conda', cat: 'python', exe: ['conda'], args: ['--version'], winget: 'Anaconda.Miniconda3', url: 'https://docs.conda.io/' },
    jdk: { name: 'JDK (javac)', cat: 'jvm', exe: ['javac'], args: ['-version'], winget: 'Microsoft.OpenJDK.21', url: 'https://learn.microsoft.com/java/openjdk/download' },
    java: { name: 'Java (java)', cat: 'jvm', exe: ['java'], args: ['-version'], winget: 'Microsoft.OpenJDK.21', url: 'https://learn.microsoft.com/java/openjdk/download' },
    mvn: { name: 'Maven', cat: 'jvm', exe: ['mvn'], args: ['-v'], url: 'https://maven.apache.org/download.cgi' },
    gradle: { name: 'Gradle', cat: 'jvm', exe: ['gradle'], args: ['--version'], url: 'https://gradle.org/install/' },
    kotlinc: { name: 'Kotlin', cat: 'jvm', exe: ['kotlinc'], args: ['-version'], url: 'https://kotlinlang.org/docs/command-line.html' },
    gcc: { name: 'gcc', cat: 'native', exe: ['gcc'], args: ['--version'], winget: 'MSYS2.MSYS2', url: 'https://www.msys2.org/' },
    gpp: { name: 'g++', cat: 'native', exe: ['g++'], args: ['--version'], winget: 'MSYS2.MSYS2', url: 'https://www.msys2.org/' },
    clang: { name: 'clang', cat: 'native', exe: ['clang'], args: ['--version'], winget: 'LLVM.LLVM', url: 'https://releases.llvm.org/' },
    msvc: { name: 'MSVC (Visual Studio C++)', cat: 'native', via: 'vswhere', winget: 'Microsoft.VisualStudio.2022.BuildTools', url: 'https://visualstudio.microsoft.com/visual-cpp-build-tools/' },
    cmake: { name: 'CMake', cat: 'native', exe: ['cmake'], args: ['--version'], winget: 'Kitware.CMake', url: 'https://cmake.org/download/' },
    make: { name: 'make', cat: 'native', exe: ['make', 'mingw32-make'], args: ['--version'], winget: 'ezwinports.make', url: 'https://www.msys2.org/' },
    ninja: { name: 'Ninja', cat: 'native', exe: ['ninja'], args: ['--version'], winget: 'Ninja-build.Ninja', url: 'https://ninja-build.org/' },
    meson: { name: 'Meson', cat: 'native', exe: ['meson'], args: ['--version'], cmd: 'py -m pip install --user meson', url: 'https://mesonbuild.com/Getting-meson.html' },
    dotnet: { name: '.NET SDK', cat: 'dotnet', exe: ['dotnet'], args: ['--version'], winget: 'Microsoft.DotNet.SDK.8', url: 'https://dotnet.microsoft.com/download' },
    cargo: { name: 'cargo', cat: 'rust', exe: ['cargo'], args: ['--version'], winget: 'Rustlang.Rustup', url: 'https://rustup.rs/' },
    rustc: { name: 'rustc', cat: 'rust', exe: ['rustc'], args: ['--version'], winget: 'Rustlang.Rustup', url: 'https://rustup.rs/' },
    go: { name: 'Go', cat: 'go', exe: ['go'], args: ['version'], winget: 'GoLang.Go', url: 'https://go.dev/dl/' },
    ruby: { name: 'Ruby', cat: 'ruby', exe: ['ruby'], args: ['--version'], url: 'https://rubyinstaller.org/' },
    bundler: { name: 'Bundler', cat: 'ruby', exe: ['bundle'], args: ['--version'], cmd: 'gem install bundler', url: 'https://bundler.io/' },
    php: { name: 'PHP', cat: 'php', exe: ['php'], args: ['--version'], url: 'https://windows.php.net/download/' },
    composer: { name: 'Composer', cat: 'php', exe: ['composer'], args: ['--version'], url: 'https://getcomposer.org/download/' },
    dart: { name: 'Dart', cat: 'dart', exe: ['dart'], args: ['--version'], url: 'https://dart.dev/get-dart' },
    flutter: { name: 'Flutter', cat: 'dart', exe: ['flutter'], args: ['--version'], url: 'https://docs.flutter.dev/get-started/install/windows' },
    docker: { name: 'Docker', cat: 'infra', exe: ['docker'], args: ['--version'], winget: 'Docker.DockerDesktop', url: 'https://docs.docker.com/desktop/setup/install/windows-install/' },
    terraform: { name: 'Terraform', cat: 'infra', exe: ['terraform'], args: ['-version'], winget: 'Hashicorp.Terraform', url: 'https://developer.hashicorp.com/terraform/install' },
    kubectl: { name: 'kubectl', cat: 'infra', exe: ['kubectl'], args: ['version', '--client'], winget: 'Kubernetes.kubectl', url: 'https://kubernetes.io/docs/tasks/tools/' },
    helm: { name: 'Helm', cat: 'infra', exe: ['helm'], args: ['version', '--short'], winget: 'Helm.Helm', url: 'https://helm.sh/docs/intro/install/' },
    psql: { name: 'PostgreSQL (psql)', cat: 'db', exe: ['psql'], args: ['--version'], url: 'https://www.postgresql.org/download/windows/' },
    mysql: { name: 'MySQL (mysql)', cat: 'db', exe: ['mysql'], args: ['--version'], url: 'https://dev.mysql.com/downloads/' },
    sqlite3: { name: 'SQLite (sqlite3)', cat: 'db', exe: ['sqlite3'], args: ['--version'], winget: 'SQLite.SQLite', url: 'https://www.sqlite.org/download.html' },
    adb: { name: 'Android SDK (adb)', cat: 'mobile', exe: ['adb'], args: ['--version'], winget: 'Google.PlatformTools', url: 'https://developer.android.com/studio' },
    gh: { name: 'GitHub CLI', cat: 'tools', exe: ['gh'], args: ['--version'], winget: 'GitHub.cli', url: 'https://cli.github.com/' },
    precommit: { name: 'pre-commit', cat: 'tools', exe: ['pre-commit'], args: ['--version'], cmd: 'py -m pip install --user pre-commit', url: 'https://pre-commit.com/#install' },
    ruff: { name: 'Ruff', cat: 'tools', exe: ['ruff'], args: ['--version'], cmd: 'py -m pip install --user ruff', url: 'https://docs.astral.sh/ruff/installation/' },
    mypy: { name: 'mypy', cat: 'tools', exe: ['mypy'], args: ['--version'], cmd: 'py -m pip install --user mypy', url: 'https://mypy.readthedocs.io/' },
    clangformat: { name: 'clang-format', cat: 'tools', exe: ['clang-format'], args: ['--version'], winget: 'LLVM.LLVM', url: 'https://releases.llvm.org/' },
    pwbrowsers: { name: 'Playwright browsers', cat: 'tools', via: 'dir', cmd: 'npx playwright install', url: 'https://playwright.dev/docs/browsers' },
    vercel: { name: 'Vercel CLI', cat: 'deploy', exe: ['vercel'], args: ['--version'], cmd: 'npm i -g vercel', url: 'https://vercel.com/docs/cli' },
    netlify: { name: 'Netlify CLI', cat: 'deploy', exe: ['netlify'], args: ['--version'], cmd: 'npm i -g netlify-cli', url: 'https://docs.netlify.com/cli/get-started/' },
    firebase: { name: 'Firebase CLI', cat: 'deploy', exe: ['firebase'], args: ['--version'], cmd: 'npm i -g firebase-tools', url: 'https://firebase.google.com/docs/cli' },
  };
  const TOOL_IDS = Object.keys(TOOLS);
  const CATS = ['core', 'js', 'python', 'jvm', 'native', 'dotnet', 'rust', 'go', 'ruby', 'php', 'dart', 'infra', 'db', 'mobile', 'tools', 'deploy'];
  // 셋 중 하나만 있으면 되는 묶음: C · C++ 컴파일러
  const GROUPS = { cc: ['gcc', 'clang', 'msvc'], cxx: ['gpp', 'clang', 'msvc'] };

  // 프로젝트 안에 설치된 패키지 (node_modules/<이름>/package.json의 version을 읽는다 — 실행하지 않음). marker: 그 도구를 쓰는 설정 파일
  const LOCAL_PKGS = [
    { pkg: 'typescript', marker: /^tsconfig(\.[\w-]+)?\.json$/i },
    { pkg: 'eslint', marker: /^(\.eslintrc(\.\w+)?|eslint\.config\.\w+)$/i },
    { pkg: 'prettier', marker: /^(\.prettierrc(\.\w+)?|prettier\.config\.\w+)$/i },
    { pkg: '@playwright/test', marker: /^playwright\.config\.\w+$/i },
  ];

  const lower = (names) => new Set([...names].map((n) => String(n).toLowerCase()));
  const has = (set, ...names) => names.some((n) => set.has(n.toLowerCase()));
  const hasRe = (names, re) => [...names].some((n) => re.test(n));

  /**
   * 맨 위 폴더의 이름 목록(names: [{ name, kind }] 또는 이름 문자열) + 몇몇 파일의 글(texts: { 'package.json': 글, … })
   * → 필요한 도구 [{ id | group, because: '표시 파일', optional? }] (겹치지 않게, 처음 찾은 이유)
   */
  function detectNeeds(entries, texts = {}) {
    const names = (entries || []).map((e) => (typeof e === 'string' ? e : e && e.name)).filter(Boolean);
    const dirs = lower((entries || []).filter((e) => e && typeof e === 'object' && e.kind === 'dir').map((e) => e.name));
    const n = lower(names);
    const out = new Map();
    const need = (id, because, optional = false) => {
      if (!out.has(id)) out.set(id, { ...(GROUPS[id] ? { group: id } : { id }), because, ...(optional ? { optional: true } : {}) });
    };
    need('git', has(n, '.git') ? '.git' : '');
    const pkg = parseJson(texts['package.json']);
    if (has(n, 'package.json')) {
      need('node', 'package.json');
      need('npm', 'package.json');
      need('npx', 'package.json');
      const pm = String((pkg && pkg.packageManager) || '').split('@')[0];
      if (has(n, 'pnpm-lock.yaml') || pm === 'pnpm') need('pnpm', has(n, 'pnpm-lock.yaml') ? 'pnpm-lock.yaml' : 'packageManager');
      if (has(n, 'yarn.lock') || pm === 'yarn') need('yarn', has(n, 'yarn.lock') ? 'yarn.lock' : 'packageManager');
      if (has(n, 'bun.lockb', 'bun.lock') || pm === 'bun') need('bun', has(n, 'bun.lockb') ? 'bun.lockb' : 'bun.lock');
      const pw = names.find((x) => LOCAL_PKGS[3].marker.test(x));
      if (pw) need('pwbrowsers', pw, true);
      for (const [k, id] of [['vercel', 'vercel'], ['netlify-cli', 'netlify'], ['firebase-tools', 'firebase']]) if (depOf(pkg, k)) need(id, 'package.json', true);
    }
    if (has(n, 'deno.json', 'deno.jsonc')) need('deno', has(n, 'deno.json') ? 'deno.json' : 'deno.jsonc');
    const pyMarker = ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile', 'environment.yml', 'manage.py'].find((m) => has(n, m));
    if (pyMarker) {
      need('python', pyMarker);
      if (!has(n, 'environment.yml')) need('pip', pyMarker);
      const pyproject = String(texts['pyproject.toml'] || '');
      if (has(n, 'poetry.lock') || /^\s*\[tool\.poetry\]/m.test(pyproject)) need('poetry', has(n, 'poetry.lock') ? 'poetry.lock' : 'pyproject.toml');
      if (has(n, 'uv.lock')) need('uv', 'uv.lock');
      if (has(n, 'Pipfile')) need('pipenv', 'Pipfile');
      if (has(n, 'environment.yml')) need('conda', 'environment.yml');
      if (has(n, 'ruff.toml', '.ruff.toml') || /^\s*\[tool\.ruff/m.test(pyproject)) need('ruff', has(n, 'ruff.toml') ? 'ruff.toml' : 'pyproject.toml', true);
      if (has(n, 'mypy.ini', '.mypy.ini') || /^\s*\[tool\.mypy/m.test(pyproject)) need('mypy', has(n, 'mypy.ini') ? 'mypy.ini' : 'pyproject.toml', true);
    }
    const gradle = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].find((m) => has(n, m));
    if (has(n, 'pom.xml')) {
      need('jdk', 'pom.xml');
      need('mvn', 'pom.xml', has(n, 'mvnw', 'mvnw.cmd'));
    }
    if (gradle) {
      need('jdk', gradle);
      need('gradle', gradle, has(n, 'gradlew', 'gradlew.bat'));
      if (gradle.endsWith('.kts') || hasRe(names, /\.kt$/i)) need('kotlinc', gradle, true);
      if (dirs.has('android') || /com\.android\.(application|library)/.test(String(texts[gradle] || ''))) need('adb', dirs.has('android') ? 'android/' : gradle, true);
    }
    if (has(n, 'AndroidManifest.xml')) need('adb', 'AndroidManifest.xml', true);
    const cxx = hasRe(names, /\.(cpp|cc|cxx|hpp|hh)$/i);
    if (has(n, 'CMakeLists.txt')) {
      need('cmake', 'CMakeLists.txt');
      need(cxx || /\bCXX\b|\.cpp\b/.test(String(texts['CMakeLists.txt'] || '')) ? 'cxx' : 'cc', 'CMakeLists.txt');
    }
    if (has(n, 'meson.build')) {
      need('meson', 'meson.build');
      need('ninja', 'meson.build');
      need(cxx ? 'cxx' : 'cc', 'meson.build');
    }
    if (has(n, 'Makefile', 'makefile', 'GNUmakefile')) {
      need('make', 'Makefile');
      if (cxx || hasRe(names, /\.c$/i) || dirs.has('src')) need(cxx ? 'cxx' : 'cc', 'Makefile');
    }
    if (!out.has('cc') && !out.has('cxx')) {
      const src = names.find((x) => /\.(c|cpp|cc|cxx)$/i.test(x));
      if (src) need(/\.c$/i.test(src) ? 'cc' : 'cxx', src);
    }
    if (has(n, 'build.ninja')) need('ninja', 'build.ninja');
    if (has(n, '.clang-format')) need('clangformat', '.clang-format', true);
    const net = names.find((x) => /\.(csproj|fsproj|vbproj|sln)$/i.test(x)) || (has(n, 'global.json') ? 'global.json' : null);
    if (net) need('dotnet', net);
    if (has(n, 'Cargo.toml')) {
      need('cargo', 'Cargo.toml');
      need('rustc', 'Cargo.toml');
    }
    if (has(n, 'go.mod')) need('go', 'go.mod');
    if (has(n, 'Gemfile')) {
      need('ruby', 'Gemfile');
      need('bundler', 'Gemfile');
    }
    if (has(n, 'composer.json')) {
      need('php', 'composer.json');
      need('composer', 'composer.json');
    }
    if (has(n, 'pubspec.yaml')) need(/^\s*flutter\s*:/m.test(String(texts['pubspec.yaml'] || '')) ? 'flutter' : 'dart', 'pubspec.yaml');
    const compose = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].find((m) => has(n, m));
    const dockerMarker = has(n, 'Dockerfile') ? 'Dockerfile' : compose || (dirs.has('.devcontainer') || has(n, '.devcontainer') ? '.devcontainer/' : null);
    if (dockerMarker) need('docker', dockerMarker);
    const composeText = compose ? String(texts[compose] || '') : '';
    if (/image:\s*["']?postgres/i.test(composeText)) need('psql', compose, true);
    if (/image:\s*["']?(mysql|mariadb)/i.test(composeText)) need('mysql', compose, true);
    if (hasRe(names, /\.(sqlite3?|db)$/i)) need('sqlite3', names.find((x) => /\.(sqlite3?|db)$/i.test(x)), true);
    if (hasRe(names, /\.tf$/i)) need('terraform', names.find((x) => /\.tf$/i.test(x)));
    if (has(n, 'Chart.yaml') || dirs.has('helm') || dirs.has('charts')) need('helm', has(n, 'Chart.yaml') ? 'Chart.yaml' : 'helm/', true);
    if (dirs.has('k8s') || dirs.has('kubernetes')) need('kubectl', dirs.has('k8s') ? 'k8s/' : 'kubernetes/', true);
    if (has(n, 'vercel.json')) need('vercel', 'vercel.json', true);
    if (has(n, 'netlify.toml')) need('netlify', 'netlify.toml', true);
    if (has(n, 'firebase.json')) need('firebase', 'firebase.json', true);
    if (has(n, '.pre-commit-config.yaml')) need('precommit', '.pre-commit-config.yaml');
    if (dirs.has('.github')) need('gh', '.github/', true);
    return [...out.values()];
  }

  function parseJson(text) {
    if (typeof text !== 'string') return null;
    try {
      return JSON.parse(text.replace(/^﻿/, ''));
    } catch {
      return null;
    }
  }
  const depOf = (pkg, name) => !!pkg && [pkg.dependencies, pkg.devDependencies].some((d) => d && typeof d === 'object' && Object.prototype.hasOwnProperty.call(d, name));

  /** 필요한 버전을 읽을 파일 (맨 위 폴더) — 화면이 읽어 detectNeeds · requirements에 넘긴다 */
  const TEXT_FILES = ['package.json', 'pyproject.toml', '.nvmrc', '.node-version', '.python-version', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'go.mod', 'Cargo.toml', 'global.json', 'CMakeLists.txt', 'composer.json', '.ruby-version', 'pubspec.yaml', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'rust-toolchain.toml', 'requirements.txt', 'manage.py'];

  /** 파일 글 → 필요한 버전 { 도구 id: { range, from } } */
  function requirements(texts = {}) {
    const out = {};
    const set = (id, range, from) => {
      const r = String(range || '').trim();
      if (r && !out[id]) out[id] = { range: r, from };
    };
    const pkg = parseJson(texts['package.json']);
    if (pkg && pkg.engines && typeof pkg.engines === 'object') {
      if (typeof pkg.engines.node === 'string') set('node', pkg.engines.node, 'package.json engines');
      if (typeof pkg.engines.npm === 'string') set('npm', pkg.engines.npm, 'package.json engines');
      if (typeof pkg.engines.pnpm === 'string') set('pnpm', pkg.engines.pnpm, 'package.json engines');
    }
    for (const f of ['.nvmrc', '.node-version']) {
      const v = String(texts[f] || '').trim().replace(/^v/i, '');
      if (/^\d+(\.\d+){0,2}$/.test(v)) set('node', v, f);
    }
    const py = /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(String(texts['pyproject.toml'] || ''));
    if (py) set('python', py[1], 'pyproject.toml');
    const pyv = String(texts['.python-version'] || '').trim().split(/\s+/)[0];
    if (/^\d+\.\d+/.test(pyv)) set('python', pyv, '.python-version');
    const pom = String(texts['pom.xml'] || '');
    const jv = /<(?:maven\.compiler\.release|maven\.compiler\.source|java\.version|release)>\s*(?:1\.)?(\d+)\s*</.exec(pom);
    if (jv) set('jdk', `>=${jv[1]}`, 'pom.xml');
    for (const f of ['build.gradle', 'build.gradle.kts']) {
      const g = String(texts[f] || '');
      const m = /JavaLanguageVersion\.of\((\d+)\)/.exec(g) || /JavaVersion\.VERSION_(?:1_)?(\d+)/.exec(g) || /sourceCompatibility\s*=\s*['"]?(?:1\.)?(\d+)/.exec(g);
      if (m) set('jdk', `>=${m[1]}`, f);
    }
    const gomod = /^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/m.exec(String(texts['go.mod'] || ''));
    if (gomod) set('go', `>=${gomod[1]}`, 'go.mod');
    const rust = /^\s*rust-version\s*=\s*["']([\d.]+)["']/m.exec(String(texts['Cargo.toml'] || ''));
    if (rust) set('rustc', `>=${rust[1]}`, 'Cargo.toml');
    const gj = parseJson(texts['global.json']);
    if (gj && gj.sdk && typeof gj.sdk.version === 'string') set('dotnet', `>=${gj.sdk.version}`, 'global.json');
    const cm = /cmake_minimum_required\s*\(\s*VERSION\s+([\d.]+)/i.exec(String(texts['CMakeLists.txt'] || ''));
    if (cm) set('cmake', `>=${cm[1]}`, 'CMakeLists.txt');
    const comp = parseJson(texts['composer.json']);
    if (comp && comp.require && typeof comp.require.php === 'string') set('php', comp.require.php, 'composer.json');
    const rb = String(texts['.ruby-version'] || '').trim().replace(/^ruby-/, '');
    if (/^\d+\.\d+/.test(rb)) set('ruby', rb, '.ruby-version');
    const dart = /^\s*sdk\s*:\s*["']?([^"'\n]+)["']?/m.exec(String(texts['pubspec.yaml'] || ''));
    if (dart) set('dart', dart[1], 'pubspec.yaml');
    return out;
  }

  // ---------- 버전 ----------
  /** 도구 출력에서 버전 숫자(x.y 또는 x.y.z)를 찾는다. 없으면 null */
  function parseVersion(text) {
    const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text || ''));
    return m ? `${m[1]}.${m[2]}${m[3] !== undefined ? `.${m[3]}` : ''}` : null;
  }
  const parts = (v) => {
    const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v || ''));
    return m ? [Number(m[1]), m[2] === undefined ? null : Number(m[2]), m[3] === undefined ? null : Number(m[3])] : null;
  };
  /** a, b 비교 (b의 빈 자리는 0으로) → -1 · 0 · 1 */
  function cmp(a, b) {
    for (let i = 0; i < 3; i++) {
      const x = a[i] ?? 0;
      const y = b[i] ?? 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }
  /** 같은 앞자리인지 (b에 적힌 자리만) — "22"는 22.x.x, "3.12"는 3.12.x */
  const samePrefix = (a, b) => b.every((x, i) => x === null || a[i] === x);

  /**
   * 버전이 요구를 만족하는지: npm 꼴(>=18, ^20.1, ~1.2, 18.x, >=3.10,<4, a || b)과 파이썬 꼴(~=3.10, ==3.12.*)을 읽는다.
   * → true | false | null(읽을 수 없는 요구 — 판단하지 않음)
   */
  function satisfies(version, range) {
    const v = parts(version);
    const r = String(range || '').trim();
    if (!v || !r) return null;
    if (/^(\*|x|latest|lts\/\*|node|stable)$/i.test(r)) return true;
    let known = false;
    const alts = r.split('||').map((alt) => {
      const comps = alt.trim().replace(/(>=|<=|>|<|==|=|~=|\^|~)\s+/g, '$1').split(/[\s,]+/).filter(Boolean);
      if (!comps.length) return null;
      return comps.every((c) => {
        const m = /^(>=|<=|>|<|===?|=|~=|\^|~|!=)?v?([\dxX*.]+)$/.exec(c);
        if (!m) return false;
        const op = m[1] || '';
        const raw = m[2].replace(/\.[xX*](\.[xX*])?$/, '');
        const b = parts(raw);
        if (!b) return false;
        known = true;
        const c0 = cmp(v, b);
        switch (op) {
          case '>=': return c0 >= 0;
          case '>': return c0 > 0;
          case '<=': return c0 <= 0 || samePrefix(v, b);
          case '<': return c0 < 0;
          case '!=': return !samePrefix(v, b);
          case '^': return v[0] === b[0] && c0 >= 0;
          case '~': return v[0] === b[0] && (b[1] === null || v[1] === b[1]) && c0 >= 0;
          case '~=': return c0 >= 0 && (b[2] === null ? v[0] === b[0] : v[0] === b[0] && v[1] === b[1]);
          default: return samePrefix(v, b); // 22 · 3.12 · ==3.12.* · =1.2.3
        }
      });
    });
    if (!known) return null;
    return alts.some((x) => x === true);
  }

  // ---------- 판정 ----------
  /**
   * 필요한 도구 + 점검 결과 → 줄마다 판정.
   * needs: detectNeeds 결과(+ 사용자가 더한 것) · found: { id: { state: 'ok'|'missing'|'notOnPath', version, path, note } } | null(확장 — 확인 불가)
   * reqs: requirements 결과 · ignored: Set(무시할 id)
   * → [{ key, ids, name, because, optional, level: 'ok'|'warn'|'error'|'off'|'unknown', state, version, range, path, note, pick }]
   *   level: ok 있음 · warn 버전 안 맞음 / PATH에 없음 · error 없음 · off 선택 도구라 없어도 됨 · unknown 확인 못 함
   */
  function evaluate(needs, found, reqs = {}, ignored = new Set()) {
    const rows = [];
    for (const nd of needs || []) {
      const key = nd.group || nd.id;
      if (!key || ignored.has(key)) continue;
      const ids = nd.group ? GROUPS[nd.group] : [nd.id];
      const name = nd.group ? ids.map((i) => TOOLS[i].name).join(' / ') : TOOLS[nd.id] ? TOOLS[nd.id].name : nd.id;
      const base = { key, ids, name, because: nd.because || '', optional: !!nd.optional };
      if (!found) {
        rows.push({ ...base, level: 'unknown', state: 'unknown', range: (reqs[key] || {}).range || '' });
        continue;
      }
      // 묶음이면 있는 것 중 첫 번째(PATH에 있는 것 먼저)
      const cands = ids.map((i) => ({ id: i, ...(found[i] || { state: 'missing' }) }));
      const pick = cands.find((c) => c.state === 'ok') || cands.find((c) => c.state === 'notOnPath') || cands[0];
      const req = reqs[pick.id] || reqs[key];
      const row = { ...base, pick: pick.id, state: pick.state, version: pick.version || '', path: pick.path || '', note: pick.note || '', range: req ? req.range : '', rangeFrom: req ? req.from : '' };
      if (pick.state === 'missing') row.level = nd.optional ? 'off' : 'error';
      else if (pick.state === 'notOnPath') row.level = 'warn';
      else if (req && pick.version && satisfies(pick.version, req.range) === false) {
        row.level = 'warn';
        row.state = 'version';
      } else row.level = 'ok';
      rows.push(row);
    }
    return rows;
  }

  /** 판정 줄 → 개수 { ok, warn, error, off, unknown, total } — 사이드바 한 줄 요약용 */
  function summarize(rows, ready = []) {
    const s = { ok: 0, warn: 0, error: 0, off: 0, unknown: 0, total: 0 };
    for (const r of rows || []) {
      s[r.level] = (s[r.level] || 0) + 1;
      s.total++;
    }
    for (const r of ready || []) if (r.level === 'warn') s.warn++;
    return s;
  }

  /**
   * "설치는 됐지만 준비가 안 된" 상태 (맨 위 폴더 이름만 본다 — .env 같은 파일은 열지 않는다)
   * → [{ key, level: 'warn'|'info', cmd? }]  (글은 화면 사전 dev.ready.<key>)
   */
  function readiness(entries, texts = {}) {
    const names = (entries || []).map((e) => (typeof e === 'string' ? e : e && e.name)).filter(Boolean);
    const n = lower(names);
    const out = [];
    if (has(n, 'package.json') && !has(n, 'node_modules')) {
      const pkg = parseJson(texts['package.json']);
      const deps = pkg && ['dependencies', 'devDependencies'].some((k) => pkg[k] && Object.keys(pkg[k]).length);
      if (deps) out.push({ key: 'nodeModules', level: 'warn', cmd: installCmd(n, pkg) });
    }
    const py = ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'manage.py'].some((m) => has(n, m));
    if (py && !has(n, '.venv', 'venv', 'env', '.env-py') && !has(n, 'environment.yml', 'poetry.lock', 'Pipfile', 'uv.lock')) out.push({ key: 'venv', level: 'info', cmd: 'py -m venv .venv' });
    const example = names.find((x) => /^\.env\.(example|sample|template)$/i.test(x));
    if (example && !has(n, '.env')) out.push({ key: 'envFile', level: 'warn', cmd: `copy ${example} .env`, file: example });
    return out;
  }
  function installCmd(n, pkg) {
    const pm = String((pkg && pkg.packageManager) || '').split('@')[0];
    if (has(n, 'pnpm-lock.yaml') || pm === 'pnpm') return 'pnpm install';
    if (has(n, 'yarn.lock') || pm === 'yarn') return 'yarn install';
    if (has(n, 'bun.lockb', 'bun.lock') || pm === 'bun') return 'bun install';
    return has(n, 'package-lock.json') ? 'npm ci' : 'npm install';
  }

  // 개발 서버 기본 포트 (이미 쓰는 중이면 알린다): package.json 의존성 · 파일로 고른다
  const PORT_RULES = [
    { dep: 'vite', port: 5173 },
    { dep: '@sveltejs/kit', port: 5173 },
    { dep: 'next', port: 3000 },
    { dep: 'react-scripts', port: 3000 },
    { dep: 'nuxt', port: 3000 },
    { dep: '@remix-run/dev', port: 3000 },
    { dep: '@angular/core', port: 4200 },
    { dep: 'astro', port: 4321 },
    { dep: 'gatsby', port: 8000 },
    { dep: 'webpack-dev-server', port: 8080 },
    { dep: '@vue/cli-service', port: 8080 },
  ];
  /** 열어 볼 포트 목록 (최대 4개) */
  function devPorts(entries, texts = {}) {
    const n = lower((entries || []).map((e) => (typeof e === 'string' ? e : e && e.name)).filter(Boolean));
    const pkg = parseJson(texts['package.json']);
    const ports = new Set();
    for (const r of PORT_RULES) if (depOf(pkg, r.dep)) ports.add(r.port);
    if (has(n, 'manage.py')) ports.add(8000);
    if (/spring-boot/.test(String(texts['pom.xml'] || '') + String(texts['build.gradle'] || '') + String(texts['build.gradle.kts'] || ''))) ports.add(8080);
    if (/^\s*flask\b/im.test(String(texts['requirements.txt'] || ''))) ports.add(5000);
    return [...ports].slice(0, 4);
  }

  /** 설치 안내 한 줄: winget 명령 → 정해 둔 명령 → 없음 */
  const installHint = (id) => {
    const tl = TOOLS[id];
    if (!tl) return '';
    return tl.winget ? `winget install --id ${tl.winget} -e` : tl.cmd || '';
  };

  /** AI 요청에 붙일 환경 한 줄 (v0.42.0에서 씀): 이름과 버전만, 경로는 넣지 않는다 */
  function envLine(rows) {
    const items = [];
    for (const r of rows || []) {
      if (r.level === 'unknown') continue;
      const nm = r.pick && TOOLS[r.pick] ? TOOLS[r.pick].name : r.name;
      if (r.state === 'missing') {
        if (!r.optional) items.push(`${r.name}: -`);
      } else items.push(r.version ? `${nm} ${r.version}` : nm);
    }
    return items.join(', ');
  }

  // 로드맵 작업의 "필요한 도구"(AI가 적은 이름)를 도구 id로 (v0.42.0). 모르는 이름은 null
  const ALIASES = {
    nodejs: 'node', 'node.js': 'node', javascript: 'node', js: 'node', typescript: 'node', ts: 'node', python3: 'python', py: 'python',
    java: 'jdk', javac: 'jdk', openjdk: 'jdk', maven: 'mvn', 'g++': 'gpp', 'c++': 'gpp', cpp: 'gpp', c: 'gcc', cc: 'gcc', 'visual studio': 'msvc', 'visual c++': 'msvc',
    '.net': 'dotnet', 'dotnet-sdk': 'dotnet', 'c#': 'dotnet', csharp: 'dotnet', rust: 'cargo', rustup: 'cargo', golang: 'go', 'docker-compose': 'docker', 'docker compose': 'docker',
    k8s: 'kubectl', kubernetes: 'kubectl', postgres: 'psql', postgresql: 'psql', mariadb: 'mysql', sqlite: 'sqlite3', 'pre-commit': 'precommit', 'clang-format': 'clangformat',
    playwright: 'pwbrowsers', android: 'adb', 'android sdk': 'adb', bundle: 'bundler', 'github cli': 'gh', kotlin: 'kotlinc', 'gnu make': 'make', 'mingw32-make': 'make',
  };
  function toolIdOf(name) {
    const n = String(name || '').trim().toLowerCase().replace(/\s*\(.*\)\s*$/, '');
    if (!n) return null;
    if (ALIASES[n]) return ALIASES[n]; // java → JDK처럼 별칭이 먼저
    if (TOOLS[n]) return n;
    return TOOL_IDS.find((id) => TOOLS[id].name.toLowerCase() === n || (TOOLS[id].exe || []).includes(n)) || null;
  }

  /** 로드맵의 끝나지 않은 작업이 적은 도구 → needs [{ id, because: 'task:t3' }] (같은 도구는 처음 작업 하나만) */
  function taskNeeds(rm) {
    const out = new Map();
    for (const m of (rm && rm.milestones) || []) {
      for (const tk of m.tasks || []) {
        if (tk.status === 'done') continue;
        for (const name of tk.tools || []) {
          const id = toolIdOf(name);
          if (id && !out.has(id)) out.set(id, { id, because: `task:${tk.id}` });
        }
      }
    }
    return [...out.values()];
  }

  /** 판정 줄에서 도구 이름 목록(작업이 적은 것)에 해당하는 문제 줄 → [{ name, level, state }] (없음 · 버전 · PATH) */
  function problemsFor(rows, names) {
    const want = new Set((names || []).map(toolIdOf).filter(Boolean));
    if (!want.size) return [];
    return (rows || []).filter((r) => r.ids.some((i) => want.has(i)) && (r.level === 'error' || r.level === 'warn')).map((r) => ({ name: r.pick && TOOLS[r.pick] ? TOOLS[r.pick].name : r.name, level: r.level, state: r.state }));
  }

  /** 검사 이름(test · lint · pytest …) → 그 검사에 꼭 필요한 도구 id */
  const CHECK_TOOLS = { test: ['node', 'npm'], lint: ['node', 'npm'], typecheck: ['node', 'npm'], build: ['node', 'npm'], pytest: ['python'], 'cargo-test': ['cargo'], 'go-test': ['go'] };

  /** 점검 결과(found)에서 검사에 필요한 도구 중 "없음"인 것 → 첫 번째 { check, id } | null (점검 전 · 확장은 null) */
  function missingForChecks(found, checks) {
    if (!found) return null;
    for (const c of checks || []) {
      for (const id of CHECK_TOOLS[c] || []) {
        if (found[id] && found[id].state === 'missing') return { check: c, id };
      }
    }
    return null;
  }

  // 본체가 받는 값 검사: 도구 id는 목록 안의 것만, 포트는 1024~65535 숫자만 (최대 8개)
  function cleanCheckRequest(req) {
    if (!req || typeof req !== 'object') return null;
    const tools = Array.isArray(req.tools) ? [...new Set(req.tools.filter((x) => typeof x === 'string' && TOOL_IDS.includes(x)))] : [];
    const ports = Array.isArray(req.ports) ? [...new Set(req.ports.filter((p) => Number.isInteger(p) && p >= 1024 && p <= 65535))].slice(0, 8) : [];
    return { tools, ports, docker: tools.includes('docker'), javaHome: tools.includes('jdk') || tools.includes('java') };
  }

  /** needs → 본체에 물어볼 도구 id (묶음은 풀어서) */
  const idsOf = (needs) => [...new Set((needs || []).flatMap((nd) => (nd.group ? GROUPS[nd.group] : [nd.id])).filter((i) => TOOLS[i]))];

  return { toolIdOf, taskNeeds, problemsFor, CHECK_TOOLS, missingForChecks, TOOLS, TOOL_IDS, CATS, GROUPS, LOCAL_PKGS, TEXT_FILES, detectNeeds, requirements, parseVersion, satisfies, evaluate, summarize, readiness, devPorts, installHint, envLine, cleanCheckRequest, idsOf, parseJson };
});
