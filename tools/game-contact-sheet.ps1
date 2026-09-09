param([Parameter(Mandatory=$true)][string]$EvidenceRoot)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$evidence = (Resolve-Path -LiteralPath $EvidenceRoot).Path
$desktop = Join-Path $evidence 'desktop-1920x1080/streamed-quarter-courtyard-and-motion-remain-real-and-depth-correct'
$items = @(
  @('00-native-before-same-camera-viewport.png', 'BEFORE | Native map | same camera'),
  @('01-quarter-viewport.png', 'AFTER | Streamed quarter prototype | same camera'),
  @('02-courtyard-viewport.png', 'Courtyard | real 3D actors'),
  @('03-during-right-drag-viewport.png', 'During actual right-button camera rotation')
)
$sheet = [System.Drawing.Bitmap]::new(1920, 1160)
$graphics = [System.Drawing.Graphics]::FromImage($sheet)
$font = [System.Drawing.Font]::new('Segoe UI', 16)
try {
  $graphics.Clear([System.Drawing.Color]::FromArgb(6, 19, 28))
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  for ($i=0; $i -lt $items.Count; $i++) {
    $x=($i%2)*960; $y=[Math]::Floor($i/2)*580
    $graphics.DrawString($items[$i][1], $font, [System.Drawing.Brushes]::White, $x+16, $y+9)
    $source = [System.Drawing.Image]::FromFile((Join-Path $desktop $items[$i][0]))
    try {
      if ($source.Width -ne 1920 -or $source.Height -ne 1080) { throw 'Contact sheet requires matched 1920x1080 source images.' }
      $graphics.DrawImage($source, [System.Drawing.Rectangle]::new($x, $y+40, 960, 540))
    } finally { $source.Dispose() }
  }
  $output = Join-Path $evidence 'contact-sheet.png'
  $sheet.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output $output
} finally { $font.Dispose(); $graphics.Dispose(); $sheet.Dispose() }
