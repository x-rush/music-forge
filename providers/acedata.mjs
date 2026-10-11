#!/usr/bin/env node
/**
 * AceDataCloud provider — Suno 兼容中转，异步提交 + 轮询（2026-10-10 统一异步化）
 *
 * 契约要点（2026-10-10 实测）：
 *  - 提交 POST /suno/audios，body 加 async:true → 立即回 { task_id }（不再长挂 1-2 分钟；
 *    服务端若忽略 async 同步返回成品，防御式兼容）
 *  - 轮询 POST /suno/tasks，body { task_id } —— 文档未写的查询端点（探测发现 2026-10-10）：
 *      200 {} （空对象）= 进行中/未知，防御式按 pending 处理
 *      完成时返回与同步同构的 { success, task_id, data: [...] }
 *    轮询瞬时错误重试 3 次；结果保留时长文档未注明——出活立即下载
 *  - [live] 错 key → 401 invalid_token；余额不足 → 403 used_up（error.code/message 解析）
 *  - [live] 响应不含 cost.amount——账本走 est_credits 兜底（0.56/action 口径）
 *  - 鉴权 Header: Authorization: "Bearer <token>"（平台统一 token，非 Suno 官方 key）
 */
const BASE = "https://api.acedata.cloud";
const safeJson = (t) => { try { return JSON.parse(t); } catch { return null; } };

// 任务轮询（generate/resume/stems 共用）：POST /suno/tasks，body { id: task_id }
// [live 2026-10-10] 响应为任务包装：{ type:"audios", response:{ success, task_id, data:[...] }, finished_at }
//   response.data 为空/无 audio_url = 未就绪（pending）；全部 error = 失败；有 audio_url = 完成
//   同步兼容形状（{success,task_id,data} 无 response 键）直接透传
export async function pollTask({ task_id, apiKey, onLog = () => {}, timeoutMs = 600000 }) {
  const deadline = Date.now() + timeoutMs;
  let wrapped = {};
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    let j = null;
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await fetch(`${BASE}/suno/tasks`, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ id: task_id }),
          signal: AbortSignal.timeout(20000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
        j = await r.json();
        break;
      } catch (e) {
        if (attempt >= 3) throw new Error(`轮询连续失败 3 次：${e.message}（task_id=${task_id}，稍后 --resume ${task_id} 重取）`);
        onLog(`⚠️ 轮询瞬时错误（${attempt}/3）: ${e.message}，5s 后重试`);
        await new Promise((r2) => setTimeout(r2, 5000));
      }
    }
    wrapped = (j && typeof j === 'object' && 'response' in j && !('data' in j)) ? (j.response ?? {}) : (j ?? {});
    if (wrapped.success === false) {
      const e = wrapped.error || {};
      throw new Error(`acedata 任务失败 [${e.code ?? '?'}] ${e.message ?? JSON.stringify(wrapped).slice(0, 200)}`);
    }
    const data = Array.isArray(wrapped.data) ? wrapped.data : [];
    const ok = data.filter((t) => t.audio_url);
    if (ok.length) return wrapped;
    const errs = data.filter((t) => t.state === 'error');
    // [live 2026-10-10] data 可能短暂全部 error（服务端内部重试），以包装层 finished_at 为终态判据
    const terminal = j && typeof j === 'object' && !Array.isArray(j) && j.finished_at != null;
    if (data.length && errs.length === data.length && terminal) {
      throw new Error(`acedata 任务失败: ${JSON.stringify(errs[0]).slice(0, 300)}`);
    }
    onLog(`… ${data.length ? data.map((t) => t.state).join(',') : 'pending'}${!terminal && errs.length ? '（瞬时 error，等待服务端）' : ''}`);
  }
  throw new Error(`轮询超时（${Math.round(timeoutMs / 1000)}s）：task_id=${task_id} 可稍后 --resume ${task_id} 重取`);
}

function parseTracks(j, onLog = () => {}) {
  const data = Array.isArray(j.data) ? j.data : [];
  const pending = data.filter((t) => t.state && t.state !== 'succeeded');
  const tracks = data
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
  if (!tracks.length) throw new Error(`acedata 全部曲目未完成（state=${data.map((t) => t.state).join(',')}）task_id=${j.task_id ?? '?'}`);
  if (pending.length) onLog(`⚠️ ${pending.length} 首未完成被跳过`);
  const cost = data.map((t) => t?.cost?.amount).find((v) => typeof v === 'number');
  return { tracks, cost_credits: cost, task_id: j.task_id };
}

export async function generate({ model, endpoint, params, apiKey, onLog = () => {}, timeoutMs = 600000 }) {
  const payload = { action: 'generate', model: model.model_id, ...params, async: true };

  onLog(`acedata 提交 ${endpoint}（${model.model_id}，异步模式）…`);
  const res = await fetch(`${BASE}/${endpoint}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`acedata HTTP ${res.status}\n${text.slice(0, 800)}`);
  const j = safeJson(text);
  if (!j) throw new Error(`acedata 响应非 JSON: ${text.slice(0, 300)}`);
  if (j.success === false) {
    const e = j.error || {};
    throw new Error(`acedata 业务失败 [${e.code ?? '?'}] ${e.message ?? text.slice(0, 300)}`);
  }

  let final = j;
  if (!j.task_id && Array.isArray(j.data) && j.data.length) {
    onLog('⚠️ 服务端忽略 async 同步返回成品（防御式兼容）');
  } else {
    if (!j.task_id) throw new Error(`acedata 异步响应无 task_id: ${text.slice(0, 300)}`);
    onLog(`task_id=${j.task_id}，每 5s 轮询…`);
    final = await pollTask({ task_id: j.task_id, apiKey, onLog, timeoutMs });
  }
  const { tracks, cost_credits, task_id } = parseTracks(final, onLog);
  return { task_id, tracks, cost_credits };
}

// 中断恢复：凭 task_id 重取（结果保留时长文档未注明，尽早取）
export async function resume({ task_id, apiKey, onLog = () => {}, timeoutMs = 600000 }) {
  onLog(`♻️ 重取 acedata task ${task_id}`);
  const final = await pollTask({ task_id, apiKey, onLog, timeoutMs });
  return parseTracks(final, onLog);
}
