$Matrix = 'I:\VMsShare\context-compare\t4-mechanism-matrix.md'
$CR = 'I:\VMsShare\_src-compare\codex\codex-rs'
$cases = @(
  @{ name='5.1 child_config'; rs='core\src\agent\child_config.rs'; s=135; e=141; fl=150; fe=156 },
  @{ name='5.2 guardian review'; rs='core\src\guardian\review.rs'; s=151; e=153; fl=166; fe=169 },
  @{ name='5.3 AgentRoleOverrides'; rs='core\src\agent\role.rs'; s=36; e=48; fl=177; fe=189 },
  @{ name='5.4 FeatureSpec'; rs='features\src\lib.rs'; s=1481; e=1486; fl=201; fe=206 },
  @{ name='5.5 child_config 142-145'; rs='core\src\agent\child_config.rs'; s=142; e=145; fl=216; fe=219 }
)
$m = Get-Content $Matrix
foreach ($c in $cases) {
  $src = Get-Content (Join-Path $CR $c.rs)
  $ok = $true; $detail = @()
  $n = $c.fe - $c.fl + 1
  if (($c.e - $c.s + 1) -ne $n) { $ok = $false; $detail += "range-length mismatch" }
  for ($i = 0; $i -lt $n; $i++) {
    $a = $m[$c.fl - 1 + $i].TrimEnd(); $b = $src[$c.s - 1 + $i].TrimEnd()
    if ($a -cne $b) { $ok = $false; $detail += ("offset {0}: matrix[{1}] vs src[{2}]" -f $i, ($c.fl + $i), ($c.s + $i)) }
  }
  $fragLines = $n
  $within15 = $fragLines -le 15
  "{0,-24} cite={1}:{2}-{3}  frag={4} lines  <=15={5}  VERBATIM@CITED-POSITION={6}  {7}" -f $c.name, (Split-Path $c.rs -Leaf), $c.s, $c.e, $fragLines, $within15, $ok, ($detail -join '; ')
}
