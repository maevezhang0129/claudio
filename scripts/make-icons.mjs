/**
 * 生成 PWA 图标。
 *
 * 界面的设计语言就是点阵，所以图标按像素直接画 —— 不引入任何绘图依赖，
 * 用 zlib 手写 PNG。与其找个字体渲染再截图，不如直接把点画出来，
 * 这样图标和界面上的 Doto 字标是同一套物理逻辑。
 *
 * 跑法：npm run icons
 */

import { deflateSync } from "node:zlib";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 与 style.css 的令牌一致
const BG = [0x08, 0x09, 0x0a];
const INK = [0xe9, 0xed, 0xec];
const SIGNAL = [0x4a, 0xde, 0x80];

/**
 * 5×7 点阵的 C。
 * `@` 是那盏 ON AIR 信号灯 —— 它是字形自己的一个点，不是贴上去的装饰，
 * 所以不会和字形重叠出白边。
 */
const GLYPH = [
  " ### ",
  "#   #",
  "#    ",
  "#    ",
  "#    ",
  "#   @",
  " ### ",
];

// ── 最小 PNG 编码器 ────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** pixels: Uint8Array，每像素 3 字节 RGB */
function encodePng(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 2;   // 真彩色
  // 10,11,12 = 压缩/滤波/隔行，全 0

  // 每行前面补一个滤波字节 0
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    const dst = y * (width * 3 + 1);
    raw[dst] = 0;
    pixels.copy
      ? pixels.copy(raw, dst + 1, y * width * 3, (y + 1) * width * 3)
      : Buffer.from(pixels).copy(raw, dst + 1, y * width * 3, (y + 1) * width * 3);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── 画图标 ────────────────────────────────
function drawIcon(size) {
  const px = Buffer.alloc(size * size * 3);
  const put = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 3;
    px[i] = r; px[i + 1] = g; px[i + 2] = b;
  };

  // 底色
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(x, y, BG);

  const cols = GLYPH[0].length;
  const rows = GLYPH.length;
  // 字形占画布约 62%，四周留白 —— 主屏上图标会被系统再裁一圈
  const cell = Math.floor((size * 0.62) / cols);
  const dotR = cell * 0.40;
  const gw = cell * cols;
  const gh = cell * rows;
  const ox = (size - gw) / 2 + cell / 2;
  const oy = (size - gh) / 2 + cell / 2;

  const disc = (cx, cy, r, color) => {
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r2) put(x, y, color);
      }
    }
  };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ch = GLYPH[r][c];
      if (ch === " ") continue;
      disc(ox + c * cell, oy + r * cell, dotR, ch === "@" ? SIGNAL : INK);
    }
  }

  return px;
}

async function main() {
  const dir = path.join(ROOT, "public");
  await mkdir(dir, { recursive: true });
  // 192/512 是 PWA 清单要求的两个尺寸，180 给 iOS 的 apple-touch-icon
  for (const size of [180, 192, 512]) {
    const png = encodePng(size, size, drawIcon(size));
    const name = `icon-${size}.png`;
    await writeFile(path.join(dir, name), png);
    console.log(`  public/${name}  ${size}×${size}  ${(png.length / 1024).toFixed(1)} KB`);
  }
}

main().catch((e) => {
  console.error("  生成失败：", e.message);
  process.exit(1);
});
