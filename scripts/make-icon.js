'use strict';

// 앱 아이콘(build/icon.png, 512x512)을 만든다. 외부 이미지 도구 없이 Node만 쓴다.
// 어두운 둥근 사각형 위에 기본 네 서비스 색의 패널 2x2. electron-builder가 이 PNG로 .ico를 만든다.
//   node scripts/make-icon.js
// 크롬 확장 프로그램 아이콘(16·32·48·128)은 scripts/build-extension.js가 renderPng(크기)로 만든다.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512; // 그림 좌표의 기준 크기
const SS = 4; // 가장자리를 부드럽게 하려고 4x4로 나눠 칠한 뒤 평균을 낸다

const BG = [0x17, 0x1a, 0x22];
const TILES = [
  [0x4f, 0x8d, 0xf5], // Gemini
  [0x10, 0xa3, 0x7f], // ChatGPT
  [0x4d, 0x6b, 0xfe], // DeepSeek
  [0x20, 0xb8, 0xcd], // Perplexity
];

// 둥근 사각형 안에 있는지
function inRoundRect(x, y, x0, y0, w, h, r) {
  if (x < x0 || y < y0 || x > x0 + w || y > y0 + h) return false;
  const cx = Math.min(Math.max(x, x0 + r), x0 + w - r);
  const cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

const PAD = 40; // 바깥 여백
const GAP = 28; // 패널 사이 간격
const INNER = 64; // 배경 안쪽 여백
const tile = (SIZE - 2 * PAD - 2 * INNER - GAP) / 2;

function colorAt(x, y) {
  if (!inRoundRect(x, y, PAD, PAD, SIZE - 2 * PAD, SIZE - 2 * PAD, 96)) return null;
  for (let i = 0; i < 4; i++) {
    const tx = PAD + INNER + (i % 2) * (tile + GAP);
    const ty = PAD + INNER + Math.floor(i / 2) * (tile + GAP);
    if (inRoundRect(x, y, tx, ty, tile, tile, 36)) return TILES[i];
  }
  return BG;
}

// ---- PNG 인코딩 ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** size×size PNG 버퍼. 512 기준 그림을 줄여 그리고, 픽셀마다 SS×SS로 나눠 칠해 가장자리를 부드럽게 한다. */
function renderPng(size = SIZE) {
  const scale = SIZE / size;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // 줄마다 필터 없음
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = colorAt((x + (sx + 0.5) / SS) * scale, (y + (sy + 0.5) / SS) * scale);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8비트
  ihdr[9] = 6; // RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (require.main === module) {
  const png = renderPng();
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes)`);
}

module.exports = { renderPng };
