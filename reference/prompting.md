# 提示词工程与参数选型（music-forge）

> 写歌前先读本文件。状态：`[live]` 实测、`[docs]` 官方文档与社区经验。
> 全参数契约见 endpoints.md 的请求体表；本文件管"怎么写"和"参数怎么配"。

## 两种模式（先选对模式，事半功倍）

| | 灵感模式 | custom 模式 |
|---|---|---|
| CLI | `--prompt "<描述>"` | `--lyrics-file 歌词.txt --style "<标签>" --title "<歌名>"` |
| 适合 | BGM / 快速小样 / 没想好词 | 成品歌 / 有词 / 要精确风格 |
| 机制 | Suno 自动写词起名编曲 | 你给词，Suno 按标签编曲演唱 |
| 成本 | 0.56 credits | 0.56（max_mode 1.12） |

灵感模式 prompt 写法：**风格 + 情绪 + 用途/编曲**一句话（≤500 字符）。
例："轻快的城市流行，咖啡馆背景音乐，钢琴加轻打击乐" / "epic cinematic trailer, hybrid orchestra, rising tension"。

## style 字段（custom 模式的灵魂）

**逗号分隔标签，别写整句人话**。标签维度自由组合：

```
[流派], [情绪], [人声], [节奏/速度], [年代], [制作/编曲]
```

例：`mandopop, 清亮女声, mid-tempo, 2020s, clean production`
例：`epic orchestral, heroic male choir, slow build, cinematic`

- 英文标签最稳，中文风格词可混用（"国风"、"戏腔" Suno 认）
- 要人声明确写（female vocal / male rap / 合唱）；纯音乐配合 `--instrumental`
- 上限 1000 字符（v4.5+/v6），够写 20+ 个标签，但 10 个内最有效

## 歌词结构标签（lyric 字段的骨架）

```
[Intro] [Verse] [Pre-Chorus] [Chorus] [Bridge] [Drop]
[Instrumental Break] [Spoken Word] [Outro] [End]
```

- 结构标签写全，出歌结构才完整（lessons 实录）
- 和声/伴唱用括号：`(oh oh)`；念白用 `[Spoken Word]`；纯音乐段 `[Instrumental Break]`
- **中文词音节密度比英文高约 30%**：同样旋律中文词要短三成，先删括号注释再发（超 5000 字符直接报错）
- 一段 Verse 4-8 行、Chorus 4 行最稳；写太长 Suno 会自行取舍

## 参数调优手册

| 参数 | 范围 | 什么时候调 |
|---|---|---|
| `--instrumental` | 开关 | BGM/伴奏必开；有词歌别开 |
| `--voice f` / `m` | 二选一 | v4.5+ 生效；指定人声性别 |
| `--duration` | 10-360 | **倾向值非硬上限**（实测 92-156s 浮动）：BGM 循环给 60-90，完整歌曲给 180+，想卡点用 ffmpeg 后期裁 |
| `--negative-tags` | 逗号标签 | 排除元素："heavy metal, distorted guitar"；反向排风格最可靠 |
| `weirdness` | 0-1 | 越高越实验。BGM 0.2-0.4 · 主流成品 0.4-0.6 · 先锋实验 0.7+ |
| `style_influence` | 0-1 | style 标签遵循度。要贴标签 0.6+；给了自由度 0.3-0.5 |
| `variety` | off→max | 两次生成的差异度。挑歌场景 high；复现某次结果 off + 同 seed 思路 |
| `max_mode` | 开关 | v4.5+/v6 增强档：更长（约 8min）、结构更完整，**1.12 credits**（普通 0.56） |

高级四参 CLI 直达：`--weirdness 0.3 --style-influence 0.7 --variety high --max-mode`
（也可 `--advanced-json` 原样合并，逃生口不变）

## 模型选择

- **suno-v6**：成品首选，官方推荐；中英文咬字、style 跟随度最高
- **suno-v6-mini**：草稿/试方向，同价同参数面；v6-mini 出的小样满意再用 v6 重跑正式版
- 每次任务回 **2 个候选**，都要交给用户挑；迭代节奏 = 一次提交 + 一次反馈，别连环重生成

## 歌词起草工作流（用户给灵感、要先看词再谱曲）

流程：**灵感 → agent 起草 → 用户确认/修改 → custom 模式出歌**。确认那一步不能省——词是用户要唱/要交付的内容，跳过确认直接生成 = 赌运气烧 credits。

Agent 代笔规则（起草时逐条对照）：

1. **先从灵感提取四要素**：主题/故事（写什么）、视角（我/你/他）、情绪弧线（起→承→转→合）、曲风（决定段落节奏）
2. **结构默认模板**：`[Verse 1]`（铺陈，4-8 行）→ `[Pre-Chorus]`（可选，2 行推情绪）→ `[Chorus]`（hook，4 行，重复性强）→ `[Verse 2]`（推进）→ `[Chorus]` → `[Bridge]`（转折/升华，可选）→ `[Chorus]` → `[Outro]`
3. **Hook 先行**：先写副歌第一句（全曲记忆点），再倒推主歌；副歌要能重复三次不腻
4. **中文音节纪律**：每行 8-12 字为主（对应 4-6 个音符组），同段落行宽均匀；比英文词短 30% 是总原则
5. **意象具体、口语顺耳**：能唱出来的词（开口音收尾利于长音），别写书面语；押韵宽松（隔行押或换韵），硬押伤句
6. **给 Suno 留表演提示**：括号和声 `(哦~)`、`[Spoken Word]` 念白段、需要留白处 `[Instrumental Break]`
7. 交用户确认时**附结构说明**（哪段是 hook、情绪怎么走的），用户改词只改内容不动结构标签

另一条路：**灵感模式直接出歌**（Suno 自动写词，0.56 credits 听曲风），自动词落在 `meta.json` 的 `tracks[].lyrics`——用户喜欢曲子但想改词，改完走 custom 模式重跑（曲风由 style 标签锚定，歌词替换不影响编曲大方向）。

## 常用配方

```bash
# 咖啡馆 BGM（纯音乐循环，最常用）
node gen-music.mjs --model suno-v6 --prompt "轻快爵士，钢琴主导，咖啡馆背景" --instrumental --duration 90

# 成品歌（custom 全流程）
node gen-music.mjs --model suno-v6 --lyrics-file song.txt --title "歌名" \
  --style "mandopop, 清亮女声, mid-tempo" --voice f --duration 210 --style-influence 0.7

# 草稿试方向（mini + 高多样性）
node gen-music.mjs --model suno-v6-mini --prompt "国风电子，戏腔女声" --variety high
```
