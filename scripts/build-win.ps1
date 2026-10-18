# Windows 설치 파일을 만든다: dist\MultitudeLLM-Setup-<버전>.exe
# electron-builder가 내부에서 powershell.exe를 부르므로, PATH에 없으면 Windows PowerShell 경로를 붙인다.
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass; .\scripts\build-win.ps1
# ("powershell"이 PATH에 없어 'powershell -File ...' 형태가 안 되는 PC에서도 이렇게 하면 된다)

$ErrorActionPreference = 'Stop'
$winPs = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0'
if (-not (Get-Command powershell.exe -ErrorAction SilentlyContinue)) {
  $env:PATH = "$winPs;$env:PATH"
}

Set-Location (Join-Path $PSScriptRoot '..')
node scripts/make-icon.js
npm run dist
