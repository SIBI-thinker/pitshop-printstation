param(
    [Parameter(Mandatory=$true)]
    [string]$InputPath,

    [Parameter(Mandatory=$true)]
    [string]$OutputDir
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $InputPath)) {
    Write-Error "Input file not found: $InputPath"
    exit 1
}

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

$extension = [System.IO.Path]::GetExtension($InputPath).ToLower()
$baseName = [System.IO.Path]::GetFileNameWithoutExtension($InputPath)
$pdfPath = Join-Path $OutputDir "$baseName.pdf"

function Convert-Word {
    param([string]$Source, [string]$Target)
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    try {
        $doc = $word.Documents.Open($Source, $false, $true)
        $doc.ExportAsFixedFormat($Target, 17)
        $doc.Close($false)
    } finally {
        $word.Quit()
        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
        [System.GC]::Collect()
        [System.GC]::WaitForPendingFinalizers()
    }
}

function Convert-Excel {
    param([string]$Source, [string]$Target)
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    try {
        $wb = $excel.Workbooks.Open($Source, $false, $true)
        $wb.ExportAsFixedFormat(0, $Target)
        $wb.Close($false)
    } finally {
        $excel.Quit()
        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
        [System.GC]::Collect()
        [System.GC]::WaitForPendingFinalizers()
    }
}

function Convert-PowerPoint {
    param([string]$Source, [string]$Target)
    $ppt = New-Object -ComObject PowerPoint.Application
    try {
        $pres = $ppt.Presentations.Open($Source, $true, $false, $false)
        $pres.SaveAs($Target, 32)
        $pres.Close()
    } finally {
        $ppt.Quit()
        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) | Out-Null
        [System.GC]::Collect()
        [System.GC]::WaitForPendingFinalizers()
    }
}

try {
    switch ($extension) {
        '.doc'  { Convert-Word -Source $InputPath -Target $pdfPath }
        '.docx' { Convert-Word -Source $InputPath -Target $pdfPath }
        '.xls'  { Convert-Excel -Source $InputPath -Target $pdfPath }
        '.xlsx' { Convert-Excel -Source $InputPath -Target $pdfPath }
        '.ppt'  { Convert-PowerPoint -Source $InputPath -Target $pdfPath }
        '.pptx' { Convert-PowerPoint -Source $InputPath -Target $pdfPath }
        default {
            Write-Error "Unsupported file type: $extension"
            exit 1
        }
    }

    if (Test-Path $pdfPath) {
        Write-Output $pdfPath
    } else {
        Write-Error "PDF was not created"
        exit 1
    }
} catch {
    Write-Error "Conversion failed: $($_.Exception.Message)"
    exit 1
}
