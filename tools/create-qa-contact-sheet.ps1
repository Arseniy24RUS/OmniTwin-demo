param(
    [Parameter(Mandatory = $true)][string[]]$InputFiles,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [int]$Columns = 2,
    [int]$CellWidth = 960
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
if ($InputFiles.Count -lt 1 -or $InputFiles.Count -gt 32 -or $Columns -lt 1 -or $Columns -gt 4 -or $CellWidth -lt 320 -or $CellWidth -gt 1920) {
    throw 'Invalid bounded contact-sheet dimensions.'
}
$inputsResolved = @($InputFiles | ForEach-Object { (Resolve-Path -LiteralPath $_).Path })
$outputResolved = [IO.Path]::GetFullPath($OutputPath)
if ($inputsResolved -contains $outputResolved -or [IO.File]::Exists($outputResolved)) {
    throw 'Contact-sheet output must be a new file, never a source screenshot.'
}
if (-not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($outputResolved))) { throw 'Output directory must already exist.' }
$cellHeight = [int]($CellWidth * 9 / 16)
$labelHeight = 36
$rows = [int][Math]::Ceiling($InputFiles.Count / [double]$Columns)
$bitmap = New-Object Drawing.Bitmap ($CellWidth * $Columns), (($cellHeight + $labelHeight) * $rows)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$font = New-Object Drawing.Font 'Segoe UI', 13
$brush = New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(226, 238, 242))
try {
    $graphics.Clear([Drawing.Color]::FromArgb(6, 19, 28))
    $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    for ($i = 0; $i -lt $inputsResolved.Count; $i++) {
        $frame = [Drawing.Image]::FromFile($inputsResolved[$i])
        try {
            $left = ($i % $Columns) * $CellWidth
            $top = [int][Math]::Floor($i / [double]$Columns) * ($cellHeight + $labelHeight)
            $scale = [Math]::Min($CellWidth / [double]$frame.Width, $cellHeight / [double]$frame.Height)
            $width = [int]($frame.Width * $scale)
            $height = [int]($frame.Height * $scale)
            $graphics.DrawString([IO.Path]::GetFileNameWithoutExtension($inputsResolved[$i]), $font, $brush, [single]($left + 12), [single]($top + 7))
            $graphics.DrawImage($frame, [int]($left + ($CellWidth - $width) / 2), ($top + $labelHeight), $width, $height)
        } finally { $frame.Dispose() }
    }
    $bitmap.Save($outputResolved, [Drawing.Imaging.ImageFormat]::Png)
    Write-Output $outputResolved
} finally {
    $brush.Dispose(); $font.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
