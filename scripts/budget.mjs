#!/usr/bin/env node
// music-forge 预算工具 — 汇总 gen-log.jsonl 账本，双通道独立月预算
// 用法：
//   node budget.mjs              # 报表：今日/本月/累计（credits 与 useapi 估算美元分列）
//   node budget.mjs --set 10     # useapi 通道月预算 $10（写 budget.json）
//   node budget.mjs --set-credits 40   # acedata 通道月预算 40 credits
//   node budget.mjs --check      # 单行结论（供 agent 会话内快速检查）
// 零依赖，Node >= 18。两个中转渠道均无公开余额 API，真实余量以平台后台为准：
//   acedata → https://platform.acedata.cloud   useapi/Mureka → https://www.mureka.ai

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG = join(HERE, "gen-log.jsonl");
const CONF = join(HERE, "budget.json");

function loadEntries() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8")
    .split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.skill === "music-forge");
}
function loadBudget() {
  if (!existsSync(CONF)) return null;
  try { return JSON.parse(readFileSync(CONF, "utf8")); } catch { return null; }
}
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const sameMonth = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();

const args = process.argv.slice(2);
if (args[0] === "--set") {
  const v = Number(args[1]);
  if (!Number.isFinite(v) || v <= 0) { console.error("用法: budget.mjs --set <正数月预算美元>"); process.exit(1); }
  const cur = loadBudget() ?? {};
  writeFileSync(CONF, JSON.stringify({ ...cur, monthly_usd: v, set_at: new Date().toISOString() }, null, 2));
  console.log(`✅ useapi 通道月预算已设为 $${v}`);
  process.exit(0);
}
if (args[0] === "--set-credits") {
  const v = Number(args[1]);
  if (!Number.isFinite(v) || v <= 0) { console.error("用法: budget.mjs --set-credits <正数 credits>"); process.exit(1); }
  const cur = loadBudget() ?? {};
  writeFileSync(CONF, JSON.stringify({ ...cur, monthly_credits: v, set_at: new Date().toISOString() }, null, 2));
  console.log(`✅ acedata 通道月预算已设为 ${v} credits`);
  process.exit(0);
}

const now = new Date();
const all = loadEntries();
const today = all.filter((e) => sameDay(new Date(e.ts), now));
const month = all.filter((e) => sameMonth(new Date(e.ts), now));
const credits = (arr) => arr.filter((e) => e.provider === "acedata").reduce((s, e) => s + (e.cost_credits ?? 0), 0);
const usdEst = (arr) => arr.filter((e) => e.provider === "useapi").reduce((s, e) => s + (e.est_usd ?? 0), 0);
const budget = loadBudget();

if (args[0] === "--check") {
  const parts = [`本月 ${credits(month).toFixed(2)}cr + $${usdEst(month).toFixed(3)}（${month.length} 单）`];
  if (budget?.monthly_credits) parts.push(`acedata ${credits(month).toFixed(1)}/${budget.monthly_credits}cr`);
  if (budget?.monthly_usd) parts.push(`useapi $${usdEst(month).toFixed(2)}/${budget.monthly_usd}`);
  const overC = budget?.monthly_credits && credits(month) >= budget.monthly_credits;
  const overU = budget?.monthly_usd && usdEst(month) >= budget.monthly_usd;
  console.log(`[预算] ${parts.join(" · ")}`);
  process.exit(overC || overU ? 2 : 0);
}

console.log("══ music-forge 生成预算报表 ══");
console.log(`今日    ：${credits(today).toFixed(2)} credits + $${usdEst(today).toFixed(3)}（${today.length} 单）`);
console.log(`本月    ：${credits(month).toFixed(2)} credits + $${usdEst(month).toFixed(3)}（${month.length} 单）`);
console.log(`累计    ：${credits(all).toFixed(2)} credits + $${usdEst(all).toFixed(3)}（${all.length} 单）`);
const byModel = {};
for (const e of month) (byModel[`${e.provider}/${e.model}`] ??= { n: 0, cr: 0, usd: 0 }), byModel[`${e.provider}/${e.model}`].n++, byModel[`${e.provider}/${e.model}`].cr += e.cost_credits ?? 0, byModel[`${e.provider}/${e.model}`].usd += e.est_usd ?? 0;
if (Object.keys(byModel).length) {
  console.log("本月明细：");
  for (const [m, v] of Object.entries(byModel)) console.log(`  ${m.padEnd(16)} ${String(v.n).padStart(3)} 单  ${v.cr ? `${v.cr.toFixed(2)}cr` : ""} ${v.usd ? `$${v.usd.toFixed(3)}` : ""}`);
}
if (budget?.monthly_credits || budget?.monthly_usd) {
  if (budget.monthly_credits) {
    const pct = (credits(month) / budget.monthly_credits) * 100;
    console.log(`acedata 月预算：${credits(month).toFixed(1)}/${budget.monthly_credits} credits（${pct.toFixed(0)}%）`);
    if (pct >= 100) console.log("[BLOCKED:BUDGET] ⛔ acedata 已超支：继续生成须用户明示同意");
    else if (pct >= 80) console.log("⚠️ acedata 已用 ≥80%：生成前提醒余量");
  }
  if (budget.monthly_usd) {
    const pct = (usdEst(month) / budget.monthly_usd) * 100;
    console.log(`useapi 月预算：$${usdEst(month).toFixed(2)}/$${budget.monthly_usd}（${pct.toFixed(0)}%，估算口径）`);
    if (pct >= 100) console.log("⛔ useapi 已达月预算：继续生成须用户明示同意");
  }
} else {
  console.log("月预算：未设置（--set <美元> / --set-credits <credits> 可设置，两通道独立）");
}
console.log("真实余量以平台后台为准：acedata → platform.acedata.cloud · Mureka → mureka.ai");
