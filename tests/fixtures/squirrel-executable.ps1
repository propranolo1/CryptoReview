param([string]$Directory, [ValidateSet('create','inspect','apply')][string]$Action, [string]$Mode = 'changed')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
if ($Action -eq 'create') {
    $old = New-Object byte[] (8 * 1024 * 1024)
    (New-Object Random(42)).NextBytes($old)
    $target = $old.Clone()
    $target[123] = $target[123] -bxor 1
    $target[$target.Length - 100] = $target[$target.Length - 100] -bxor 2
    if ($Mode -eq 'append') { $expanded = New-Object byte[] ($target.Length + 5); [Buffer]::BlockCopy($target, 0, $expanded, 0, $target.Length); $expanded[$expanded.Length - 1] = 5; $target = $expanded }
    if ($Mode -eq 'truncate') { $shortened = New-Object byte[] ($target.Length - 100); [Buffer]::BlockCopy($target, 0, $shortened, 0, $shortened.Length); $target = $shortened }
    if ($Mode -eq 'different') { (New-Object Random(87)).NextBytes($target) }
    foreach ($kind in @('base','full','delta')) {
        $zip = [IO.Compression.ZipFile]::Open((Join-Path $Directory "$kind.nupkg"), [IO.Compression.ZipArchiveMode]::Create)
        try {
            if ($kind -eq 'delta' -and $Mode -eq 'already-patched') {
                $entry = $zip.CreateEntry('lib/net45/CryptoReview.exe.diff')
                $entry.Open().Dispose()
            } else {
                $entry = $zip.CreateEntry('lib/net45/CryptoReview.exe')
                $stream = $entry.Open()
                try { $data = $target; if ($kind -eq 'base') { $data = $old }; $stream.Write($data, 0, $data.Length) } finally { $stream.Dispose() }
            }
            $entry = $zip.CreateEntry('lib/net45/resources/app.asar')
            $stream = $entry.Open()
            try { $data = [Text.Encoding]::UTF8.GetBytes('synthetic application fixture'); $stream.Write($data, 0, $data.Length) } finally { $stream.Dispose() }
        } finally { $zip.Dispose() }
    }
} elseif ($Action -eq 'apply') {
    $assembly = [Reflection.Assembly]::LoadFrom((Resolve-Path (Join-Path $PSScriptRoot '../../node_modules/electron-winstaller/vendor/Squirrel.exe')).Path)
    $flags = [Reflection.BindingFlags]'Instance,Public,NonPublic'
    $packageType = $assembly.GetType('Squirrel.ReleasePackage', $true)
    $constructor = $packageType.GetConstructor($flags, $null, [type[]]@([string], [bool]), $null)
    [string]$basePath = Join-Path $Directory 'CryptoReview-0.2.21-full.nupkg'
    [string]$deltaPath = Join-Path $Directory 'CryptoReview-0.2.22-delta.nupkg'
    [string]$restoredPath = Join-Path $Directory 'restored.nupkg'
    $basePackage = $constructor.Invoke([object[]]@($basePath, $true))
    $deltaPackage = $constructor.Invoke([object[]]@($deltaPath, $true))
    $builderType = $assembly.GetType('Squirrel.DeltaPackageBuilder', $true)
    $builder = $builderType.GetConstructor($flags, $null, [type[]]@([string]), $null).Invoke([object[]]@($Directory))
    $builderType.GetMethod('ApplyDeltaPackage', $flags, $null, [type[]]@($packageType, $packageType, [string]), $null).Invoke($builder, [object[]]@($basePackage, $deltaPackage, $restoredPath)) | Out-Null
    $expected = [IO.Compression.ZipFile]::OpenRead((Join-Path $Directory 'CryptoReview-0.2.22-full.nupkg'))
    $actual = [IO.Compression.ZipFile]::OpenRead($restoredPath)
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
        foreach ($entry in $expected.Entries) {
            $restored = $actual.GetEntry($entry.FullName)
            if (!$restored -or $restored.Length -ne $entry.Length) { throw '完整包还原文件缺失或长度不一致' }
            $left = $entry.Open()
            $right = $restored.Open()
            try {
                if ([BitConverter]::ToString($hash.ComputeHash($left)) -ne [BitConverter]::ToString($hash.ComputeHash($right))) { throw '完整包还原内容不一致' }
            } finally { $left.Dispose(); $right.Dispose() }
        }
    } finally { $hash.Dispose(); $actual.Dispose(); $expected.Dispose() }
    '{"restored":true}'
} else {
    $zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $Directory 'delta.nupkg'))
    try {
        @($zip.Entries | ForEach-Object { [pscustomobject]@{ name = $_.FullName; size = $_.Length } }) | ConvertTo-Json -Compress
    } finally { $zip.Dispose() }
}
