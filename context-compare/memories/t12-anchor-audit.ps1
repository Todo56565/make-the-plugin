param(
  [string]$Doc = 'I:\VMsShare\context-compare\memories\m3-memory-comparison-matrix.md',
  [string]$CodexRoot = 'I:\VMsShare\_src-compare\codex',
  [string]$PluginRoot = 'I:\VMsShare\_src-compare\dsh-agent-teams',
  [string]$HostRoot = 'D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai',
  [string]$ProfileDir = 'C:\Users\ZYX\.dsh\profiles\web'
)
# Mechanical anchor audit: extract `path:line[-end]` citations and resolve them.
$codexFiles = Get-ChildItem -LiteralPath $CodexRoot -Recurse -File -Include *.rs,*.md -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
$pluginFiles = Get-ChildItem -LiteralPath $PluginRoot -Recurse -File -Include *.ts,*.md -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
$hostFiles = Get-ChildItem -LiteralPath $HostRoot -Recurse -File -Include *.js,*.ts,*.d.ts -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
$profFiles = Get-ChildItem -LiteralPath $ProfileDir -Recurse -File -Include *.yml,*.ts,*.js -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName

function Resolve-One([string]$p) {
  $out = @()
  $norm = $p -replace '/','\'
  if ($norm -match '^[A-Za-z]:') { return @($norm) }
  foreach ($pair in @(@($CodexRoot,$codexFiles), @($PluginRoot,$pluginFiles), @($HostRoot,$hostFiles), @($ProfileDir,$profFiles))) {
    $root = $pair[0]; $files = $pair[1]
    $direct = Join-Path $root $norm
    if (Test-Path -LiteralPath $direct -PathType Leaf) { $out += (Resolve-Path -LiteralPath $direct).Path; continue }
    $suffix = '\' + $norm
    $hits = $files | Where-Object { $_.EndsWith($suffix, [System.StringComparison]::OrdinalIgnoreCase) }
    foreach ($h in ($hits | Sort-Object { $_.Length })) { $out += $h }
  }
  return $out
}

$lines = Get-Content $Doc
$lineNo = 0
$rows = New-Object System.Collections.Generic.List[object]
$rx = [regex]'`([A-Za-z0-9_:\\/\.\-]+\.(?:rs|ts|js|md|yml|sql|toml))(?::([0-9]{1,5})(?:[-,]([0-9]{1,5}))?)?`'
foreach ($l in $lines) {
  $lineNo++
  foreach ($m in $rx.Matches($l)) {
    $p = $m.Groups[1].Value
    $s = if ($m.Groups[2].Success) { [int]$m.Groups[2].Value } else { $null }
    $e = if ($m.Groups[3].Success) { [int]$m.Groups[3].Value } else { $null }
    if ($p -match '^(t9|t10)-') { continue }
    $cands = Resolve-One $p
    if ($cands.Count -eq 0) { $rows.Add([pscustomobject]@{ L=$lineNo; Cite=$p; S=$s; Status='FILE-NOT-RESOLVED' }); continue }
    $ok = $false; $info = @()
    foreach ($c in $cands) {
      $cnt = (Get-Content -LiteralPath $c).Count
      $inRange = ($null -eq $s) -or ($s -le $cnt -and (($null -eq $e) -or ($e -le $cnt)))
      if ($inRange) { $ok = $true }
      $info += "$([System.IO.Path]::GetFileName($c))(max $cnt)"
    }
    if (-not $ok) { $rows.Add([pscustomobject]@{ L=$lineNo; Cite=$p; S=$s; Status='OUT-OF-RANGE: ' + ($info -join ' | ') }) }
  }
}
Write-Output ("bad anchors: " + $rows.Count)
$rows | Sort-Object L | Format-Table -AutoSize -Wrap
