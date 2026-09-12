# Ancestry test: does a TRAE-command-descendant node.exe die while a WMI-detached one survives?
$ErrorActionPreference = 'Continue'
$node = "$env:LOCALAPPDATA\DshNative\runtime\node.exe"

# A: direct child of this PowerShell (TRAE command tree descendant)
$outA = "$env:TEMP\dshprobe-a.log"
$errA = "$env:TEMP\dshprobe-a-err.log"
$a = Start-Process -FilePath $node -ArgumentList @('-e', 'setInterval(()=>{},1000)') -RedirectStandardOutput $outA -RedirectStandardError $errA -PassThru -WindowStyle Hidden
Write-Output ("A (command child) pid=" + $a.Id)

# B: spawned via WMI (parent = WmiPrvSE.exe, fully detached from the command tree)
$bPid = $null
try {
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '"' + $node + '" -e "setInterval(()=>{},1000)"' }
  $bPid = $r.ProcessId
  Write-Output ("B (WMI detached) pid=" + $bPid + " ret=" + $r.ReturnValue)
} catch { Write-Output ("B launch failed: " + $_.Exception.Message) }

for ($i = 1; $i -le 60; $i++) {
  Start-Sleep 5
  $aAlive = -not $a.HasExited
  $bAlive = $false
  if ($bPid) { $bAlive = [bool](Get-Process -Id $bPid -ErrorAction SilentlyContinue) }
  if (-not $aAlive -or -not $bAlive) {
    Write-Output ("DEATH at t+" + ($i * 5) + "s: A alive=" + $aAlive + " B alive=" + $bAlive)
    if (-not $aAlive) { $a.Refresh(); Write-Output ("A exitcode=" + $a.ExitCode) }
    if (-not $bAlive) {
      $p = Get-Process -Id $bPid -ErrorAction SilentlyContinue
      if (-not $p) { Write-Output "B process object gone" }
    }
    break
  }
  if ($i % 12 -eq 0) { Write-Output ("t+" + ($i * 5) + "s: both alive") }
}
$aFinal = -not $a.HasExited
$bFinal = $false
if ($bPid) { $bFinal = [bool](Get-Process -Id $bPid -ErrorAction SilentlyContinue) }
Write-Output ("FINAL after 300s: A alive=" + $aFinal + " B alive=" + $bFinal")

Write-Output "--- Defender log (last 10 min) ---"
try {
  Get-WinEvent -LogName 'Microsoft-Windows-Windows Defender/Operational' -MaxEvents 30 -ErrorAction Stop |
    Where-Object { $_.TimeCreated -gt (Get-Date).AddMinutes(-10) } |
    ForEach-Object { "$($_.TimeCreated.ToString('HH:mm:ss')) Id=$($_.Id) $($_.Message.Substring(0, [Math]::Min(120, $_.Message.Length)))" }
} catch { Write-Output "(defender log unavailable)" }

if ($aFinal) { Stop-Process -Id $a.Id -Force -ErrorAction SilentlyContinue }
if ($bFinal -and $bPid) { Stop-Process -Id $bPid -Force -ErrorAction SilentlyContinue }
Write-Output "ancestry test done"
