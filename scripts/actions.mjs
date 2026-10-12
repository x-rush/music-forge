#!/usr/bin/env node
// music-forge actions — acedata 四个高频 action 的统一入口（异步提交 + 轮询 + resume + 记账）
// 用法：
//   node actions.mjs extend --audio-id <id> --continue-at <秒> [--lyric <续写词txt>] [--style <标签>] [--title <t>]
//   node actions.mjs speed --audio-id <id> --multiplier 1.25 [--keep-pitch] [--title <t>]
//   node actions.mjs replace-section --audio-id <id> --lyric <全词txt> --section-prompt "<新段落描述>" --start <秒> --end <秒> [--mode full_song|candidates]
//   node actions.mjs sfx --sound "<音效描述>" [--type one-shot|loop] [--bpm N] [--key <key>]
//   全部支持 --resume <task_id>（中断恢复，只下载不重复扣费）与 --out <dir>
// 价格：adjust_speed 0.28 · sounds 0.112 · extend/replace_section 未公开（响应实扣优先）
// 零依赖，Node >= 18。账本：脚本旁 gen-log.jsonl。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { pollTask } from "../providers/acedata.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = dirname(HERE);
const REGISTRY = JSON.parse(readFileSync(join(SKILL, "models.json"), "utf8"));
const LOG = join(HERE, "gen-log.jsonl");
const BUDGET = join(HERE, "budget.json");

const die = (msg, code = 2) => { console.error(`❌ ${msg}`); process.exit(code); };
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const hasFlag = (name) => process.argv.includes(`--${name}`);
const safeName = (s, fallback) => { const n = String(s ?? fallback).replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60); return n || fallback; };
const readTxt = (p) => p ? readFileSync(resolve(p), "utf8") : undefined;

const EST_CREDITS = { extend: null, speed: 0.28, "replace-section": null, sfx: 0.112, upload: 0.06, "upload-enhanced": 1.87 };
const ACTIONS = ["extend", "speed", "replace-section", "sfx", "upload", "mp4", "any"];

if (process.argv.includes("--help") || !process.argv[2]) {
  console.log(`music-forge actions — acedata 高频操作（异步 + 轮询 + resume）

  extend            续写歌曲：--audio-id --continue-at <秒> [--lyric <txt>] [--style <标签>] [--title]
  speed             变速（keep_pitch 可不变调，0.28cr）：--audio-id --multiplier <0.25-4> [--keep-pitch] [--title]
  replace-section   段落替换（只改指定秒数范围，省 credits）：--audio-id --lyric <全词txt> --section-prompt "<新段落>" --start <秒> --end <秒> [--mode full_song]
  sfx               文本生成音效（0.112cr）：--sound "<描述>" [--type one-shot|loop] [--bpm N] [--key <key>]
  upload            上传外部音频拿 audio_id（standard 0.06cr 同步 / enhanced 1.87cr 异步，解锁 underpainting/overpainting/upload_extend）：--audio-url <公网地址> [--mode enhanced] [--name <名>]
  any               任意 acedata action 全参数透传：--action <名> --data '{字段:值,…}'（覆盖全量 action：cover/concat/remaster/mashup/samples/inspo/all_stems/add_stem/upload_extend/upload_cover/underpainting/overpainting/remaster/artist_consistency…）

通用：--resume <task_id>（中断恢复）· --out <dir> · 全部走异步提交 + 轮询`);
  process.exit(0);
}

const started = Date.now();
const action = process.argv[2];
if (!ACTIONS.includes(action)) die(`未知 action "${action}"，可选：${ACTIONS.join(" / ")}`);

// ---------- 鉴权（与 gen-music 同源） ----------
const prov = REGISTRY.providers.acedata;
const authEnvNames = Array.isArray(prov.auth_env) ? prov.auth_env : [prov.auth_env];
let apiKey = authEnvNames.map((n) => process.env[n]).find(Boolean);
if (!apiKey && prov.auth_file) {
  const p = join(SKILL, prov.auth_file);
  if (existsSync(p)) apiKey = readFileSync(p, "utf8").trim();
}
if (!apiKey) die(`缺少鉴权：设环境变量 ${authEnvNames.join(" 或 ")}，或写入 ${prov.auth_file}（已 gitignore）`);

// ---------- 预算门 ----------
{
  const conf = existsSync(BUDGET) ? JSON.parse(readFileSync(BUDGET, "utf8")) : null;
  if (conf?.monthly_credits) {
    const entries = existsSync(LOG) ? readFileSync(LOG, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e?.provider === "acedata") : [];
    const now = new Date();
    const used = entries.filter((e) => { const d = new Date(e.ts); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(); }).reduce((s, e) => s + (e.cost_credits ?? e.est_credits ?? 0), 0);
    if (used + (EST_CREDITS[action] ?? 0.6) > conf.monthly_credits) { console.error(`⛔ acedata 本月已用 ${used.toFixed(2)}/${conf.monthly_credits} credits——继续须用户明示同意`); process.exit(2); }
  }
}

// ---------- 组装各 action 的请求体 ----------
const resumeTask = arg("resume");
const audioId = arg("audio-id");
let body;
const title = arg("title") ?? `${action}-${new Date().toISOString().slice(5, 16)}`;
if (resumeTask) {
  body = null; // resume 只轮询
} else if (action === "mp4") {
  if (!audioId) die("mp4 需要 --audio-id");
  body = { action: "mp4", audio_id: audioId };
} else if (action === "upload") {
  // [live 2026-10-11] 响应形状特殊：data 是对象（含 audio_id），不是数组——独立分支处理
  const audioUrl = arg("audio-url") ?? die("upload 需要 --audio-url <公网音频CDN地址>");
  const mode = arg("mode") ?? "standard";
  const name = arg("name");
  if (mode === "enhanced" && !name) die("enhanced 模式需要 --name（1-100 字符）");
  body = { action: "upload", audio_url: audioUrl };
  if (mode === "enhanced") { body.mode = "enhanced"; body.name = name; }
  console.log(`📤 上传音频（${mode}）…`);
  const res = await fetch("https://api.acedata.cloud/suno/upload", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  if (!res.ok) die(`acedata HTTP ${res.status}\n${text.slice(0, 500)}`);
  let j;
  try { j = JSON.parse(text); } catch { die(`响应非 JSON: ${text.slice(0, 300)}`); }
  if (j.success === false) { const e = j.error || {}; die(`业务失败 [${e.code ?? "?"}] ${e.message ?? text.slice(0, 300)}`); }
  let rec = j.data ?? null;
  if (mode === "enhanced") {
    taskId = j.task_id ?? die(`enhanced 响应无 task_id: ${text.slice(0, 200)}`);
    console.log(`task_id=${taskId}，每 5s 轮询（enhanced 约需 2 分钟+）…`);
    for (;;) {
      await new Promise((r) => setTimeout(r, 5000));
      const rr = await fetch("https://api.acedata.cloud/suno/tasks", { method: "POST", headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ id: taskId }), signal: AbortSignal.timeout(20000) });
      const w = await rr.json();
      const inner = w.response ?? {};
      const d0 = Array.isArray(inner.data) ? inner.data[0] : null;
      if (d0?.audio_id) { rec = d0; break; }
      console.log("… 上传处理中");
    }
  }
  if (!rec?.audio_id) die(`上传响应无 audio_id: ${text.slice(0, 300)}`);
  const stampTs = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = resolve(arg("out") || `action-output/${stampTs}-upload`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "upload-result.json"), JSON.stringify({ audio_id: rec.audio_id, lyric: rec.lyric ?? null, style: rec.style ?? null, title: rec.title ?? null, duration: rec.duration ?? null }, null, 2));
  console.log(`✅ 上传完成 → audio_id=${rec.audio_id}`);
  console.log(`   （下游 upload_extend / upload_cover / underpainting / overpainting 用此 id；分析结果存 upload-result.json）`);
  if (existsSync(LOG) && !readFileSync(LOG, "utf8").endsWith("\n")) { const c = readFileSync(LOG, "utf8"); writeFileSync(LOG, c.replace(/\n?$/, "\n")); }
  const { appendFileSync } = await import("node:fs");
  appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), skill: "music-forge", purpose: "upload", provider: "acedata", model: "upload/" + mode, audio_id: rec.audio_id, cost_credits: null, est_credits: mode === "enhanced" ? 1.87 : 0.06, seconds: Math.round((Date.now() - started) / 1000), out_dir: outDir }) + "\n");
  process.exit(0);
} else if (action === "any") {
  const acedataAction = arg("action") ?? die("any 需要 --action <acedata_action_name>");
  const dataJson = arg("data") ?? die("any 需要 --data '{…}'（action 的全部业务字段，JSON 对象）");
  let fields;
  try { fields = JSON.parse(dataJson); } catch { die("--data 不是合法 JSON"); }
  body = { action: acedataAction, ...fields, async: true, title: arg("title") ?? acedataAction + "-" + new Date().toISOString().slice(5, 16) };
} else if (action === "extend") {
  if (!audioId) die("extend 需要 --audio-id");
  const cont = arg("continue-at") ? Number(arg("continue-at")) : die("extend 需要 --continue-at <秒>");
  body = { action: "extend", audio_id: audioId, continue_at: cont, async: true, title };
  if (arg("lyric")) body.lyric = readTxt(arg("lyric"));
  if (arg("style")) body.style = arg("style");
} else if (action === "speed") {
  if (!audioId) die("speed 需要 --audio-id");
  const mult = Number(arg("multiplier") ?? die("speed 需要 --multiplier <0.25-4>"));
  if (!(mult >= 0.25 && mult <= 4)) die("--multiplier 范围 0.25-4");
  body = { action: "adjust_speed", audio_id: audioId, speed_multiplier: mult, title, async: true };
  if (hasFlag("keep-pitch")) body.keep_pitch = true;
} else if (action === "replace-section") {
  if (!audioId) die("replace-section 需要 --audio-id");
  const fullLyric = readTxt(arg("lyric")) ?? die("replace-section 需要 --lyric <全词txt>（整首歌的词）");
  const sp = arg("section-prompt") ?? die("replace-section 需要 --section-prompt <新段落描述>");
  const start = Number(arg("start") ?? die("replace-section 需要 --start <秒>"));
  const end = Number(arg("end") ?? die("replace-section 需要 --end <秒>"));
  body = { action: "replace_section", audio_id: audioId, lyric: fullLyric, prompt: sp, replace_section_start: start, replace_section_end: end, replace_section_result_mode: arg("mode") ?? "full_song", model: REGISTRY.models[REGISTRY.default_model].model, async: true, title };
} else if (action === "sfx") {
  const sound = arg("sound") ?? die("sfx 需要 --sound <音效描述>");
  body = { action: "sounds", sound, sound_type: arg("type") ?? "one-shot", audio_format: "mp3", async: true, title };
  if (arg("bpm")) body.bpm = Number(arg("bpm"));
  if (arg("key")) body.key = arg("key");
}

// ---------- 提交 / 恢复 ----------
let taskId = resumeTask ?? null;
let final = null;
if (resumeTask) {
  console.log(`♻️ 重取 ${action} 任务 ${resumeTask}…`);
} else {
  console.log(`🎚️ ${action} 提交（异步）…`);
  const submitUrl = action === "mp4" ? "https://api.acedata.cloud/suno/mp4" : "https://api.acedata.cloud/suno/audios";
  const res = await fetch(submitUrl, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) die(`acedata HTTP ${res.status}\n${text.slice(0, 500)}`);
  let j;
  try { j = JSON.parse(text); } catch { die(`响应非 JSON: ${text.slice(0, 300)}`); }
  if (j.success === false) { const e = j.error || {}; die(`业务失败 [${e.code ?? "?"}] ${e.message ?? text.slice(0, 300)}`); }
  if (Array.isArray(j.data) && j.data.length) {
    final = j; // 服务端忽略 async 同步返回（防御式兼容）
  } else {
    if (!j.task_id) die(`异步响应无 task_id: ${text.slice(0, 300)}`);
    taskId = j.task_id;
    console.log(`task_id=${taskId}，每 5s 轮询…`);
  }
  // ---------- mp4 同步直出：响应自带 data.video_url，直接下载并退出 ----------
  if (action === "mp4") {
    const videoUrl = j?.data?.video_url ?? die(`mp4 响应无 video_url: ${text.slice(0, 200)}`);
    const mp4Out = resolve(arg("out") || `action-output/${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-mp4`);
    mkdirSync(mp4Out, { recursive: true });
    const mp4Dest = join(mp4Out, `${safeName(title)}.mp4`);
    const vr = await fetch(videoUrl, { signal: AbortSignal.timeout(120000) });
    if (!vr.ok) die(`mp4 下载失败 HTTP ${vr.status}`);
    writeFileSync(mp4Dest, Buffer.from(await vr.arrayBuffer()));
    console.log(`✅ mp4 就绪 → ${mp4Dest}`);
    console.log(`   video_url: ${videoUrl}`);
    if (existsSync(LOG) && !readFileSync(LOG, "utf8").endsWith("\n")) { const c = readFileSync(LOG, "utf8"); writeFileSync(LOG, c.replace(/\n?$/, "\n")); }
    const { appendFileSync } = await import("node:fs");
    appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), skill: "music-forge", purpose: "mp4", provider: "acedata", model: "mp4", audio_id: audioId, cost_credits: null, est_usd: null, seconds: Math.round((Date.now() - started) / 1000), out_dir: mp4Out }) + "\n");
    process.exit(0);
  }
}
// ---------- mp4 专用下载（响应形状不同：data.video_url） ----------
if (action === "mp4") {
  const videoUrl = final?.data?.video_url ?? die(`mp4 响应无 video_url: ${JSON.stringify(final).slice(0, 200)}`);
  const outDir = resolve(arg("out") || `action-output/${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-mp4`);
  mkdirSync(outDir, { recursive: true });
  const dest = join(outDir, `${safeName(title)}.mp4`);
  const r = await fetch(videoUrl, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) die(`mp4 下载失败 HTTP ${r.status}`);
  writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  console.log(`✅ mp4 就绪 → ${dest}`);
  console.log(`   video_url: ${videoUrl}`);
  if (existsSync(LOG) && !readFileSync(LOG, "utf8").endsWith("\n")) { const c = readFileSync(LOG, "utf8"); writeFileSync(LOG, c.replace(/\n?$/, "\n")); }
  const { appendFileSync } = await import("node:fs");
  appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), skill: "music-forge", purpose: "mp4", provider: "acedata", model: "mp4", audio_id: audioId, cost_credits: null, est_usd: null, seconds: Math.round((Date.now() - started) / 1000), out_dir: outDir }) + "\n");
  process.exit(0);
}

if (!final) final = await pollTask({ task_id: taskId, apiKey, onLog: (m) => console.log(m), timeoutMs: 600000 });

// ---------- 下载 ----------
const items = (Array.isArray(final.data) ? final.data : []).filter((t) => t.audio_url);
if (!items.length) die(`响应无可用音轨: ${JSON.stringify(final).slice(0, 300)}`);
const stampTs = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = resolve(arg("out") || `action-output/${stampTs}-${action}`);
mkdirSync(outDir, { recursive: true });
for (const [i, t] of items.entries()) {
  const dest = join(outDir, `${String(i + 1).padStart(2, "0")}-${safeName(t.title, action)}.mp3`);
  const r = await fetch(t.audio_url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) { console.error(`⚠️ 下载失败 HTTP ${r.status}: ${t.title ?? ""}`); continue; }
  writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  console.log(`💾 ${dest}`);
}

// ---------- 记账 ----------
const cost = final.data?.map((t) => t?.cost?.amount).find((v) => typeof v === "number") ?? null;
const entry = {
  ts: new Date().toISOString(), skill: "music-forge", purpose: "action", provider: "acedata",
  model: action, task_id: taskId ?? final.task_id ?? null, audio_id: audioId ?? null,
  cost_credits: cost, est_credits: !resumeTask && cost == null ? (EST_CREDITS[action] ?? null) : null,
  seconds: Math.round((Date.now() - started) / 1000), out_dir: outDir,
};
if (existsSync(LOG) && !readFileSync(LOG, "utf8").endsWith("\n")) {
  const c = readFileSync(LOG, "utf8"); writeFileSync(LOG, c.replace(/\n?$/, "\n"));
}
const { appendFileSync } = await import("node:fs");
appendFileSync(LOG, JSON.stringify(entry) + "\n");

console.log(`\n✅ ${action} 完成（${entry.seconds}s，${items.length} 个产物）→ ${outDir}`);
console.log(`📒 记账：${action}${cost ? ` · 实扣 ${cost} credits` : entry.est_credits ? ` · 估扣 ${entry.est_credits} credits` : " · 价格未公开（以平台账单为准）"}${resumeTask ? " · resume 不重复扣费" : ""}`);
