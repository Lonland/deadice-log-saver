[CmdletBinding()]
param(
    [string]$InputDirectory = (Join-Path $PSScriptRoot '待整合TXT'),
    [string]$OutputPath = (Join-Path $PSScriptRoot ('跑团记录整合_{0}.xlsx' -f (Get-Date -Format 'yyyyMMdd_HHmmss')))
)

$ErrorActionPreference = 'Stop'

function Get-TextFileContent {
    param([string]$Path)

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        return [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3)
    }
    if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
        return [System.Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2)
    }
    if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF) {
        return [System.Text.Encoding]::BigEndianUnicode.GetString($bytes, 2, $bytes.Length - 2)
    }

    $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
    try {
        return $strictUtf8.GetString($bytes)
    } catch [System.Text.DecoderFallbackException] {
        return [System.Text.Encoding]::GetEncoding(54936).GetString($bytes)
    }
}

function ConvertFrom-ExporterText {
    param(
        [string]$Content,
        [string]$SourceFile
    )

    $headerPattern = '^(?<name>.+?)\((?<qq>[^()]+)\)\s+(?<time>\d{4}/\d{2}/\d{2}\s+\d{2}:\d{2}:\d{2})\s*$'
    $lines = $Content -split "`r?`n"
    $records = [System.Collections.Generic.List[object]]::new()
    $current = $null
    $messageLines = [System.Collections.Generic.List[string]]::new()

    foreach ($line in $lines) {
        $match = [regex]::Match($line, $headerPattern)
        if ($match.Success) {
            if ($null -ne $current) {
                while ($messageLines.Count -gt 0 -and [string]::IsNullOrWhiteSpace($messageLines[$messageLines.Count - 1])) {
                    $messageLines.RemoveAt($messageLines.Count - 1)
                }
                $records.Add([pscustomobject]@{
                    SourceFile = $SourceFile
                    Name = $current.Name
                    QQ = $current.QQ
                    Time = $current.Time
                    SortTime = $current.SortTime
                    Content = ($messageLines -join [Environment]::NewLine)
                })
            }

            $parsedTime = [datetime]::MinValue
            [void][datetime]::TryParseExact($match.Groups['time'].Value, 'yyyy/MM/dd HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$parsedTime)
            $current = [pscustomobject]@{
                Name = $match.Groups['name'].Value.Trim()
                QQ = $match.Groups['qq'].Value.Trim()
                Time = $match.Groups['time'].Value
                SortTime = $parsedTime
            }
            $messageLines = [System.Collections.Generic.List[string]]::new()
        } elseif ($null -ne $current) {
            $messageLines.Add($line)
        }
    }

    if ($null -ne $current) {
        while ($messageLines.Count -gt 0 -and [string]::IsNullOrWhiteSpace($messageLines[$messageLines.Count - 1])) {
            $messageLines.RemoveAt($messageLines.Count - 1)
        }
        $records.Add([pscustomobject]@{
            SourceFile = $SourceFile
            Name = $current.Name
            QQ = $current.QQ
            Time = $current.Time
            SortTime = $current.SortTime
            Content = ($messageLines -join [Environment]::NewLine)
        })
    }

    return $records
}

function ConvertTo-XmlText {
    param([object]$Value)

    return [System.Security.SecurityElement]::Escape([string]$Value)
}

function Get-ExcelColumnName {
    param([int]$Index)

    $name = ''
    $number = $Index + 1
    while ($number -gt 0) {
        $remainder = ($number - 1) % 26
        $name = [char](65 + $remainder) + $name
        $number = [math]::Floor(($number - 1) / 26)
    }
    return $name
}

function New-XlsxFile {
    param(
        [object[]]$Rows,
        [string]$Path
    )

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $headers = @('来源文件', '名字', 'QQ号', '时间', '内容')
    $allRows = [System.Collections.Generic.List[object]]::new()
    $allRows.Add([object[]]$headers)
    foreach ($record in $Rows) {
        $allRows.Add([object[]]@($record.SourceFile, $record.Name, $record.QQ, $record.Time, $record.Content))
    }
    $sheetRows = [System.Text.StringBuilder]::new()

    for ($rowIndex = 0; $rowIndex -lt $allRows.Count; $rowIndex++) {
        [void]$sheetRows.Append('<row r="{0}">' -f ($rowIndex + 1))
        for ($columnIndex = 0; $columnIndex -lt $allRows[$rowIndex].Count; $columnIndex++) {
            $reference = ('{0}{1}' -f (Get-ExcelColumnName $columnIndex), ($rowIndex + 1))
            $text = ConvertTo-XmlText $allRows[$rowIndex][$columnIndex]
            $cellXml = '<c r="{0}" t="inlineStr"><is><t xml:space="preserve">{1}</t></is></c>' -f $reference, $text
            [void]$sheetRows.Append($cellXml)
        }
        [void]$sheetRows.Append('</row>')
    }

    $sheetXml = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:E$($allRows.Count)"/><cols><col min="1" max="1" width="30" customWidth="1"/><col min="2" max="2" width="18" customWidth="1"/><col min="3" max="3" width="16" customWidth="1"/><col min="4" max="4" width="22" customWidth="1"/><col min="5" max="5" width="80" customWidth="1"/></cols><sheetData>$sheetRows</sheetData></worksheet>
"@
    $files = [ordered]@{
        '[Content_Types].xml' = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
        '_rels/.rels' = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
        'xl/workbook.xml' = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="整合记录" sheetId="1" r:id="rId1"/></sheets></workbook>'
        'xl/_rels/workbook.xml.rels' = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
        'xl/worksheets/sheet1.xml' = $sheetXml
    }

    $outputDirectory = Split-Path -Parent $Path
    if ($outputDirectory) { [System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null }
    if (Test-Path $Path) { Remove-Item -LiteralPath $Path -Force }
    $archive = [System.IO.Compression.ZipFile]::Open($Path, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in $files.GetEnumerator()) {
            $entry = $archive.CreateEntry($file.Key)
            $writer = [System.IO.StreamWriter]::new($entry.Open(), [System.Text.UTF8Encoding]::new($false))
            try { $writer.Write($file.Value) } finally { $writer.Dispose() }
        }
    } finally {
        $archive.Dispose()
    }
}

if (-not (Test-Path -LiteralPath $InputDirectory -PathType Container)) {
    throw "找不到待整合目录：$InputDirectory"
}

$txtFiles = @(Get-ChildItem -LiteralPath $InputDirectory -File -Filter '*.txt' | Sort-Object Name)
if ($txtFiles.Count -eq 0) {
    throw "待整合目录中没有 TXT 文件：$InputDirectory"
}

$allRecords = [System.Collections.Generic.List[object]]::new()
$skippedFiles = [System.Collections.Generic.List[string]]::new()
foreach ($file in $txtFiles) {
    $records = @(ConvertFrom-ExporterText -Content (Get-TextFileContent $file.FullName) -SourceFile $file.Name)
    if ($records.Count -eq 0) {
        $skippedFiles.Add($file.Name)
        continue
    }
    $allRecords.AddRange($records)
}

if ($allRecords.Count -eq 0) {
    throw '没有识别到符合导出器格式的聊天记录。请确认 TXT 文件未被修改。'
}

$sortedRecords = @($allRecords | Sort-Object SortTime, SourceFile)
New-XlsxFile -Rows $sortedRecords -Path $OutputPath
Write-Host "已整合 $($sortedRecords.Count) 条记录，输出文件：$OutputPath" -ForegroundColor Green
if ($skippedFiles.Count -gt 0) {
    Write-Warning "已跳过不符合格式或没有记录的文件：$($skippedFiles -join '、')"
}