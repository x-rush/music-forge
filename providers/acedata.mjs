#!/usr/bin/env node
/**
 * AceDataCloud provider — Suno 兼容中转，同步 REST
 *
 * 契约要点（docs.acedata.cloud 2026-10-10 版文档核对）：
 *  - 单端点 POST https://api.acedata.cloud/suno/audios，action 区分操作；v1 只用 action=generate
 *  - 同步模式：不传 async/callback，连接保持约 1-2 分钟后直接返回成品 data[]
 *  - 鉴权 Header: Authorization: "Bearer <token>"（平台统一 token，非 Suno 官方 key）
 *  - 响应 { success, task_id?, data: [{ id, title, image_url, lyric, audio_url, model, state, duration }] }
 *    state ∈ succeeded / pending / running / error；同步返回应全部 succeeded
 *  - [live 2026-10-10] 同步 generate 响应实测**不含 cost.amount**（文档写了但没返回）——
 *    账本走 gen-music 的 est_credits 兜底（0.56/action 口径）
 *  - [live 2026-10-10] 余额不足：HTTP 403 {"error":{"code":"used_up"}}；错 key：401 invalid_token
 */
export async function generate({ model, endpoint, params, apiKey, onLog = () => {}, timeoutMs = 360000 }) {
  const payload = { action: 'generate', model: model.model_id, ...params };

  onLog(`acedata 提交 ${endpoint}（${model.model_id}）… 同步等待约 1-2 分钟`);
  const res = await fetch(`https://api.acedata.cloud/${endpoint}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`acedata HTTP ${res.status}\n${text.slice(0, 800)}`);

  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`acedata 响应非 JSON: ${text.slice(0, 300)}`); }
  if (j.success === false) {
    const e = j.error || {};
    throw new Error(`acedata 业务失败 [${e.code ?? '?'}] ${e.message ?? text.slice(0, 300)}`);
  }
  if (!Array.isArray(j.data) || !j.data.length) {
    throw new Error(`acedata 响应无 data: ${text.slice(0, 300)}`);
  }

  const pending = j.data.filter((t) => t.state && t.state !== 'succeeded');
  const tracks = j.data
    .filter((t) => t.audio_url)
    .map((t) => ({
      id: t.id,
      title: t.title || 'untitled',
      audio_url: t.audio_url,
      cover_url: t.image_url,
      lyrics: t.lyric,
      duration_s: Number.isFinite(t.duration) ? t.duration : undefined,
      state: t.state,
    }));
  if (!tracks.length) {
    throw new Error(`acedata 全部曲目未完成（state=${j.data.map((t) => t.state).join(',')}）task_id=${j.task_id ?? '?'}`);
  }
  if (pending.length) onLog(`⚠️ ${pending.length} 首未完成被跳过（同步模式不应出现，请回报）`);

  const cost = j.data.map((t) => t?.cost?.amount).find((v) => typeof v === 'number');
  return { task_id: j.task_id, tracks, cost_credits: cost };
}
