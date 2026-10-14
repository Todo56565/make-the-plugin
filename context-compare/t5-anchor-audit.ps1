param(
  [string]$Matrix = 'I:\VMsShare\context-compare\t4-mechanism-matrix.md',
  [string]$CodexRoot = 'I:\VMsShare\_src-compare\codex',
  [string]$PluginRoot = 'I:\VMsShare\_src-compare\dsh-agent-teams',
  [string]$HostRoot = 'D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai',
  [string]$Profile = 'C:\Users\ZYX\.dsh\profiles\web\cordis.yml'
)

$codexFiles = Get-ChildItem -LiteralPath $CodexRoot -Recurse -File -Include *.rs,*.md | Select-Object -ExpandProperty FullName
$pluginFiles = Get-ChildItem -LiteralPath $PluginRoot -Recurse -File -Include *.ts,*.md | Select-Object -ExpandProperty FullName
$hostFiles = Get-ChildItem -LiteralPath $HostRoot -Recurse -File -Include *.js,*.ts,*.d.ts -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
$profileLines = (Get-Content -LiteralPath $Profile).Count

function Resolve-One([string]$p) {
  # returns array of candidate full paths, best first
  $out = @()
  $norm = $p -replace '/','\'
  foreach ($pair in @(@($CodexRoot,$codexFiles), @($PluginRoot,$pluginFiles), @($HostRoot,$hostFiles))) {
    $root = $pair[0]; $files = $pair[1]
    $direct = Join-Path $root $norm
    if (Test-Path -LiteralPath $direct -PathType Leaf) { $out += (Resolve-Path -LiteralPath $direct).Path; continue }
    $suffix = '\' + $norm
    $hits = $files | Where-Object { $_.EndsWith($suffix, [System.StringComparison]::OrdinalIgnoreCase) }
    foreach ($h in ($hits | Sort-Object { $_.Length })) { $out += $h }
  }
  return $out
}

$lines = Get-Content $Matrix
$lineNo = 0
$rows = New-Object System.Collections.Generic.List[object]
$rx = [regex]'`([A-Za-z0-9_\-\\/\.]+\.(?:rs|ts|js|md|yml))(?::([0-9]{1,5})(?:[-,]([0-9]{1,5}))?)?`'
foreach ($l in $lines) {
  $lineNo++
  foreach ($m in $rx.Matches($l)) {
    $p = $m.Groups[1].Value
    $s = if ($m.Groups[2].Success) { [int]$m.Groups[2].Value } else { $null }
    $e = if ($m.Groups[3].Success) { [int]$m.Groups[3].Value } else { $null }
    if ($p -eq 'cordis.yml') {
      if ($null -ne $s -and $s -gt $profileLines) { $rows.Add([pscustomobject]@{ L=$lineNo; Cite=$p; Status="PROFILE-OUT-OF-RANGE(max=$profileLines)" }) }
      continue
    }
    if ($p -match '^(t1-|t2-|t3-)') { continue }
    $cands = Resolve-One $p
    if ($cands.Count -eq 0) { $rows.Add([pscustomobject]@{ L=$lineNo; Cite=$p; Status='FILE-MISSING' }); continue }
    $inRange = @()
    foreach ($c in $cands) {
      $cnt = (Get-Content -LiteralPath $c).Count
      $okRange = ($null -eq $s) -or ($s -le $cnt -and (($null -eq $e) -or ($e -le $cnt)))
      $inRange += [pscustomobject]@{ Path=$c; Lines=$cnt; Ok=$okRange }
    }
    $anyOk = $inRange | Where-Object { $_.Ok }
    if (-not $anyOk) {
      $rows.Add([pscustomobject]@{ L=$lineNo; Cite=$p; Status=("ALL-CANDIDATES-OUT-OF-RANGE: " + (($inRange | ForEach-Object { "$([System.IO.Path]::GetFileName($_.Path))(max $($_.Lines))" }) -join ' | ')) })
    }
  }
}
Write-Output ("citations with a range problem: " + $rows.Count)
$rows | Sort-Object L | Format-Table -AutoSize -Wrap
