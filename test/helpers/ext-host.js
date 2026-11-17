'use strict';
// 크롬 확장 앱 탭의 host 코드 전체를 한 글로 읽는다.
// v0.31.0에서 extension/host.js를 host-panels.js · host-remote.js · host.js로 나눴다 —
// "host에 이런 코드가 있다"를 보는 테스트는 어느 파일로 옮겨졌든 통과해야 하므로 셋을 이어 붙여 본다.
const fs = require('fs');
const path = require('path');

const HOST_FILES = ['host-panels.js', 'host-remote.js', 'host.js'];
const readHost = () => HOST_FILES.map((f) => fs.readFileSync(path.join(__dirname, '..', '..', 'extension', f), 'utf8')).join('\n');

module.exports = { HOST_FILES, readHost };
