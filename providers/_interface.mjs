#!/usr/bin/env node
/**
 * Provider 接口约定（music-forge 内部文档）
 *
 * 每个 provider 文件必须导出一个 async 函数：
 *
 *   generate({ model, endpoint, params, apiKey, onLog, timeoutMs }) →
 *     { task_id, tracks: [{ title, audio_url, cover_url?, lyrics?, duration_s?, state }], cost_credits? }
 *
 * 参数：
 *   model     — models.json 里该模型的 availability[channel] 段（含 model_id）
 *   endpoint  — 注册表解析后的端点路径（如 "suno/audios"、"music/create"）
 *   params    — 已按注册表枚举校验过的业务参数（provider 只管通道协议，不管语义）
 *   apiKey    — gen-music.mjs 从 auth_env / auth_file 读好传入
 *   onLog(msg) — 进度日志回调（提交、轮询状态等）
 *
 * 返回：
 *   task_id    — 渠道侧任务/作业 ID（useapi 为 jobid；acedata 同步模式可能为空）
 *   tracks     — 成品曲目数组，audio_url 必填（下载/落盘由 gen-music.mjs 统一处理）
 *   cost_credits — 渠道实扣积分（有则填，记账由 gen-music.mjs 统一写账本）
 *
 * 错误：失败时 throw Error（gen-music.mjs 统一捕获、打印、exit 2）。
 * 计费：provider 不记账——gen-music.mjs 按 models.json 单价 + 响应实扣统一写 gen-log.jsonl。
 *
 * 新增 provider：复制本文件头注释作为契约，实现 generate()，在 models.json providers 段登记
 * auth_env / auth_file / base_url。
 */
export const PROVIDER_CONTRACT = true;
