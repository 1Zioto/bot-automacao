param (
    [string]$SourceDir = "c:\Users\Douglas\Desktop\Claude\Bot_automação",
    [string]$OutputZip = "c:\Users\Douglas\Desktop\Claude\Bot_automacao_portatil_2026-09-11.zip"
)

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (Test-Path $OutputZip) {
    Remove-Item $OutputZip -Force
}

$excludeRegexes = @(
    '\\node_modules(\\.*)?$',
    '\\\.(git|data|wwebjs_cache|vercel)(\\.*)?$',
    '\\logs(\\.*)?$',
    '\.zip$',
    '\.rar$'
)

Write-Host "Criando arquivo ZIP: $OutputZip"
$zip = [System.IO.Compression.ZipFile]::Open($OutputZip, [System.IO.Compression.ZipArchiveMode]::Create)

$files = Get-ChildItem -Path $SourceDir -Recurse -File
$count = 0

foreach ($file in $files) {
    $skip = $false
    foreach ($regex in $excludeRegexes) {
        if ($file.FullName -match $regex) {
            $skip = $true
            break
        }
    }
    if ($skip) { continue }

    $relPath = $file.FullName.Substring($SourceDir.Length + 1)
    $entryName = "Bot_automacao/" + $relPath.Replace("\", "/")
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $zip,
        $file.FullName,
        $entryName,
        [System.IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
    $count++
}

$zip.Dispose()
$sizeMB = [math]::Round(((Get-Item $OutputZip).Length / 1MB), 2)
Write-Host "Concluido com sucesso!"
Write-Host "Total de arquivos incluidos: $count"
Write-Host "Tamanho final do ZIP: $sizeMB MB"
Write-Host "Caminho: $OutputZip"
