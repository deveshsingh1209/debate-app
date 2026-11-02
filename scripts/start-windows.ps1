# Helper for "Start on Windows.bat". Checks Node.js, then runs the same start script as every other system.
param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Rest)

$ErrorActionPreference = 'Continue'
Set-Location (Split-Path -Parent $PSScriptRoot)

Write-Host 'The Debate App'
Write-Host '--------------'

function Show-NodeHelp([string] $why) {
  Write-Host ''
  Write-Host "The app needs a free program called Node.js (version 22 or newer), and it is $why."
  Write-Host ''
  Write-Host 'How to get it (about 2 minutes):'
  Write-Host '  1. A web page will open: nodejs.org'
  Write-Host "  2. Click the big green button that says 'LTS'. It downloads an installer."
  Write-Host '  3. Open the downloaded file and click Next / Install until it finishes. Keep the default choices.'
  Write-Host "  4. Close this window, then double-click 'Start on Windows.bat' again."
  Write-Host ''
  $answer = Read-Host 'Open nodejs.org for you now? (y/n)'
  if ($answer -match '^[yY]') { Start-Process 'https://nodejs.org/en/download' }
}

# A fresh Node install is not always visible to an already-open window; look in the usual place too.
$nodeDir = Join-Path $env:ProgramFiles 'nodejs'
if (Test-Path (Join-Path $nodeDir 'node.exe')) { $env:Path = "$nodeDir;$env:Path" }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Show-NodeHelp 'not installed on this PC'; exit 1 }

$version = (& node -p 'process.versions.node' 2>$null)
$major = 0
if ($version) { [void][int]::TryParse($version.Split('.')[0], [ref]$major) }
if ($major -lt 22) { Show-NodeHelp "too old (you have $version)"; exit 1 }

& node scripts/start.mjs @Rest
$code = $LASTEXITCODE
if ($code -ne 0) {
  Write-Host ''
  Write-Host 'The app stopped with a problem (see the message above).'
  Write-Host "Help: README.md, section 'Troubleshooting'."
}
exit $code
