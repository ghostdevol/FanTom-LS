# GhostTech FanTom-LS

GM LS PCM performance tuner. Same ghost, new haunt.

FanTom-LS is a Tauri desktop app (HTML/CSS/JS frontend + Rust backend) that
drives **PCM Hammer**'s CLI to read, edit, and flash GM Gen III PCMs
(P01 "0411", P59, and friends), using **XDF** definition files for tables —
the same architecture as the Nissan/Infiniti [FanTom](https://github.com/ghostdevol/GhostTechFanTom),
re-targeted at GM.

## Layout

- `frontend/` — the app UI (copied from FanTom, re-skinned for GM)
- `src-tauri/` — Rust backend; Tauri commands bridge to `PcmHammerCLI`
- `tools/` *(not in repo)* — `PcmHammerCLI` binaries + XDF definitions live
  here on the USB stick / dev machine, never committed (license hygiene:
  PCM Hammer ships with no declared license, Universal Patcher is GPL-3.0)

## Bridge

Tauri command names match FanTom exactly so the frontend ports over:

| Command | PCM Hammer CLI |
|---|---|
| `dump_rom` | `--read <file>` |
| `flash_rom` | `--test-write` (dry run, default) / `--write` (confirm `"y"`) |
| `verify_rom` | `--verify <file>` |
| `identify_pcm` | `--identify-pcm` (VIN, OSID, cal, serial) |
| `nisprog_raw` | console passthrough, one CLI invocation per line |
| `read_file_bin` / `read_table` / `write_table` | ROM file I/O (little-endian default) |
| `load_definitions` | loads `*.xdf` / `*.xml` via `XDFDEFINITIONS_PATH` |

## Dev

```powershell
$env:PCMHAMMER_PATH="C:\path\to\PcmHammerCLI.exe"
$env:XDFDEFINITIONS_PATH="C:\path\to\xdf"
cargo tauri dev
```

Portable USB layout mirrors FanTom: `FanTom-LS USB.bat` sets the env vars
to relative paths and launches `fantom-ls.exe`.
