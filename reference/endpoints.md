# 端点契约备忘（整理自两边官方文档，2026-10-10）；**2026-10-10 acedata 统一异步化（async:true + /suno/tasks 轮询）**

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

### action 全目录（2026-10-10 文档核对，v1 只接 generate + extract_stem）

generate · extend · upload_extend · cover · upload_cover · concat · replace_section · **stems**（人声+伴奏二分）· **all_stems**（多轨全分）· **add_stem**（1.344/0.672）· **extract_stem**（1.12，[live] 已接）· sounds（0.112）· adjust_speed（0.28）· underpainting / overpainting（上传清唱/伴奏加轨）· remaster（v4.5+/v5）· mashup · samples · inspo · artist_consistency(_vox)

- `extract_stem` 契约 [live]：`{ action, audio_id, stem_type, audio_format:"mp3" }` → `data[]` 为 2 组候选 ×（隔离轨+互补轨），互补轨命名 `(Instrumental)`；`cost.amount` 实测也未返回（est 1.12 兜底）；audio_id 来源 = generate 响应 `data[].id`（provider 已透传至 meta.json tracks[].id）
- 其余 action 未接入：按 stems.mjs 的模式复制即可（同端点同鉴权，改 action 与参数）

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
- **timing（词级时间轴对齐）[live 2026-10-10，小拾/MV 场景贡献]**：`POST /suno/timing`，body `{ audio_id, lyric }`，同步 <30s 返回 `{ success, data: { aligned_words: [{ word, success, start_s, end_s, p_align }] } }`——word 含结构标签和换行，免费（无 cost）。CLI：`scripts/timing.mjs`（输出 timing.json + 行级 LRC）。已知坑：间奏被吞进句尾 end_s；旧 meta 无 id 时从 audio_url 提取 UUID 兜底（异步任务查询的 data[] 也可能无 id）
- 计费：generate ≈0.56 credits（普通）/ 1.12（max_mode）；`cost.amount` 为折后实扣

## acedata 异步任务查询 [live 2026-10-10]

- 提交：generate/extract_stem 请求体加 `async: true` → 立即回 `{ task_id }`（服务端忽略 async 时同步返回成品，防御式兼容）
- 查询：`POST https://api.acedata.cloud/suno/tasks`，body `{ "id": "<task_id>" }` → 任务包装 `{ type, response: { success, task_id, data: [...] }, finished_at }`
- 未就绪 = response.data 为空或无 audio_url；全部 error = 失败；**响应不带 cost.amount，账本走 est 兜底**
- 结果保留时长文档未注明——出活立即下载
- [live] 探测史：假 id 返回 200 {}（勿误判端点不存在）；task_id 字段名/GET/{task_id}/action:query 均无效，唯一正确 body 键是 `id`

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
1c. ✅ [live 2026-10-10] custom 模式（用户给词）：`--lyrics-file --title --style` → 2 首《开往春天的慢车》116s/110s；返回词保留全部关键句与结构标签（custom=true 路径验证）；歌词三路工作流见 SKILL.md Workflow #4
1d. ✅ [live 2026-10-10] extract_stem 分离：`stems.mjs --from meta.json --type vocals` → 2 组候选 ×(Vocals)+(Instrumental) 各 123s 与源一致；有词歌→纯伴奏 BGM 通路打通
2. useapi（休眠）：`--model mureka-v95 --prompt <短描述>` → 期望 jobid→completed→2 首下载（订阅开通后）
3. ✅ [live 2026-10-10] 异常路：401/403 文案干净（❌ + exit 2）；**async 提交 + /suno/tasks 轮询 + --resume 全链实测**（孤儿任务 038f1be2 挽回 2 首《跳跳测试曲》）；useapi resume 待订阅
