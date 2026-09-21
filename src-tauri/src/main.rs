#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! GhostTech FanTom-LS — Tauri backend.
//!
//! PCM Hammer's `PcmHammerCLI` is a ONE-SHOT CLI (unlike nisprog's
//! interactive shell), so each operation maps to a single CLI invocation:
//!
//!   dump_rom   -> pcmhammer-cli --read <file>
//!   flash_rom  -> pcmhammer-cli --test-write <file>   (dry run, DEFAULT)
//!              -> pcmhammer-cli --write <file>        (only with confirm "y")
//!   verify_rom -> pcmhammer-cli --verify <file>
//!   identify   -> pcmhammer-cli --identify-pcm        (VIN, OSID, cal, serial)
//!
//! Tauri command NAMES are identical to FanTom so the copied frontend works
//! unchanged. Differences from the Nissan backend:
//! - GM calibration data is little-endian (P01/P59); read_table/write_table
//!   default to little instead of big.
//! - Definitions are XDF files (*.xdf, plus *.xml); env var XDFDEFINITIONS_PATH.
//! - Bridge binary lookup: PCMHAMMER_PATH env -> sidecar PcmHammerCLI.exe
//!   next to the app -> system PATH.

use std::path::PathBuf;
use std::process::{Command, Stdio};

/// Locate PcmHammerCLI(.exe):
///   1. PCMHAMMER_PATH env var (dev override / USB launcher)
///   2. sidecar next to the app binary (PcmHammerCLI.exe beside fantom-ls.exe)
///   3. PATH fallback
fn pcmh_path() -> PathBuf {
    if let Ok(p) = std::env::var("PCMHAMMER_PATH") {
        return PathBuf::from(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in ["PcmHammerCLI.exe", "PcmHammerCLI"] {
                let sidecar = dir.join(name);
                if sidecar.exists() {
                    return sidecar;
                }
            }
            // Release zips name it pcmhammer-cli.exe (spelling varies) —
            // accept any *hammer*cli*.exe next to the app.
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let n = entry.file_name().to_string_lossy().to_lowercase();
                    if n.ends_with(".exe") && n.contains("hammer") && n.contains("cli") {
                        return entry.path();
                    }
                }
            }
        }
    }
    if cfg!(windows) {
        PathBuf::from("PcmHammerCLI.exe")
    } else {
        PathBuf::from("PcmHammerCLI")
    }
}

/// Run one pcmhammer-cli invocation and return combined output.
/// Dumps/writes can take minutes; blocks until it exits — do NOT kill mid-write.
fn run_pcmh(args: &[String]) -> Result<String, String> {
    let exe = pcmh_path();
    let mut cmd = Command::new(&exe);
    // cwd = CLI's own folder so it finds its Kernel-*.bin / Loader-*.bin
    // next to the exe (its documented default kernel-dir).
    if let Some(dir) = exe.parent().filter(|p| !p.as_os_str().is_empty()) {
        cmd.current_dir(dir);
    }
    let out = cmd
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("failed to launch PcmHammerCLI ({}): {e}", exe.display()))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    if out.status.success() {
        Ok(stdout)
    } else {
        Err(format!(
            "PcmHammerCLI exited with status {}\n--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}",
            out.status
        ))
    }
}

fn device_args(device: &Option<String>) -> Vec<String> {
    match device {
        Some(d) if !d.trim().is_empty() => vec!["--device".to_string(), d.trim().to_string()],
        _ => vec![], // auto-select when a single device is connected
    }
}

/// Dump the PCM ROM to a .bin file: `pcmhammer-cli --read <file>`.
#[tauri::command]
fn dump_rom(
    out_file: Option<String>,
    device: Option<String>,
    force_pcm: Option<String>,
) -> Result<String, String> {
    let abs_out: PathBuf = match out_file {
        Some(f) => std::env::current_dir()
            .map(|d| d.join(&f))
            .unwrap_or_else(|_| PathBuf::from(&f)),
        None => std::env::temp_dir().join("fantomls_dump.bin"),
    };
    let abs_out_s = abs_out.to_string_lossy().to_string();
    let mut args = vec!["--read".to_string(), abs_out_s.clone()];
    args.extend(device_args(&device));
    if let Some(p) = force_pcm.filter(|s| !s.trim().is_empty()) {
        args.push("--force-pcm".to_string());
        args.push(p);
    }
    let stdout = run_pcmh(&args)?;
    if !abs_out.exists() {
        return Err(format!(
            "read produced no file at {abs_out_s}; PcmHammerCLI said:\n{stdout}"
        ));
    }
    Ok(format!("DUMP_OK path={abs_out_s}\n{stdout}"))
}

/// Flash a (possibly edited) ROM .bin back to the PCM.
/// DEFAULT is `--test-write` (dry run — verifies without permanent changes).
/// Pass confirm "y" for the real `--write`. DO NOT pass "y" unless you are
/// on a bench/spare PCM with stable power and a verified backup. Not live-safe.
#[tauri::command]
fn flash_rom(
    rom_file: String,
    device: Option<String>,
    force_pcm: Option<String>,
    confirm: Option<String>,
) -> Result<String, String> {
    let live = confirm.as_deref().unwrap_or("p") == "y";
    let op = if live { "--write" } else { "--test-write" };
    let mut args = vec![op.to_string(), rom_file];
    args.extend(device_args(&device));
    if let Some(p) = force_pcm.filter(|s| !s.trim().is_empty()) {
        args.push("--force-pcm".to_string());
        args.push(p);
    }
    let mode = if live { "LIVE WRITE" } else { "dry run (test-write)" };
    let stdout = run_pcmh(&args)?;
    Ok(format!("FLASH_OK mode={mode}\n{stdout}"))
}

/// CRC-compare a ROM file against the PCM (no erase/write).
#[tauri::command]
fn verify_rom(rom_file: String, device: Option<String>) -> Result<String, String> {
    let mut args = vec!["--verify".to_string(), rom_file];
    args.extend(device_args(&device));
    run_pcmh(&args)
}

/// Read VIN, OSID, calibration, serial, voltage from the PCM.
#[tauri::command]
fn identify_pcm(device: Option<String>) -> Result<String, String> {
    let mut args = vec!["--identify-pcm".to_string()];
    args.extend(device_args(&device));
    run_pcmh(&args)
}

/// Read a binary file (e.g. a dumped ROM) into the frontend as bytes.
#[tauri::command]
fn read_file_bin(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("failed to read {path}: {e}"))
}

/// Parse a hex address string ("1A2B3C" or "0x1A2B3C") to a file offset.
/// XDF addresses are direct byte offsets into the ROM dump.
fn parse_hex_addr(s: &str) -> Result<u64, String> {
    let h = s.trim().trim_start_matches("0x").trim_start_matches("0X");
    u64::from_str_radix(h, 16).map_err(|e| format!("bad hex address '{s}': {e}"))
}

/// Read a calibration table's raw values straight from a ROM file.
/// Same shape as FanTom's read_table, but GM P01/P59 calibration data is
/// LITTLE-endian, so the default differs. Returns row-major values.
#[tauri::command]
fn read_table(
    rom_path: String,
    address: String,
    storagetype: String,
    size_x: u32,
    size_y: u32,
    endian: Option<String>,
) -> Result<Vec<u32>, String> {
    let addr = parse_hex_addr(&address)?;
    let big = endian.as_deref().unwrap_or("little").eq_ignore_ascii_case("big");
    let elem = match storagetype.to_lowercase().as_str() {
        "uint16" => 2u64,
        _ => 1u64, // uint8 default
    };
    let nx = size_x.max(1) as u64;
    let ny = size_y.max(1) as u64;
    let count = nx * ny;
    let need = addr + count * elem;

    let bytes =
        std::fs::read(&rom_path).map_err(|e| format!("failed to read {rom_path}: {e}"))?;
    if need > bytes.len() as u64 {
        return Err(format!(
            "table at 0x{addr:X} ({} bytes) runs past end of ROM ({} bytes)",
            count * elem,
            bytes.len()
        ));
    }

    let mut out = Vec::with_capacity(count as usize);
    for i in 0..count {
        let a = (addr + i * elem) as usize;
        let v = if elem == 1 {
            bytes[a] as u32
        } else if big {
            ((bytes[a] as u32) << 8) | bytes[a + 1] as u32
        } else {
            (bytes[a] as u32) | ((bytes[a + 1] as u32) << 8)
        };
        out.push(v);
    }
    Ok(out)
}

/// Write raw calibration values back into a ROM file at the table's address.
/// Inverse of `read_table` — same offset/endianness rules. The caller is
/// responsible for checksums; use `flash_rom` to write to the PCM.
#[tauri::command]
fn write_table(
    rom_path: String,
    address: String,
    storagetype: String,
    endian: Option<String>,
    values: Vec<u32>,
) -> Result<String, String> {
    let addr = parse_hex_addr(&address)?;
    let big = endian.as_deref().unwrap_or("little").eq_ignore_ascii_case("big");
    let elem = match storagetype.to_lowercase().as_str() {
        "uint16" => 2u64,
        _ => 1u64,
    };
    let need = addr + values.len() as u64 * elem;

    let mut bytes =
        std::fs::read(&rom_path).map_err(|e| format!("failed to read {rom_path}: {e}"))?;
    if need > bytes.len() as u64 {
        return Err(format!(
            "write at 0x{addr:X} ({} bytes) runs past end of ROM ({} bytes)",
            values.len() as u64 * elem,
            bytes.len()
        ));
    }

    for (i, &v) in values.iter().enumerate() {
        let a = (addr + i as u64 * elem) as usize;
        if elem == 1 {
            bytes[a] = (v & 0xFF) as u8;
        } else if big {
            bytes[a] = ((v >> 8) & 0xFF) as u8;
            bytes[a + 1] = (v & 0xFF) as u8;
        } else {
            bytes[a] = (v & 0xFF) as u8;
            bytes[a + 1] = ((v >> 8) & 0xFF) as u8;
        }
    }
    std::fs::write(&rom_path, &bytes).map_err(|e| format!("failed to write {rom_path}: {e}"))?;
    Ok(format!(
        "wrote {} value(s) at 0x{addr:X} in {rom_path}",
        values.len()
    ))
}

/// Escape hatch: run PcmHammerCLI operations from the dashboard console.
/// Each line is one CLI invocation's arguments (whitespace-split), e.g.
/// `--identify-pcm` or `--list-devices`. Powers the console box.
#[tauri::command]
fn nisprog_raw(script: String) -> Result<String, String> {
    let mut combined = String::new();
    for line in script.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let args: Vec<String> = line.split_whitespace().map(|s| s.to_string()).collect();
        let out = run_pcmh(&args)?;
        combined.push_str(&format!("$ pcmhammer-cli {line}\n{out}\n"));
    }
    Ok(combined)
}

/// One definition file's raw XDF/XML, handed to the frontend for registration.
#[derive(serde::Serialize)]
struct DefFile {
    name: String,
    xml: String,
}

/// Read every *.xdf / *.xml under `dir` (recursive). `dir` falls back to
/// XDFDEFINITIONS_PATH — same env-var pattern as PCMHAMMER_PATH.
#[tauri::command]
fn load_definitions(dir: Option<String>) -> Result<Vec<DefFile>, String> {
    let dir = match dir {
        Some(d) if !d.trim().is_empty() => d.trim().to_string(),
        _ => std::env::var("XDFDEFINITIONS_PATH").map_err(|_| {
            "no definitions directory: pass one or set XDFDEFINITIONS_PATH".to_string()
        })?,
    };
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(format!("definitions directory not found: {dir}"));
    }
    let mut out = Vec::new();
    let mut stack = vec![root];
    while let Some(p) = stack.pop() {
        let entries =
            std::fs::read_dir(&p).map_err(|e| format!("cannot list {}: {e}", p.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("bad dir entry: {e}"))?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let is_def = path
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| x.eq_ignore_ascii_case("xdf") || x.eq_ignore_ascii_case("xml"))
                .unwrap_or(false);
            if !is_def {
                continue;
            }
            let xml = std::fs::read_to_string(&path)
                .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
            out.push(DefFile {
                name: path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("?")
                    .to_string(),
                xml,
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            dump_rom,
            flash_rom,
            verify_rom,
            identify_pcm,
            nisprog_raw,
            read_file_bin,
            read_table,
            write_table,
            load_definitions
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
