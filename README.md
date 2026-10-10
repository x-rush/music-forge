# music-forge

Multi-channel AI music generation engine for AI coding agents — full songs with
vocals, instrumental BGM, custom lyrics (zh/en). Same family as
[image-forge](https://github.com/x-rush/image-forge): model routing, endpoints,
parameter enums and pricing live in one JSON registry — **adding a model is
configuration, not code**. Zero dependencies beyond Node >= 18.

| Channel | Models | Auth | Billing | Status |
|---|---|---|---|---|
| AceDataCloud (Suno relay) | `suno-v6`, `suno-v6-mini` | `ACEDATA_SUNO_API_KEY` | platform credits (~0.56/generate) | docs-verified, smoke pending |
| useapi.net (own Mureka plan) | `mureka-v95`, `mureka-o2` | `USEAPI_TOKEN` | your Mureka plan quota (Pro $9/mo ≈ 500 songs) | docs-verified, smoke pending |

> Both channels are **third-party relays**, not official vendor APIs: AceDataCloud
> resells Suno-compatible access; useapi.net drives **your own** Mureka
> subscription ($15/mo useapi fee separate). Pricing or availability may change —
> bring your own keys, at your own risk.

## Install

Clone into your agent skills directory (or install via your tool's skill mechanism):

```bash
git clone https://github.com/x-rush/music-forge.git ~/.agents/skills/music-forge
```

Set one channel's key as an env var (or use the gitignored token-file alternatives
listed in `models.json`):

```bash
export ACEDATA_SUNO_API_KEY=...   # from platform.acedata.cloud (legacy name ACEDATA_API_KEY also accepted)
export USEAPI_TOKEN=...      # from useapi.net, format user:<id>-<string>
```

## Usage

```bash
GEN=~/.agents/skills/music-forge/scripts/gen-music.mjs

# Instrumental BGM (Suno, inspiration mode; sync, ~1-2 min)
node $GEN --model suno-v6 --prompt "轻快的城市流行，适合咖啡馆背景" --instrumental --out bgm/

# Full song, custom lyrics (Suno custom mode)
node $GEN --model suno-v6 --lyrics-file lyrics.txt --title "歌名" --style "mandopop, 清亮女声" --voice f

# Mureka via your own subscription (2 songs per job, ~45s)
node $GEN --model mureka-v95 --prompt "lofi hip hop, rainy night" --instrumental

# Re-fetch a useapi job (7-day retention)
node $GEN --resume <jobid> --provider useapi --model mureka-v95

# Spend report / monthly budget (dual-channel, independent caps)
node ~/.agents/skills/music-forge/scripts/budget.mjs --check
node ~/.agents/skills/music-forge/scripts/budget.mjs --set 10 --set-credits 40
```

Every successful generation appends to `scripts/gen-log.jsonl` (global ledger,
gitignored). Output lands in `./music-output/<timestamp>-<model>/NN-title.mp3`
plus `meta.json` with the full task payload.

## Extending

- **Add a model**: read the channel docs → probe the endpoint with one minimal
  request → add an entry to `models.json` → one smoke generation. No code changes.
- **Add a channel**: copy the contract documented in `providers/_interface.mjs`,
  implement `generate()`, register `auth_env` / `auth_file` in `models.json`.

## License

MIT. Keys, generated audio and spend logs stay on your machine.
