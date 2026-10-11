#!/usr/bin/env node
// music-forge stems — 音轨分离（acedata extract_stem：有词歌 → 纯伴奏 BGM 的正解）
// 用法：
//   node stems.mjs --audio-id <id> --type vocals
//   node stems.mjs --from <meta.json> --type vocals      # 从历史 meta.json 读 track id
// 常用 stem_type：vocals（取 "(Without Vocals)" 互补版 = 纯伴奏）；bass/drums 等以文档为准
// 成本：1.12 credits/次（响应 cost.amount 实扣入账）。audio_id 来源：meta.json tracks[].id
// 零依赖，Node >= 18。账本：脚本旁 gen-log.jsonl（与 gen-music 同账本）。

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
const safeName = (s, fallback) => { const n = String(s ?? fallback).replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60); return n || fallback; };

if (process.argv.includes("--help") || !process.argv[2]) {
  console.log(`music-forge stems — 音轨分离（acedata extract_stem，1.12 credits/次）

  --audio-id <id>     acedata 音轨 id（meta.json tracks[].id）
  --from <meta.json>  从历史生成的 meta.json 读第一条 track 的 id
  --type <stem_type>  分离目标（默认 vocals；bass/drums 等以文档为准）
  --resume <task_id>  重取分离任务（中断恢复，只下载不重复扣费）
  --out <dir>         输出目录（默认 ./stem-output/<时间戳>-<type>/）`);
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

// ---------- 预算门（acedata credits，与 gen-music 同语义） ----------
{
  const conf = existsSync(BUDGET) ? JSON.parse(readFileSync(BUDGET, "utf8")) : null;
  if (conf?.monthly_credits) {
    const entries = existsSync(LOG) ? readFileSync(LOG, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e?.provider === "acedata") : [];
    const now = new Date();
    const used = entries.filter((e) => { const d = new Date(e.ts); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(); }).reduce((s, e) => s + (e.cost_credits ?? e.est_credits ?? 0), 0);
    if (used + 1.12 > conf.monthly_credits) { console.error(`⛔ acedata 本月已用 ${used.toFixed(2)}/${conf.monthly_credits} credits，本次分离 1.12 会超——继续须用户明示同意`); process.exit(2); }
  }
}

// ---------- 定位 audio_id ----------
const resumeTask = arg("resume");
let audioId = arg("audio-id");
if (!audioId && arg("from")) {
  const meta = JSON.parse(readFileSync(resolve(arg("from")), "utf8"));
  audioId = meta.tracks?.[0]?.id;
  if (!audioId) die("该 meta.json 的 tracks 里没有 id（旧版本生成的留档）——用新生成的 meta 或直接 --audio-id");
  console.log(`从 meta 取 audio_id=${audioId}（${meta.tracks[0].title ?? "?"}）`);
}
if (!audioId && !resumeTask) die("缺 --audio-id / --from / --resume 之一");
const stemType = arg("type") ?? "vocals";

// ---------- 提交（异步拿 task_id → 轮询，约 1-2 分钟） ----------
const started = Date.now();
let final, taskId = resumeTask ?? null;
if (resumeTask) {
  console.log(`♻️ 重取分离任务 ${resumeTask}…`);
} else {
  console.log(`🎚️ 分离 ${stemType}（audio_id=${audioId}，异步）…`);
  const res = await fetch("https://api.acedata.cloud/suno/audios", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ action: "extract_stem", audio_id: audioId, stem_type: stemType, audio_format: "mp3", async: true }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) die(`acedata HTTP ${res.status}\n${text.slice(0, 500)}`);
  let j;
  try { j = JSON.parse(text); } catch { die(`响应非 JSON: ${text.slice(0, 300)}`); }
  if (j.success === false) { const e = j.error || {}; die(`业务失败 [${e.code ?? "?"}] ${e.message ?? text.slice(0, 300)}`); }
  if (Array.isArray(j.data) && j.data.length) {
    final = j; // 服务端忽略 async 同步返回成品（防御式兼容）
  } else {
    if (!j.task_id) die(`异步响应无 task_id: ${text.slice(0, 300)}`);
    taskId = j.task_id;
    console.log(`task_id=${taskId}，每 5s 轮询…`);
  }
}
if (!final) final = await pollTask({ task_id: taskId, apiKey, onLog: (m) => console.log(m), timeoutMs: 600000 });
const items = (Array.isArray(final.data) ? final.data : []).filter((t) => t.audio_url);
if (!items.length) die(`响应无可用音轨: ${JSON.stringify(final).slice(0, 300)}`);

// ---------- 下载（data[] 为 2 组候选 × 隔离轨+互补轨） ----------
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = resolve(arg("out") || `stem-output/${stamp}-${stemType}`);
mkdirSync(outDir, { recursive: true });
for (const [i, t] of items.entries()) {
  const dest = join(outDir, `${String(i + 1).padStart(2, "0")}-${safeName(t.title, "stem")}.mp3`);
  const r = await fetch(t.audio_url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) { console.error(`⚠️ 下载失败 HTTP ${r.status}: ${t.title ?? ""}`); continue; }
  writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  console.log(`💾 ${dest}（set${t.stem_set ?? "?"}）`);
}

// ---------- 记账（extract_stem 响应带实扣 cost.amount；resume 不重复扣费） ----------
const cost = final.data?.map((t) => t?.cost?.amount).find((v) => typeof v === "number") ?? null;
const entry = {
  ts: new Date().toISOString(), skill: "music-forge", purpose: "stems", provider: "acedata",
  model: `extract_stem/${stemType}`, task_id: taskId ?? final.task_id ?? null,
  cost_credits: cost, est_credits: !resumeTask && cost == null ? 1.12 : null,
  seconds: Math.round((Date.now() - started) / 1000), audio_id: audioId, out_dir: outDir,
};
if (existsSync(LOG) && !readFileSync(LOG, "utf8").endsWith("\n")) {
  const c = readFileSync(LOG, "utf8"); writeFileSync(LOG, c.replace(/\n?$/, "\n"));
}
const { appendFileSync } = await import("node:fs");
appendFileSync(LOG, JSON.stringify(entry) + "\n");
console.log(`\n✅ 分离完成（${entry.seconds}s）→ ${outDir}`);
console.log(`📒 记账：extract_stem/${stemType}${cost ? ` · 实扣 ${cost} credits` : " · 估扣 1.12 credits"} · 纯伴奏取 "(Instrumental)" 互补版（实测命名）`);
