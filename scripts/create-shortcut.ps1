# Creates a "Mis Finanzas" shortcut on the current user's Desktop that runs iniciar.cmd.
# Safe to run again: it overwrites the same shortcut.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root 'iniciar.cmd'
if (-not (Test-Path -LiteralPath $target)) { throw "iniciar.cmd not found in $root" }

$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop 'Mis Finanzas.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $root
$shortcut.WindowStyle = 7   # start minimized: the window only keeps the local server running
$shortcut.Description = 'Start Mis Finanzas'
$shortcut.Save()

Write-Host "Shortcut created: $link"
