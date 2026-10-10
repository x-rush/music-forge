#!/usr/bin/env node
// music-forge 生成入口 — 单命令出歌：提交 → 等待 → 下载 → 记账
// 用法：
//   node gen-music.mjs --model suno-v6 --prompt "轻快的城市流行" --out ./out
//   node gen-music.mjs --model suno-v6 --lyrics-file song.txt --title "标题" --style "mandopop, 清亮女声"
//   node gen-music.mjs --model mureka-v95 --prompt "lofi hip hop" --instrumental
//   node gen-music.mjs --resume <jobid> --provider useapi --model mureka-v95   # 重取 useapi 任务只下载
//   node gen-music.mjs --report                                                # 本机账本报表
// 零依赖，Node >= 18。账本：脚本旁 gen-log.jsonl（每次成功生成追加一行）。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = dirname(HERE);
const REGISTRY = JSON.parse(readFileSync(join(SKILL, "models.json"), "utf8"));
const LOG = join(HERE, "gen-log.jsonl");
const BUDGET = join(HERE, "budget.json");

const die = (msg, code = 2) => { console.error(`❌ ${msg}`); process.exit(code); };
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

// ---------- 参数 ----------
if (hasFlag("report")) { execFileSync(process.execPath, [join(HERE, "budget.mjs")], { stdio: "inherit" }); process.exit(0); }
if (process.argv.includes("--help") || !process.argv[2]) {
  console.log(`music-forge gen-music — 生成音乐（Suno via AceDataCloud / Mureka via useapi）

必选（二选一）:
  --model <alias>     模型别名，见 models.json（${Object.keys(REGISTRY.models).join(", ")}）
  --resume <jobid>    重取 useapi 作业（配 --provider useapi --model <alias>）

生成参数:
  --prompt <text>     灵感模式描述（无歌词时必填）
  --lyrics <text>     自定义歌词（触发 Suno custom 模式）
  --lyrics-file <p>   歌词从文件读（推荐，免 shell 转义）
  --title <text>      歌名
  --style <text>      风格标签（Suno custom 模式；灵感模式下并入 prompt）
  --instrumental      纯音乐
  --voice <f|m>       人声性别（Suno 4.5+）
  --duration <sec>    期望时长 10-360（倾向值非硬上限）
  --negative-tags     反向风格标签（Suno）
  --advanced-json <p> 原样合并进请求体的 JSON 文件（长尾参数逃生口）
  --out <dir>         输出目录（默认 ./music-output/<时间戳>-<别名>/）
  --report            查看账本报表`);
  process.exit(0);
}

const alias = arg("model");
const modelDef = REGISTRY.models[alias];
if (!modelDef) die(`未知模型别名 "${alias}"，可选：${Object.keys(REGISTRY.models).join(", ")}`);
const providerName = arg("provider") || Object.keys(modelDef.availability)[0];
const channel = modelDef.availability[providerName];
const providerDef = REGISTRY.providers[providerName];
if (!channel || !providerDef) die(`模型 ${alias} 未在渠道 ${providerName} 上架`);

const prompt = arg("prompt");
const lyrics = arg("lyrics") ?? (arg("lyrics-file") ? readFileSync(resolve(arg("lyrics-file")), "utf8") : undefined);
const title = arg("title");
const style = arg("style");
const instrumental = hasFlag("instrumental");
const voice = arg("voice");
const duration = arg("duration") ? Number(arg("duration")) : undefined;
const negativeTags = arg("negative-tags");
const advancedJson = arg("advanced-json") ? JSON.parse(readFileSync(resolve(arg("advanced-json")), "utf8")) : undefined;
const resumeJob = arg("resume");
if (!resumeJob && !prompt && !lyrics) die("缺 --prompt 或 --lyrics / --lyrics-file（总得告诉它写什么歌）");

// ---------- 鉴权（env 优先，退 gitignored token 文件；绝不写入任何文件/日志） ----------
const authEnvNames = Array.isArray(providerDef.auth_env) ? providerDef.auth_env : [providerDef.auth_env];
let apiKey = authEnvNames.map((n) => process.env[n]).find(Boolean);
if (!apiKey && providerDef.auth_file) {
  const p = join(SKILL, providerDef.auth_file);
  if (existsSync(p)) apiKey = readFileSync(p, "utf8").trim();
}
if (!apiKey) die(`缺少鉴权：设环境变量 ${authEnvNames.join(" 或 ")}，或写入 ${providerDef.auth_file}（已 gitignore）`);

// ---------- 预算门（超支 exit 2，与 image-forge 同语义） ----------
function budgetCheck() {
  const conf = existsSync(BUDGET) ? JSON.parse(readFileSync(BUDGET, "utf8")) : null;
  if (!conf) return;
  const entries = existsSync(LOG)
    ? readFileSync(LOG, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  const now = new Date();
  const month = entries.filter((e) => { const d = new Date(e.ts); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(); });
  if (conf.monthly_usd && month.filter((e) => e.provider === "useapi").reduce((s, e) => s + (e.est_usd ?? 0), 0) >= conf.monthly_usd) {
    console.error("⛔ useapi 通道本月估算花费已达月预算上限——继续生成须用户明示同意"); process.exit(2);
  }
  if (conf.monthly_credits && month.filter((e) => e.provider === "acedata").reduce((s, e) => s + (e.cost_credits ?? 0), 0) >= conf.monthly_credits) {
    console.error("⛔ acedata 通道本月积分消耗已达上限——继续生成须用户明示同意"); process.exit(2);
  }
}
budgetCheck();

// ---------- 组装渠道参数 ----------
function buildParams() {
  const p = {};
  if (providerName === "acedata") {
    if (lyrics) { p.custom = true; p.lyric = lyrics; if (style) p.style = style; }
    else p.prompt = style ? `${prompt}；风格：${style}` : prompt;
    if (title) p.title = title;
    if (instrumental) p.instrumental = true;
    if (voice) p.vocal_gender = voice;
    if (duration) p.duration = Math.min(360, Math.max(10, Math.round(duration)));
    if (negativeTags) p.negative_tags = negativeTags;
  } else if (providerName === "useapi") {
    if (prompt) p.prompt = style ? `${prompt}；风格：${style}` : prompt;
    if (lyrics) p.lyrics = lyrics;
    if (title) p.title = title;
    if (instrumental) p.instrumental = true; // provider 据此路由到 create-instrumental
  }
  return { ...p, ...advancedJson };
}

// ---------- 下载与校验 ----------
function safeName(s, fallback) {
  const n = String(s ?? fallback).replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return n || fallback;
}
function probeDuration(file) {
  try {
    const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
    return Number(out.trim()) || undefined;
  } catch { return undefined; }
}
async function downloadTracks(tracks, outDir) {
  mkdirSync(outDir, { recursive: true });
  const files = [];
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const dest = join(outDir, `${String(i + 1).padStart(2, "0")}-${safeName(t.title, "track")}.mp3`);
    const r = await fetch(t.audio_url, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) { console.error(`⚠️ 下载失败 HTTP ${r.status}：${t.audio_url}`); continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 50 * 1024) console.error(`⚠️ ${dest} 仅 ${(buf.length / 1024).toFixed(0)}KB，疑似残片，请试听确认`);
    writeFileSync(dest, buf);
    const d = probeDuration(dest);
    files.push({ file: dest, bytes: buf.length, duration_s: d ?? t.duration_s });
    console.log(`💾 ${dest}${d ? `（${Math.round(d)}s）` : ""}`);
  }
  return files;
}

// ---------- 主流程 ----------
const provider = await import(`../providers/${providerName}.mjs`);
const onLog = (m) => console.log(`  ${m}`);
const started = Date.now();

try {
  let result;
  if (resumeJob) {
    if (providerName !== "useapi") die("--resume 目前仅支持 useapi 通道");
    console.log(`♻️ 重取 useapi job ${resumeJob}`);
    const r = await fetch(`https://api.useapi.net/v1/mureka/jobs/${encodeURIComponent(resumeJob)}`, {
      headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) die(`重取失败 HTTP ${r.status}`);
    const j = await r.json();
    if (j.status !== "completed") die(`job 状态 ${j.status}，未完成不能下载`);
    result = { task_id: resumeJob, tracks: (j.response?.songs ?? []).filter((s) => s.mp3_url).map((s) => ({ title: s.title, audio_url: s.mp3_url, cover_url: s.cover, duration_s: s.duration_milliseconds / 1000 })) };
  } else {
    result = await provider.generate({ model: channel, endpoint: channel.endpoint, params: buildParams(), apiKey, onLog });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = resolve(arg("out") || `music-output/${stamp}-${alias}`);
  const files = await downloadTracks(result.tracks, outDir);
  if (!files.length) die("没有成功下载的曲目");

  writeFileSync(join(outDir, "meta.json"), JSON.stringify({
    skill: "music-forge", provider: providerName, model_alias: alias, model_id: channel.model_id,
    task_id: result.task_id, requested: buildParams(), tracks: result.tracks, files, finished_at: new Date().toISOString(),
  }, null, 2));

  // ---------- 记账（ledger 一行一任务；计费口径见 models.json 各渠道 billing） ----------
  const entry = {
    ts: new Date().toISOString(), skill: "music-forge", provider: providerName,
    model: alias, model_id: channel.model_id, task_id: result.task_id ?? null,
    tracks: files.length, cost_credits: result.cost_credits ?? null,
    est_credits: result.cost_credits == null ? (channel.price_credits?.generate ?? null) : null,
    est_usd: providerName === "useapi" ? (channel.price?.per_song_usd_est ?? 0) * files.length : null,
    seconds: Math.round((Date.now() - started) / 1000),
    prompt: (prompt || lyrics || "").slice(0, 80), out_dir: outDir,
  };
  if (!existsSync(LOG) || !readFileSync(LOG, "utf8").endsWith("\n")) {
    if (existsSync(LOG)) { const c = readFileSync(LOG, "utf8"); writeFileSync(LOG, c.replace(/\n?$/, "\n")); }
  }
  const { appendFileSync } = await import("node:fs");
  appendFileSync(LOG, JSON.stringify(entry) + "\n");

  console.log(`\n✅ ${files.length} 首已就绪（${entry.seconds}s）→ ${outDir}`);
  console.log(`📒 记账：${providerName}/${alias}${entry.cost_credits ? ` · 实扣 ${entry.cost_credits} credits` : entry.est_credits ? ` · 估扣 ${entry.est_credits} credits（响应未带实扣）` : ""}${entry.est_usd ? ` · 估算 $${entry.est_usd.toFixed(3)}` : ""} · 报表：node ${join(HERE, "budget.mjs")}`);
} catch (e) {
  const msg = String(e?.message ?? e);
  die(/HTTP 401\b/.test(msg)
    ? `${msg}\n   鉴权被拒：确认 ${providerDef.auth_env} 环境变量或 ${providerDef.auth_file} 文件里的 key 有效且未过期`
    : msg);
}
