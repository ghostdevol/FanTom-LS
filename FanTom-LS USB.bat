@echo off
rem Find the CLI however the release zip named it (PcmHammerCLI.exe, pcmhammer-cli.exe, ...)
for %%F in ("%~dp0tools\pcmh\*hammer*cli*.exe") do set "PCMHAMMER_PATH=%%~fF"
set "XDFDEFINITIONS_PATH=%~dp0tools\xdf"
start "" "%~dp0fantom-ls.exe"
