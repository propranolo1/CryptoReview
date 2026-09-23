param([string]$Baseline, [string]$Full, [string]$Delta, [string]$Squirrel, [string]$Work)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -Path (Join-Path $PSScriptRoot 'squirrel-executable-delta.cs') -ReferencedAssemblies System.IO.Compression, System.IO.Compression.FileSystem
$repaired = [SquirrelExecutableDelta]::Repair($Baseline, $Full, $Delta, $Squirrel, $Work)
@{ repaired = $repaired } | ConvertTo-Json -Compress
