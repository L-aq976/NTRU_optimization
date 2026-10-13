# ============================================================================
#  build.ps1 -- Windows build script (MinGW-w64 g++, no CMake needed)
#
#  Usage (inside the 最终方案 folder):
#     powershell -ExecutionPolicy Bypass -File .\build.ps1
#     powershell -ExecutionPolicy Bypass -File .\build.ps1 -Test
#     powershell -ExecutionPolicy Bypass -File .\build.ps1 -Smoke
#
#  NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 files as
#  ANSI when there is no BOM, which corrupts UTF-8 comments.
#  For real performance runs, build in WSL(Ubuntu) with the Makefile instead
#  (gcc 13.3 + the CuPy GPU path live there).
# ============================================================================
param(
    [switch]$Test,
    [switch]$Smoke,
    [switch]$Bench
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path $root "src"
$bin  = Join-Path $root "bin"
New-Item -ItemType Directory -Force -Path $bin | Out-Null

if (-not (Get-Command g++ -ErrorAction SilentlyContinue)) {
    throw "g++ not found in PATH (install MinGW-w64 or build inside WSL)"
}

# -static-libstdc++ / -static-libgcc is NOT optional on Windows:
#   Git for Windows ships its own (older) libstdc++-6.dll and puts it on PATH
#   ahead of the MinGW toolchain's. If we link dynamically, the exe binds to
#   THAT dll and mixing runtimes corrupts C++ objects -> access violation.
#   Symptom seen in practice: `ntru_cli vectors` segfaults while `selftest`
#   survives, because vectors is the only subcommand that constructs an
#   ofstream (the crash is inside basic_ofstream's constructor).
$flags = @("-O3", "-std=c++17", "-march=native", "-fopenmp", "-Wall", "-Wextra",
           "-static-libstdc++", "-static-libgcc", "-I$src")
$core  = Get-ChildItem (Join-Path $src "core") -Filter *.cpp | ForEach-Object { $_.FullName }
$cliOut  = Join-Path $bin "ntru_cli.exe"
$testOut = Join-Path $bin "ntru_tests.exe"

Write-Host "== building ntru_cli.exe ==" -ForegroundColor Cyan
& g++ @flags -o $cliOut @core (Join-Path $src "cli/main.cpp")
if ($LASTEXITCODE -ne 0) { throw "build failed (CLI)" }
Write-Host "OK -> $cliOut" -ForegroundColor Green

$testSrc = Join-Path $root "tests/test_core.cpp"
if (Test-Path $testSrc) {
    Write-Host "== building ntru_tests.exe ==" -ForegroundColor Cyan
    & g++ @flags -o $testOut @core $testSrc
    if ($LASTEXITCODE -ne 0) { throw "build failed (tests)" }
    Write-Host "OK -> $testOut" -ForegroundColor Green
}

if ($Test)  { Write-Host "== selftest ==" -ForegroundColor Cyan; & $cliOut selftest }
if ($Smoke) { Write-Host "== smoke =="    -ForegroundColor Cyan; & $cliOut smoke EES439 3 2 }
if ($Bench) { Write-Host "== bench =="    -ForegroundColor Cyan; & $cliOut bench EES1171 100 }
