---
name: music-forge
description: Multi-channel AI music generation engine (Suno via AceDataCloud + Mureka via useapi.net) — full songs with vocals, instrumental BGM, custom lyrics, zh/en lyric rendering. Use whenever the user asks to generate or write music, a song, background music, BGM, theme/ending music, jingle, or mentions 音乐, 配乐, 背景音乐, 写歌, 生成歌曲, 主题曲, 片尾曲, 歌词, 伴奏, 纯音乐, suno, mureka — even without saying "generate". Requires ACEDATA_SUNO_API_KEY (platform.acedata.cloud) or USEAPI_TOKEN (useapi.net, drives your own Mureka plan); zero dependencies beyond Node >= 18 (ffprobe optional for duration checks). Model routing, endpoints, parameter enums and pricing live in one JSON registry — adding a model is configuration, not code.
---

# music-forge — Multi-Channel Music Generation Engine

Generate full songs and instrumental BGM through pluggable channels (AceDataCloud
Suno relay, useapi.net Mureka relay) using a zero-dependency Node CLI. Model routing,
endpoints, parameter enums and pricing live in one JSON registry — **adding a model
is configuration, not code**.

**Key setup**: set the channel's auth (`ACEDATA_SUNO_API_KEY` for AceDataCloud, or
`USEAPI_TOKEN` for useapi.net — token-file alternatives in `models.json` providers
section). **Never write keys to any file, commit, document, or log.**

Single entry point: host projects create thin wrappers that forward arguments to
this skill's `scripts/` — never copy the implementation.

When triggered, the system provides a Base directory (referenced as `<skill>` below):

- `<skill>/scripts/gen-music.mjs` — generate CLI (submit → wait → download → ledger)
- `<skill>/scripts/budget.mjs` — spend report + dual-channel monthly budget control
- `<skill>/providers/` — channel implementations (acedata = sync REST; useapi = submit + poll)
- `<skill>/models.json` — model registry: aliases, endpoints, parameter enums, prices
- `<skill>/reference/` — endpoint contracts, prompting guide and lessons

## Quick Start

```bash
GEN=<skill>/scripts/gen-music.mjs

# Instrumental BGM (Suno, inspiration mode — cheapest full path)
node $GEN --model suno-v6 --prompt "轻快的城市流行，适合咖啡馆背景" --instrumental --out bgm/

# Full song with custom lyrics (Suno custom mode)
node $GEN --model suno-v6 --lyrics-file lyrics.txt --title "歌名" --style "mandopop, 清亮女声" --voice f

# Mureka via your own subscription (2 songs per job, ~45s)
node $GEN --model mureka-v95 --prompt "lofi hip hop, rainy night" --instrumental

# Re-fetch a useapi job (7-day retention) and download only
node $GEN --resume <jobid> --provider useapi --model mureka-v95

# Spend / budget
node <skill>/scripts/budget.mjs --check
```

Every successful generation appends to `scripts/gen-log.jsonl` (global ledger).

## Workflow

1. **Budget check**: `budget.mjs --check` before the first generation of a session.
2. **Confirm intent** (skip if user already stated all four): ① 有词歌还是纯音乐 ② 语言与曲风 ③ 时长 ④ 用途（BGM 循环 / 主题曲成品）。Suno 同步要等 1–2 分钟、Mureka 约 45 秒——先告知用户再提交。
3. **Model selection**: 人声成品、中英歌词 → `suno-v6`；控成本走自有订阅 → `mureka-v95`；纯音乐 BGM → `--instrumental`（Suno 或 Mureka 均可）。
4. **Lyrics discipline**: follow `reference/prompting.md` — style 标签体系、结构标签、参数调优手册（weirdness / style_influence / variety / max_mode 已 CLI 化）。歌词用 `--lyrics-file` 传入（免 shell 转义），结构标签写全（`[Verse]`/`[Chorus]`/`[Bridge]`），中文注意音节与断句；`--style` 只放风格标签不放整句。
5. **Generate once → validate（文件大小 + ffprobe 时长）→ 交付，让用户试听再迭代。** 每次迭代 = 一次提交 + 一次试听反馈，不要连环重生成。

## Critical Rules

Read `reference/lessons.md` — contract facts below are docs-verified 2026-10-10, live entries marked as such:

- Suno `duration` 是倾向值不是硬上限；一次任务常回 2 个候选，下载后都要交给用户挑。
- Suno 歌词上限 5000 字符（v4.5+）、style 1000、title 100——超限先删括号注释再发。
- `--style` 不与 custom 模式同用时会被并入 prompt；要精确风格控制就配歌词走 custom。
- useapi 一次生成回 2 首且按 2 首扣订阅额度；job 只保留 7 天，下载前别关机。
- 两个渠道都是第三方中转（非官方直连 API），存在调价/风控风险——key 各自自备，不进仓库。

## Registry & Extending

`models.json` holds all models with channel, endpoints, parameter enums, and prices.
To add a model: read the channel's docs page → probe the endpoint with one minimal
request → add a JSON entry → run one smoke generation. To add a channel: copy the
`providers/_interface.mjs` contract, implement `generate()`, register `auth_env` /
`auth_file` in `models.json`.

## Boundaries

- Content-production tool only — do not wire keys or channel calls into shipped product code.
- 商用发布注意 Suno/Mureka 各自的商用授权条款；中转渠道产出与官方订阅权益可能不同。
- 配视频用：本 skill 只出音频；画面生成与音画合成属于 video-forge（另行安装）。
