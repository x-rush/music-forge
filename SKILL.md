---
name: music-forge
description: 多通道 AI 音乐生成引擎（Suno via AceDataCloud + Mureka via useapi.net）——完整人声歌曲、纯音乐 BGM、自定义歌词（中英文皆可）。当用户要求生成或创作音乐、歌曲、背景音乐、BGM、主题曲、片尾曲、jingle，或提到 音乐、配乐、背景音乐、写歌、生成歌曲、主题曲、片尾曲、歌词、伴奏、纯音乐、suno、mureka 时使用——即使没有说"生成"。需要 ACEDATA_SUNO_API_KEY（platform.acedata.cloud）或 USEAPI_TOKEN（useapi.net，驱动自有 Mureka 订阅）；零依赖，Node ≥ 18（ffprobe 可选，用于时长校验）。模型路由、端点、参数枚举与定价集中在一个 JSON 注册表——加模型=改配置，不改代码。
---

# music-forge — 多通道音乐生成引擎

通过可插拔渠道（AceDataCloud Suno 中转、useapi.net Mureka 中转）生成完整歌曲与纯音乐 BGM——零依赖 Node CLI。模型路由、端点、参数枚举与定价集中在一个 JSON 注册表——**加模型=改配置，不改代码**。

**密钥配置**：设置渠道鉴权环境变量（AceDataCloud 用 `ACEDATA_SUNO_API_KEY`，或 `USEAPI_TOKEN`——token 文件替代方案见 `models.json` providers 段）。**密钥绝不写入任何文件、提交、文档或日志。**

单一入口：宿主项目创建薄包装，把参数转发给本 skill 的 `scripts/`——绝不复制实现。

触发时系统会提供 Base 目录（下文记作 `<skill>`）：

- `<skill>/scripts/gen-music.js` — 生成 CLI（异步提交 → 轮询 → 下载 → 记账；支持 `--resume` 中断恢复）
- `<skill>/scripts/actions.js` — 高频四连（extend 续写 / speed 变速不变调 / replace-section 段落替换 / sfx 音效），统一异步+轮询+resume
- `<skill>/scripts/stems.js` — 音轨分离（extract_stem：有词歌 → 人声轨 + 纯伴奏 BGM，1.12 credits；支持 `--resume`）
- `<skill>/scripts/actions.js` — 高频四连（extend / speed 变速不变调 / replace-section / sfx 音效）+ upload 上传外部音频（解锁 underpainting 哼唱配伴奏等）+ `any`（/suno/audios 21 个 action 全参数透传）+ `api`（15 个 /suno/* 端点全量透传：歌词/混搭词/persona/voices/vox/style/wav/mp3/midi/custom-models…）；any/api 均逐键 schema 守门（`reference/endpoint-schemas.json`），支持 `--dry-run` 预检
- `<skill>/scripts/timing.js` — 歌词词级时间轴对齐（/suno/timing：音频 + 官方歌词 → aligned_words + LRC，免费）
- `<skill>/scripts/budget.js` — 花费报表 + 双通道月度预算控制
- `<skill>/providers/` — 渠道实现（acedata = 异步提交 + 任务轮询；useapi = 提交 + 轮询）
- `<skill>/models.json` — 模型注册表：别名、端点、参数枚举、价格
- `<skill>/reference/` — 端点契约（含全部 action 目录）、提示词指南与经验教训

## 快速开始

```bash
GEN=<skill>/scripts/gen-music.js

# 纯音乐 BGM（Suno 灵感模式——最省的完整路径）
node $GEN --model suno-v6 --prompt "轻快的城市流行，适合咖啡馆背景" --instrumental --out bgm/

# 完整人声歌曲（Suno custom 模式，用户给词）
node $GEN --model suno-v6 --lyrics-file lyrics.txt --title "歌名" --style "mandopop, 清亮女声" --voice f

# Mureka 走自有订阅（每次回 2 首，约 45 秒）
node $GEN --model mureka-v95 --prompt "lofi hip hop, rainy night" --instrumental

# 中断恢复（凭任务 id 只下载不重复扣费）
node $GEN --resume <task_id> --model suno-v6

# 花费 / 预算
node <skill>/scripts/budget.js --check
```

每次成功生成都会追加到 `scripts/gen-log.jsonl`（全局账本）。

## 工作流

1. **预算检查**：每次会话首次生成前先 `budget.js --check`。
2. **确认意图**（用户已说清则跳过）：① 有词歌还是纯音乐 ② 语言与曲风 ③ 时长 ④ 用途（BGM 循环 / 主题曲成品）。Suno 异步模式立即回任务 id——先告知用户再提交。
3. **模型选择**：人声成品、中英歌词 → `suno-v6`；控成本/草稿 → `suno-v6-mini`；控成本走自有订阅 → `mureka-v95`；纯音乐 BGM → `--instrumental`（Suno 或 Mureka 均可）。
4. **歌词路由**（三条路按用户输入选）:
   - **用户给词** → 直接 custom 模式：`--lyrics-file 词.txt --style "<标签>" [--title]`
   - **用户给灵感、要先看词再谱曲** → agent 起草：按 `reference/prompting.md` 的歌词工作流（结构标签 + 中文音节密度）写词 → **给用户确认/修改后**再 custom 模式出歌，别跳过确认直接生成
   - **用户给灵感、想直接听** → 灵感模式一把出（Suno 自动写词）；自动词在 `meta.json` 的 `tracks[].lyrics` 里——用户想改词就改完走 custom 模式重跑
5. **歌词纪律**：遵循 `reference/prompting.md` — style 标签体系、结构标签、参数调优手册（weirdness / style_influence / variety / max_mode 已 CLI 化）。歌词用 `--lyrics-file` 传入（免 shell 转义），结构标签写全（`[Verse]`/`[Chorus]`/`[Bridge]`），中文注意音节与断句；`--style` 只放风格标签不放整句。
6. **一次生成 → 校验（文件大小 + ffprobe 时长）→ 交付，让用户试听再迭代。** 每次迭代 = 一次提交 + 一次试听反馈，不要连环重生成。
7. **后期动作决策**（actions.js）：歌短视频长 → extend 续写；节奏不合 → speed 变速(keep_pitch)；某段词要改 → replace-section（比整首重生成省 credits）；缺音效 → sfx；其余 action（cover/mashup/remaster…）→ any 透传；**分离伴奏用 stems，词级时间轴用 timing**。
8. **MV/歌词视频**：`timing.js` 出词级时间轴（LRC）+ `stems.js` 出纯伴奏，配 video-forge 的画面与 `assemble --srt`。

## 关键规则

阅读 `reference/lessons.md` — 以下契约事实核对于 2026-10-10，实测条目已标注：

- Suno `duration` 是倾向值不是硬上限；一次任务常回 2 个候选，下载后都要交给用户挑。
- Suno 歌词上限 5000 字符（v4.5+）、style 1000、title 100——超限先删括号注释再发。
- `--style` 不与 custom 模式同用时会被并入 prompt；要精确风格控制就配歌词走 custom。
- useapi 一次生成回 2 首且按 2 首扣订阅额度；job 只保留 7 天，下载前别关机。
- 两个渠道都是第三方中转（非官方直连 API），存在调价/风控风险——key 各自自备，不进仓库。
- 全通道异步化（2026-10-10）：提交即回任务 id，任何中断 `--resume <task_id>` 零成本重取。

## 注册表与扩展

`models.json` 保存全部模型（渠道、端点、参数枚举、价格）。加模型：读渠道文档 → 用一个最小请求探测端点 → 加一条 JSON → 跑一次冒烟生成。加渠道：复制 `providers/_interface.js` 契约，实现 `generate()`，在 `models.json` 注册 `auth_env` / `auth_file`。

## 边界

- 仅用于内容生产——不要把密钥或渠道调用接进交付的产品代码。
- 商用发布注意 Suno/Mureka 各自的商用授权条款；中转渠道产出与官方订阅权益可能不同。
- 配视频用：本 skill 只出音频；画面生成与音画合成属于 video-forge（另行安装）。
