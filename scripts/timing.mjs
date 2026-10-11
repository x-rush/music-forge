#!/usr/bin/env node
// music-forge timing — 歌词词级时间轴对齐（acedata /suno/timing，免费）
// 用法：
//   node timing.mjs --from <meta.json>                 # 推荐：读 audio_id + lyrics
//   node timing.mjs --audio-id <id> --lyric <lyric.txt>
//   node timing.mjs --audio-url <url> --lyric <lyric.txt>   # 从直链提取 UUID 形态 id（兜底）
// 输出（timing-output/<时间戳>-timing/）：
//   <title>-timing.json — 完整响应（aligned_words：word/start_s/end_s/p_align）
//   <title>.lrc         — 行级 LRC（剥掉 [Verse]/[Chorus] 等结构标签后按行起始时间生成）
// 鉴权/账本与 gen-music/stems 同源。免费端点（响应无 cost 字段）。
//
// ⚠️ 已知坑（2026-10-10 实测，小拾/MV 场景反馈）：
//   1. 对齐算法会把间奏吞进句尾 end_s——做歌词视频时最后一句的 end 需人工修到实际演唱位置，
//      否则字幕会挂十几秒；LRC 只用 start_s，不受此坑影响。
//   2. aligned_words 元素的 word 含结构标签和换行（如 "[Chorus]\n就乘着夜色去流浪\n"），
//      生成 LRC 前需剥标签、按行拆分。
//   3. 早期 meta.json 的 tracks[] 无 id 字段——从 audio_url 提取 UUID 兜底（--from 已内置）。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = dirname(HERE);
const REGISTRY = JSON.parse(readFileSync(join(SKILL, "models.json"), "utf8"));
const LOG = join(HERE, "gen-log.jsonl");

const die = (msg, code = 2) => { console.error(`❌ ${msg}`); process.exit(code); };
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const safeName = (s, fallback) => { const n = String(s ?? fallback).replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60); return n || fallback; };

if (process.argv.includes("--help") || !process.argv[2]) {
  console.log(`music-forge timing — 歌词词级时间轴对齐（免费）

  --from <meta.json>   推荐：读 audio_id + lyrics
  --audio-id <id>      配 --lyric <歌词txt>
  --audio-url <url>    从 CDN 直链提取 UUID 作 audio_id，配 --lyric
  --out <dir>          输出目录（默认 ./timing-output/<时间戳>-timing/）`);
  process.exit(0);
}

// ---------- 鉴权（与 gen-music 同源） ----------
const prov = REGISTRY.providers.acedata;
const authEnvNames = Array.isArray(prov.auth_env) ? prov.auth_env : [prov.auth_env];
let apiKey = authEnvNames.map((n) => process.env[n]).find(Boolean);
if (!apiKey && prov.auth_file) {
  const p = join(SKILL, prov.auth_file);
  if (existsSync(p)) apiKey = readFileSync(p, "utf8").trim();
}
if (!apiKey) die(`缺少鉴权：设环境变量 ${authEnvNames.join(" 或 ")}，或写入 ${prov.auth_file}（已 gitignore）`);

// ---------- 定位 audio_id + lyric ----------
const started = Date.now();
let audioId = arg("audio-id");
let lyric = arg("lyric") ? readFileSync(resolve(arg("lyric")), "utf8") : undefined;
let title = "untitled";
let sourceNote = arg("audio-id") ? "audio-id" : null;

if (arg("audio-url")) {
  const m = String(arg("audio-url")).match(/suno\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.mp3/i);
  if (m) { audioId = audioId ?? m[1]; sourceNote = sourceNote ?? "audio-url 提取 UUID"; }
}
if (arg("from")) {
  const meta = JSON.parse(readFileSync(resolve(arg("from")), "utf8"));
  const t0 = meta.tracks?.[0] ?? {};
  if (!audioId) {
    audioId = t0.id ?? (t0.audio_url ? (t0.audio_url.match(/suno\/([0-9a-f-]{36})\.mp3/i) ?? [])[1] : undefined);
    sourceNote = sourceNote ?? "meta audio_url 提取 UUID（旧版 meta 无 id 的兜底）";
  }
  lyric = lyric ?? t0.lyrics;
  title = t0.title ?? title;
}
if (!audioId) die("无法确定 audio_id：用 --from / --audio-id / --audio-url 之一");
if (!lyric) die("缺歌词：--from 的 meta 无 tracks[].lyrics 时必须 --lyric <歌词txt>");
console.log(`🎯 audio_id=${audioId}${sourceNote ? `（${sourceNote}）` : ""} · 歌词 ${lyric.length} 字符`);

// ---------- 调用 /suno/timing（同步 <30s，免费） ----------
const res = await fetch("https://api.acedata.cloud/suno/timing", {
  method: "POST",
  headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({ audio_id: audioId, lyric }),
  signal: AbortSignal.timeout(60000),
});
const text = await res.text();
if (!res.ok) die(`acedata HTTP ${res.status}\n${text.slice(0, 500)}`);
let j;
try { j = JSON.parse(text); } catch { die(`响应非 JSON: ${text.slice(0, 300)}`); }
if (j.success === false) { const e = j.error || {}; die(`业务失败 [${e.code ?? "?"}] ${e.message ?? text.slice(0, 300)}`); }
const words = j.data?.aligned_words ?? [];
if (!words.length) die(`响应无 aligned_words: ${text.slice(0, 300)}`);

// ---------- LRC 生成（剥结构标签 → 按行 → 行首时间戳） ----------
const lrcLines = [];
let lineCount = 0;
for (const w of words) {
  if (w.success === false) continue;
  const ts = Number(w.start_s);
  if (!Number.isFinite(ts)) continue;
  const mm = String(Math.floor(ts / 60)).padStart(2, "0");
  const ss = (ts % 60).toFixed(2).padStart(5, "0");
  const stamp = `[${mm}:${ss}]`;
  for (const raw of String(w.word ?? "").split(/\r?\n/)) {
    const clean = raw.replace(/\[[^\]]*\]/g, "").trim(); // 剥 [Verse]/[Chorus] 等结构标签
    if (!clean) continue;
    lrcLines.push(`${stamp}${clean}`);
    lineCount++;
  }
}
if (!lineCount) die("LRC 生成失败：对齐结果清洗后无有效歌词行");

// ---------- 落盘 ----------
const stampTs = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = resolve(arg("out") || `timing-output/${stampTs}-timing`);
mkdirSync(outDir, { recursive: true });
const titleFile = safeName(title, "untitled");
writeFileSync(join(outDir, `${titleFile}-timing.json`), JSON.stringify(j, null, 2));
writeFileSync(join(outDir, `${titleFile}.lrc`), lrcLines.join("\n") + "\n");

// ---------- 记账（免费端点，est 0） ----------
if (existsSync(LOG) && !readFileSync(LOG, "utf8").endsWith("\n")) {
  const c = readFileSync(LOG, "utf8"); writeFileSync(LOG, c.replace(/\n?$/, "\n"));
}
const { appendFileSync } = await import("node:fs");
appendFileSync(LOG, JSON.stringify({
  ts: new Date().toISOString(), skill: "music-forge", purpose: "timing", provider: "acedata",
  model: "timing", audio_id: audioId, cost_credits: 0, est_usd: null,
  seconds: Math.round((Date.now() - started) / 1000), lines: lineCount, out_dir: outDir,
}) + "\n");

console.log(`\n✅ 时间轴就绪（${Math.round((Date.now() - started) / 1000)}s）→ ${outDir}`);
console.log(`   ${titleFile}-timing.json（词级 ${words.length} 段）+ ${titleFile}.lrc（${lineCount} 行）`);
console.log(`📒 记账：timing · 免费（响应无 cost）`);
console.log(`⚠️ 已知坑：间奏会被吞进句尾 end_s——做逐词卡拉 OK 前人工修 end；LRC 只用 start_s 不受影响`);
