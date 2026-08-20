/**
 * 从本机 Music.app 导出资料库与歌单 —— 语料的原始素材。
 *
 * 走 AppleScript，不碰 Library.musicdb（那是二进制私有格式）。
 * 每个歌单只发一次 Apple Event，用并行数组取字段，660 首曲目秒级完成。
 *
 * 注意：不取 loved/favorited —— 部分 Music 版本上会报 -1728，
 * 而播放次数本来就是比「是否收藏」更强的信号。
 *
 * 输出：user/raw/apple-music.json（本地保留，不进 prompt，不提交）
 * 蒸馏成语料是 scripts/ingest.mjs 的事。
 *
 * 跑法：npm run export:apple
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 单元与记录分隔符 —— 曲名里不可能出现的控制字符 */
const US = String.fromCharCode(31);
const RS = String.fromCharCode(30);

/** Music.app 自动生成的全库歌单，内容与 library 重复，不当作「歌单」 */
const SYNTHETIC = new Set(["Library", "Music", "音乐", "资料库"]);

async function osa(script) {
  const { stdout } = await run("osascript", ["-e", script], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** 一次 Apple Event 取回某个歌单所有曲目的并行字段 */
function trackFieldsScript(target) {
  return `
tell application "Music"
  set p to ${target}
  set ns to name of every track of p
  set ar to artist of every track of p
  set al to album of every track of p
  set gn to genre of every track of p
  set yr to year of every track of p
  set pc to played count of every track of p
  set out to ""
  repeat with i from 1 to count of ns
    set out to out & (item i of ns) & "${US}" & (item i of ar) & "${US}" & ¬
      (item i of al) & "${US}" & (item i of gn) & "${US}" & (item i of yr) & "${US}" & ¬
      (item i of pc) & "${RS}"
  end repeat
  return out
end tell`;
}

function parseTracks(raw) {
  return raw
    .split(RS)
    .map((rec) => rec.replace(/\n/g, "").trim())
    .filter(Boolean)
    .map((rec) => {
      const [title, artist, album, genre, year, played] = rec.split(US);
      return {
        title: title ?? "",
        artist: artist ?? "",
        album: album ?? "",
        genre: genre ?? "",
        year: Number(year) || null,
        played: Number(played) || 0,
      };
    })
    .filter((t) => t.title);
}

async function main() {
  process.stdout.write("  读取歌单列表… ");
  const names = (await osa(`tell application "Music" to return name of every playlist`))
    .trim()
    .split(", ")
    .map((s) => s.trim())
    .filter(Boolean);
  console.log(`${names.length} 个`);

  process.stdout.write("  读取完整资料库… ");
  const library = parseTracks(await osa(trackFieldsScript("library playlist 1")));
  console.log(`${library.length} 首`);

  const playlists = [];
  for (const name of names) {
    if (SYNTHETIC.has(name)) continue;
    try {
      // 歌单名里的双引号要转义，否则 AppleScript 字符串会断掉
      const safe = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const tracks = parseTracks(await osa(trackFieldsScript(`playlist "${safe}"`)));
      playlists.push({ name, count: tracks.length, tracks });
      console.log(`  ${name.padEnd(20)} ${tracks.length} 首`);
    } catch (err) {
      console.log(`  ${name.padEnd(20)} 跳过（${err.message.split("\n")[0]}）`);
    }
  }

  const out = {
    source: "apple-music",
    exportedAt: new Date().toISOString(),
    library,
    playlists,
  };
  const dest = path.join(ROOT, "user", "raw", "apple-music.json");
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, JSON.stringify(out, null, 2));

  const kb = Math.round((await import("node:fs")).statSync(dest).size / 1024);
  console.log(`\n  已写入 user/raw/apple-music.json（${kb} KB）`);
  console.log("  下一步：npm run ingest  把它蒸馏成语料");
}

main().catch((err) => {
  console.error("\n  导出失败：", err.message);
  console.error("  如果是权限问题，去 系统设置 → 隐私与安全性 → 自动化，允许终端控制「音乐」。");
  process.exit(1);
});
