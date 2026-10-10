# Lessons（每条都花了真金白银/踩了坑才进这里）

> 格式约定：`[docs]` 文档核对所得（动手前必读），`[live]` 真实调用验证所得。新教训往上加，带日期。

## 渠道与计费

- `[docs]` 两个渠道都是**第三方中转**：AceDataCloud 是 Suno 兼容转售，useapi 是挂你自己的 Mureka 订阅驱动。风控/调价/停服风险自担；key 永远不进仓库、不进日志、不进文档。
- `[docs]` Suno 中转同步模式一次连接等 1–2 分钟——提交前必须先告知用户等待时长，别让会话看起来像卡死。
- `[docs]` Mureka 一次生成回 **2 首**、按 2 首扣订阅额度。估算成本按 ×2 算。
- `[docs]` useapi job 只保留 7 天，mp3_url 是临时直链——生成完立即下载落盘，meta.json 存全量响应。

## 提示词与参数

- `[docs]` Suno `duration` 是倾向值不是硬上限；想要卡点配乐就用 `--instrumental` + 后期 ffmpeg 裁剪，别指望 duration 精确。
- `[docs]` Suno style 字段只放风格标签（逗号分隔），别放整句人话；歌词里结构标签写全（`[Verse]`/`[Chorus]`/`[Bridge]`/`[Outro]`）出歌结构才完整。
- `[docs]` 歌词超限（5000/3000 按模型）会直接报错——先删括号注释和重复段再发，不要自动截断（截断的歌没法听）。
- `[docs]` 中文歌走 `--lyrics-file`，中文音节密度高，同样的旋律中文词要短英文词 30% 左右（待实测校准此系数）。

## 工程工艺

- `[docs]` `--lyrics-file` 必须有：歌词进命令行会被引号/换行/反引号折腾坏，这是 image-forge 时代的老坑。
- `[docs]` useapi `music/create` 的字段名以文档页为准，provider 里已按 docs 写死 `prompt`/`lyrics`/`title`——**首次联调先发一发 422-probe 确认字段名再上量**，文档可能滞后。
- `[docs]` 预算双通道独立：acedata 按 credits 计、useapi 按订阅额度估算美元计，`budget.mjs` 两把尺子，超支 exit 2 与 image-forge 同语义。
- `[docs]` 下载校验双保险：文件 ≥50KB + ffprobe 时长；mp3 直链偶发残片，宁可让用户试听也别静默交付坏文件。
- `[live 2026-10-10]` acedata 错 key 实测：HTTP 401 + `error.code=invalid_token`，端点/Bearer 头格式确认无误；provider 抛出的异常不要裸崩——gen-music 主流程已包 try/catch，401 附 key 来源提示、统一 `❌` 文案 + exit 2（与预算门同语义）。
