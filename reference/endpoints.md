# 端点契约备忘（整理自两边官方文档，2026-10-10）

> 状态标记：`[docs]` = 文档核对未实测；`[live]` = 真实调用验证过。实测后把本文件对应条目升级并写日期。

## AceDataCloud · Suno 兼容中转 [docs]

- 端点：`POST https://api.acedata.cloud/suno/audios`（单端点，`action` 区分操作）
- 鉴权：`Authorization: Bearer <平台token>` + `accept: application/json` + `content-type: application/json`
- 平台控制台：https://platform.acedata.cloud （一个 token 调全部 50+ 服务）
- 文档：https://docs.acedata.cloud/zh-Hans/guides/suno/suno_audios

### generate 请求体（v1 用到的子集）
| 字段 | 说明 |
|---|---|
| `action` | 固定 `"generate"` |
| `model` | `chirp-v6` / `chirp-v6-wild` / `chirp-v6-mini` / `chirp-v5-5` / `chirp-v5` / `chirp-v4-5-plus` / `chirp-v4-5` / `chirp-v4` / `chirp-v3-5` |
| `prompt` | 灵感模式描述（与 custom 二选一），≤500 字符 |
| `custom` + `lyric` | 自定义模式：custom=true 时必带 lyric；歌词 ≤5000（v4.5+）/ ≤3000（v4 及以下） |
| `title` | ≤100（v4.5+）/ 80（旧） |
| `style` | 风格标签 ≤1000（v4.5+）/ ≤200（旧） |
| `instrumental` | bool |
| `negative_tags` | 反向风格标签 |
| `vocal_gender` | `"f"` / `"m"`（4.5+） |
| `duration` | 10–360 整数，倾向值非硬约束 |
| `weirdness` / `style_influence` | 0–1 |
| `variety` | off / normal / high / extra / max |
| `max_mode` | 增强档（需 custom=true），计费 1.12 credits |

> 渠道全枚举如上（旧模型 v4.5/v4/v3.5 的歌词/style 上限更低）。**注册表（models.json）只单列 `chirp-v6`（suno-v6）与 `chirp-v6-mini`（suno-v6-mini）**，2026-10-10 用户决定不收 suno-v45；要用旧枚举往 models.json 加一行即可。计费按 action 与模型无关：generate 0.56 / max_mode 1.12 credits。

### 响应
```json
{ "success": true, "task_id": "…", "data": [{ "id", "title", "image_url",
  "lyric", "audio_url", "video_url", "model", "state", "duration", "cost": {"amount": 0.6048} }] }
```
- `state` ∈ `succeeded / pending / running / error`
- [live 2026-10-10] 同步 generate 响应实测**不含 `cost.amount`**（文档写了但没返回）——账本走 `est_credits` 兜底（0.56/action）
- 错误路 [live 2026-10-10]：错 key → HTTP 401，body `{ "error": { "message": "The token is invalid, please make sure your token is correct.", "code": "invalid_token" }, "trace_id": "…" }`；余额不足 → HTTP 403 `{"error":{"message":"Your balance is not sufficient…","code":"used_up"}}`——均与 `success:false` 业务失败同构，provider 按 `error.code/message` 解析两条路都覆盖；Bearer 头格式与端点可达性已确认
- 同步模式：不传 `async`/`callback_url`，连接保持约 1–2 分钟直接返回成品
- 异步/回调/NDJSON 流式为服务端集成预留，CLI v1 不用
- 计费：generate ≈0.56 credits（普通）/ 1.12（max_mode）；`cost.amount` 为折后实扣

## useapi.net · Mureka（自有订阅） [docs]

> ⚠️ 渠道归属：Mureka 只走本渠道（useapi.net），与 AceDataCloud（仅 Suno）完全隔离。
> 按 2026-10-10 决定处于休眠：代码/文档在，未订阅前不会被调用。

- Base：`https://api.useapi.net/v1/mureka`
- 鉴权：`Authorization: Bearer user:<id>-<串>`（完整 token，勿截断/URL 编码）
- 文档：https://useapi.net/docs/api-mureka-v1 · LLM 规范：https://useapi.net/assets/aibot/api-mureka-v1.txt
- 模型枚举：`V9.5`（默认）/ `V9` / `V8` / `O2` / `V7.6` / `V7.5`

### 提交
- `POST /music/create`（带词歌：`prompt`? `lyrics`? `title`?）
- `POST /music/create-instrumental`（纯音乐：`prompt` 为主）
- `POST /music/create-advanced`（上传参考轨/旋律动机等，v1 未接）
- 固定 `async: true` → 响应 `{ jobid }`；平均 ~45s，**每次回 2 首**
- 扩展端点（v1 未接）：extend / regenerate / edit / lyrics-generate（免费）/ stems / video-generate / speech（语音克隆）

### 轮询
- `GET /jobs/{jobid}` → `{ status: "created"|"completed"|"failed", response: { songs: [{ song_id, title, duration_milliseconds, mp3_url, cover }] } }`
- failed 时带 `error` / `errorDetails` / `code`；job 保留 7 天后 404
- 每账号并发上限 10；`GET /jobs` 列运行中任务

### 计费
- 消耗自有 Mureka 套餐：Pro $9/月 ≈500 首；Premier $27/月 ≈2000 首（≈1.35–1.8¢/首）
- useapi 自身订阅 $15/月另计（全 API 通用，每服务可绑 3 账号）
- 无公开余额 API，余量看 https://www.mureka.ai 后台

## 冒烟测试清单
1. ✅ [live 2026-10-10] acedata `--model suno-v6 --prompt "轻快测试曲" --instrumental` → 2 首《纸飞机起飞》92s/122s，76s 同步返回，账本落行（est_credits 兜底）
1b. ✅ [live 2026-10-10] acedata `--model suno-v6-mini` 同参 → 2 首 156s/137s，72s 返回；API 面与 v6 无差异，质量对比待人工试听
2. useapi（休眠）：`--model mureka-v95 --prompt <短描述>` → 期望 jobid→completed→2 首下载（订阅开通后）
3. ✅ [live 2026-10-10] 异常路：错 key 401 invalid_token / 余额 403 used_up 文案均干净（❌ + exit 2）；`--resume` 待 useapi 实测
