# Compaction-threshold test: verify / revert helper.
#
# Context for whoever reads this later:
#   The auto-compaction trigger is floor(min(W * thresholdRatio, W - O - headroomTokens)).
#   On this profile W = 1,000,000 (my-catalog contextWindow) and O = 200,000 for the
#   flash routes, so the shipped default triggers at min(800000, 734464) = 734,464
#   tokens -- far above a normal session (measured pressure: ~80,214 tokens).
#
#   The live backend is the `compaction-basic` entry the `standard` preset mounts
#   inside its isolated `compaction` group. The profile patch layer CANNOT address
#   that nested entry: `--dump-config` proves a top-level `- id: compaction-basic`
#   patch lands only on the host-plane row, which is `disabled: true`. The only
#   reachable knob is the preset DECLARATION row, whose override replaces the
#   complete config, so `preset-standard-override.yml` restates the shipped plugin
#   list verbatim and changes only the nested threshold.
#
# Usage:
#   pwsh -File compaction-threshold-test.ps1 verify          # show what the composed config resolves to
#   pwsh -File compaction-threshold-test.ps1 backup          # fresh timestamped backup of cordis.patch.yml
#   pwsh -File compaction-threshold-test.ps1 revert          # remove the override, verify, show restart hint
#   pwsh -File compaction-threshold-test.ps1 restore-backup  # restore the newest .backup-compaction-test-* copy
param(
  [Parameter(Position = 0)]
  [ValidateSet('verify', 'backup', 'revert', 'restore-backup', 'status')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
$Node = 'D:\Dev\Path\nodejs_25.0.0\node.exe'
$Dsh = 'D:\Dev\Path\nodejs_25.0.0\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh\lib\bin.js'
$ProfileDir = 'C:\Users\ZYX\.dsh\profiles\web'
$PatchFile = Join-Path $ProfileDir 'cordis.patch.yml'
$HelperDir = 'I:\VMsShare\context-compare'
$InstallHelper = Join-Path $HelperDir 'install-override.mjs'

function Get-Dump {
  param([string]$OutFile)
  & $Node $Dsh --profile web --dump-config 2>&1 | Out-File -Encoding utf8 $OutFile
  if ($LASTEXITCODE -ne 0) { throw "dsh --dump-config failed with exit $LASTEXITCODE; see $OutFile" }
}

function Show-Resolved {
  param([string]$DumpFile)
  Write-Host ''
  Write-Host '--- resolved compaction-basic entries in the composed tree ---' -ForegroundColor Cyan
  $lines = Get-Content $DumpFile
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*- id: compaction-basic\s*$') {
      $indent = $lines[$i].Length - $lines[$i].TrimStart().Length
      $scope = if ($indent -eq 0) { 'HOST PLANE (disabled row)' } else { 'NESTED (inside a preset group) <- the live backend' }
      Write-Host ("L{0}: indent={1}  {2}" -f ($i + 1), $indent, $scope) -ForegroundColor Yellow
      for ($j = $i + 1; $j -lt [Math]::Min($i + 8, $lines.Count); $j++) {
        if ($lines[$j] -match '^\s*- id: ' -and ($lines[$j].Length - $lines[$j].TrimStart().Length) -le $indent) { break }
        Write-Host ("      " + $lines[$j])
      }
    }
  }
}

function Invoke-Verify {
  $dump = Join-Path $HelperDir 'verify-dump.txt'
  Get-Dump -OutFile $dump
  Show-Resolved -DumpFile $dump
  Write-Host ''
  Write-Host '--- current session pressure (last recorded projection) ---' -ForegroundColor Cyan
  $cacheDir = 'C:\Users\ZYX\.dsh\storages\session_projcache\sessions'
  Get-ChildItem $cacheDir -Filter '*.json' | Sort-Object LastWriteTime -Descending | Select-Object -First 3 | ForEach-Object {
    try {
      $j = Get-Content $_.FullName -Raw | ConvertFrom-Json
      $rows = if ($null -ne $j.record.rows) { $j.record.rows } else { $j.record.rowStates }
      $cp = $rows.contextPressure
      if ($null -ne $cp) {
        Write-Host ("{0}  surfaceTokens={1}  pressureTokens={2}  contextWindow={3}" -f $_.Name, $cp.val.surfaceTokens, $cp.val.pressureTokens, $cp.val.contextWindow)
      }
    } catch { }
  }
  Write-Host ''
  Write-Host 'Expected trigger (flash route, W=1e6, O=200000, headroom=65536):' -ForegroundColor Cyan
  Write-Host '  default    floor(min(1e6*0.80, 1e6-200000-65536)) = 734,464'
  Write-Host '  override   floor(min(1e6*0.10, 1e6-200000-65536)) = 100,000'
  return $dump
}

function Invoke-Backup {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $dir = Join-Path $ProfileDir ".backup-compaction-test-$stamp"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $dest = Join-Path $dir 'cordis.patch.yml'
  Copy-Item $PatchFile $dest -Force
  $a = (Get-FileHash $PatchFile -Algorithm SHA256).Hash
  $b = (Get-FileHash $dest -Algorithm SHA256).Hash
  Write-Host "backup  -> $dest"
  Write-Host "SHA256  source=$a"
  Write-Host "SHA256  backup=$b"
  Write-Host "identical: $($a -eq $b)" -ForegroundColor $(if ($a -eq $b) { 'Green' } else { 'Red' })
  $dest | Set-Content -Encoding utf8 (Join-Path $HelperDir 'LAST-BACKUP-PATH.txt')
  return $dest
}

function Invoke-Revert {
  Invoke-Backup | Out-Null
  Write-Host ''
  Write-Host 'removing override block...' -ForegroundColor Cyan
  & $Node $InstallHelper $PatchFile '--remove'
  if ($LASTEXITCODE -ne 0) { throw "install-override --remove failed with exit $LASTEXITCODE" }
  Write-Host ''
  Invoke-Verify | Out-Null
}

function Invoke-RestoreBackup {
  $dirs = Get-ChildItem $ProfileDir -Directory -Filter '.backup-compaction-test-*' | Sort-Object Name -Descending
  if ($dirs.Count -eq 0) { throw 'no .backup-compaction-test-* directory found' }
  $src = Join-Path $dirs[0].FullName 'cordis.patch.yml'
  if (-not (Test-Path $src)) { throw "backup file missing: $src" }
  Copy-Item $PatchFile "$PatchFile.replaced-$(Get-Date -Format yyyyMMdd-HHmmss)" -Force
  Copy-Item $src $PatchFile -Force
  $a = (Get-FileHash $src -Algorithm SHA256).Hash
  $b = (Get-FileHash $PatchFile -Algorithm SHA256).Hash
  Write-Host "restored from $src"
  Write-Host "identical: $($a -eq $b)" -ForegroundColor $(if ($a -eq $b) { 'Green' } else { 'Red' })
  Write-Host ''
  Invoke-Verify | Out-Null
}

switch ($Action) {
  'verify' { Invoke-Verify | Out-Null }
  'backup' { Invoke-Backup | Out-Null }
  'revert' { Invoke-Revert }
  'restore-backup' { Invoke-RestoreBackup }
  'status' {
    Write-Host 'patch file:' -ForegroundColor Cyan
    Write-Host "  $PatchFile  ($((Get-Item $PatchFile).Length) bytes, modified $((Get-Item $PatchFile).LastWriteTime))"
    Write-Host 'override present:' -ForegroundColor Cyan
    $has = (Get-Content $PatchFile) -match '^- id: preset-standard'
    Write-Host "  $([bool]$has)"
    Write-Host ''
    Write-Host 'backups:' -ForegroundColor Cyan
    Get-ChildItem $ProfileDir -Directory -Filter '.backup-compaction-test-*' | Sort-Object Name | ForEach-Object { Write-Host "  $($_.Name)" }
    Write-Host ''
    Write-Host 'usage: verify | backup | revert | restore-backup'
  }
}
