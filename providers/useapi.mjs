#!/usr/bin/env node
/**
 * useapi.net provider — 驱动自有 Mureka 订阅，提交 + 轮询
 *
 * 契约要点（useapi.net/docs/api-mureka-v1 2026-10-10 版文档核对）：
 *  - Base: https://api.useapi.net/v1/mureka
 *  - 纯音乐走 music/create-instrumental，带词歌曲走 music/create；固定 async:true 拿 jobid
 *  - 鉴权 Header: Authorization: "Bearer <user:<id>-<串>>"，完整 token 勿截断
 *  - 轮询 GET /jobs/{jobid}：status ∈ created/completed/failed；completed 后
 *    response.songs[] 每首含 song_id/title/duration_milliseconds/mp3_url/cover
 *  - 生成平均 ~45s，每次回 2 首；job 保留 7 天；每账号并发 ≤10
 *  - ⚠️ music/create 请求字段以文档页为准（prompt/lyrics/title）；首次联调建议先
 *    422-probe 校字段名再上量（image-forge 同款工艺）
 */
const POLL_INTERVAL_MS = 10000;
const POLL_MAX_MS = 15 * 60 * 1000;

export async function generate({ model, endpoint, params, apiKey, onLog = () => {}, timeoutMs = POLL_MAX_MS }) {
  const base = 'https://api.useapi.net/v1/mureka';
  const target = params.instrumental && model.instrumental_endpoint ? model.instrumental_endpoint : endpoint;
  const body = { model: model.model_id, async: true, ...params };
  delete body.instrumental; // 语义已由端点路由表达，避免脏字段

  onLog(`useapi 提交 ${target}（${model.model_id}）`);
  const submit = await fetch(`${base}/${target}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const submitText = await submit.text();
  if (!submit.ok) throw new Error(`useapi 提交 HTTP ${submit.status}\n${submitText.slice(0, 800)}`);
  const submitted = JSON.parse(submitText);
  const jobid = submitted.jobid;
  if (!jobid) throw new Error(`useapi 提交响应无 jobid: ${submitText.slice(0, 300)}`);
  onLog(`jobid=${jobid}，每 ${POLL_INTERVAL_MS / 1000}s 轮询（平均 ~45s，两首一起回）`);

  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const r = await fetch(`${base}/jobs/${encodeURIComponent(jobid)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 404) throw new Error(`job 已过期或不存在（useapi 仅保留 7 天）：${jobid}`);
    if (!r.ok) throw new Error(`useapi 轮询 HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    last = await r.json();
    if (last.status === 'completed') break;
    if (last.status === 'failed') {
      throw new Error(`useapi 任务失败 [${last.code ?? '?'}] ${JSON.stringify(last.errorDetails ?? last.error ?? {}).slice(0, 500)}`);
    }
    onLog(`… ${last.status}`);
  }
  if (!last || last.status !== 'completed') throw new Error(`轮询超时（${timeoutMs / 1000}s）：jobid=${jobid} 可稍后 --resume ${jobid} 重取`);

  const songs = last?.response?.songs ?? [];
  const tracks = songs
    .filter((s) => s.mp3_url)
    .map((s) => ({
      title: s.title || 'untitled',
      audio_url: s.mp3_url,
      cover_url: s.cover,
      lyrics: s.lyrics,
      duration_s: Number.isFinite(s.duration_milliseconds) ? s.duration_milliseconds / 1000 : undefined,
      state: 'succeeded',
    }));
  if (!tracks.length) throw new Error(`useapi 任务完成但无 mp3_url: ${JSON.stringify(last.response).slice(0, 400)}`);
  return { task_id: jobid, tracks };
}
