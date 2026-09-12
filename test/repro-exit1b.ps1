# Reproduction with the exit tracer preload (ASCII-only script; the probe is written to TEMP).
$ErrorActionPreference = 'Continue'

$node = "$env:LOCALAPPDATA\DshNative\runtime\node.exe"
$cli = "$env:LOCALAPPDATA\DshNative\runtime\node_modules\@deepseek-ai\dsh\lib\bin.js"
$overlay = "$env:LOCALAPPDATA\DshNative\desktop.yml"
$trace = Join-Path $env:TEMP "dsh-trace-exit.mjs"
$traceContent = @'
import { writeSync } from "node:fs";
const tag = (s) => { try { writeSync(2, "[trace-exit] " + s + "\n"); } catch {} };
const origExit = process.exit;
process.exit = function (code) {
  tag("process.exit(" + code + ") called from:\n" + new Error().stack);
  return origExit.call(process, code);
};
process.on("exit", (code) => tag("exit event code=" + code + " from:\n" + new Error().stack));
process.on("beforeExit", (code) => tag("beforeExit code=" + code + " from:\n" + new Error().stack));
process.on("uncaughtExceptionMonitor", (err) => tag("uncaughtExceptionMonitor: " + (err?.stack ?? String(err))));
'@
Set-Content -Path $trace -Value $traceContent -Encoding ASCII
$traceUrl = "file:///" + ($trace -replace '\\', '/')
$out = "$env:TEMP\dshrepro2-out.log"
$err = "$env:TEMP\dshrepro2-err.log"
$blackbox = "$env:USERPROFILE\.dsh\plugin-wallpaper-crash.log"
Remove-Item $out, $err -ErrorAction SilentlyContinue

$p = Start-Process -FilePath $node -ArgumentList @('--import', $traceUrl, "`"$cli`"", '--profile', 'web', '--patch', "`"$overlay`"", '--no-open', '--port', '0') -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden
Write-Output ("backend pid=" + $p.Id)

$url = $null
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  $raw = Get-Content $out -Raw -ErrorAction SilentlyContinue
  if ($raw -match 'dsh web: (http://127\.0\.0\.1:\d+)') { $url = $Matches[1]; break }
  if ($p.HasExited) { break }
}
if (-not $url) {
  Write-Output "BACKEND NOT READY."
  Write-Output ("stdout: " + (Get-Content $out -Raw -ErrorAction SilentlyContinue))
  Write-Output ("stderr: " + (Get-Content $err -Raw -ErrorAction SilentlyContinue))
  exit 1
}
Write-Output ("READY " + $url + " at " + (Get-Date).ToString('HH:mm:ss.fff'))

$edgeProc = $null
$edgePaths = @("C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", "C:\Program Files\Microsoft\Edge\Application\msedge.exe")
$edge = $edgePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($edge) {
  $profile = Join-Path $env:TEMP ("dshrepro2-edge-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $edgeProc = Start-Process -FilePath $edge -ArgumentList @('--headless=new', "--user-data-dir=`"$profile`"", '--window-size=1400,800', '--disable-gpu', $url) -PassThru -WindowStyle Hidden
  Write-Output ("edge pid=" + $edgeProc.Id)
  Start-Sleep 8
}

try {
  $r = Invoke-WebRequest "$url/plugin-wallpaper/state" -Method POST -ContentType 'application/json' -Body '{"id":"3547990150"}' -UseBasicParsing -TimeoutSec 30
  Write-Output ("state POST -> " + $r.StatusCode)
} catch { Write-Output ("state POST FAILED: " + $_.Exception.Message) }

$died = $false
for ($i = 1; $i -le 66; $i++) {
  Start-Sleep 5
  if ($p.HasExited) {
    $p.Refresh()
    Write-Output ("BACKEND DIED at " + (Get-Date).ToString('HH:mm:ss.fff') + " after ~" + ($i * 5) + "s of watch, exitcode=" + $p.ExitCode)
    $died = $true
    break
  }
}
if (-not $died) { Write-Output ("SURVIVED 330s at " + (Get-Date).ToString('HH:mm:ss.fff')) }

Write-Output "--- stdout tail ---"
Get-Content $out -Tail 10 -ErrorAction SilentlyContinue
Write-Output "--- stderr (full) ---"
Get-Content $err -ErrorAction SilentlyContinue
Write-Output "--- black box ---"
if (Test-Path $blackbox) { Get-Content $blackbox -Tail 20 } else { Write-Output "(no black box log)" }

if ($edgeProc -and -not $edgeProc.HasExited) { Stop-Process -Id $edgeProc.Id -Force -ErrorAction SilentlyContinue }
if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
Write-Output "repro2 done"
