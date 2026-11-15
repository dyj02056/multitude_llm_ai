'use strict';

// npm install · npm ci 때(prepare) git 훅 폴더를 scripts/hooks로 정한다 (v0.24.0).
// [쉽게 말하면] 커밋할 때 "크롬 확장 폴더를 다시 만들었는지" 자동으로 확인하게 연결하는 스크립트입니다.
// git 저장소가 아니거나(압축 파일로 받은 경우) git이 없으면 조용히 건너뜁니다.

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
if (!fs.existsSync(path.join(root, '.git'))) process.exit(0);
try {
  execFileSync('git', ['config', 'core.hooksPath', 'scripts/hooks'], { cwd: root, stdio: 'ignore' });
} catch {
  // git이 없으면 훅 없이 쓴다 (CI의 check:ext가 대신 잡는다)
}
