# Controlled reproduction of the silent exit(1): standalone backend + headless client.
$ErrorActionPreference = 'Continue'

$node = "$env:LOCALAPPDATA\DshNative\runtime\node.exe"
$cli = "$env:LOCALAPPDATA\DshNative\runtime\node_modules\@deepseek-ai\dsh\lib\bin.js"
$overlay = "$env:LOCALAPPDATA\DshNative\desktop.yml"
$out = "$env:TEMP\dshrepro-out.log"
$err = "$env:TEMP\dshrepro-err.log"
$blackbox = "$env:USERPROFILE\.dsh\plugin-wallpaper-crash.log"
Remove-Item $out, $err -ErrorAction SilentlyContinue

$p = Start-Process -FilePath $node -ArgumentList @("`"$cli`"", '--profile', 'web', '--patch', "`"$overlay`"", '--no-open', '--port', '0') -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden
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
  Write-Output "BACKEND NOT READY. exit=$($p.ExitCode)"
  Write-Output ("stdout: " + (Get-Content $out -Raw -ErrorAction SilentlyContinue))
  Write-Output ("stderr: " + (Get-Content $err -Raw -ErrorAction SilentlyContinue))
  exit 1
}
Write-Output ("READY " + $url + " at " + (Get-Date).ToString('HH:mm:ss.fff'))

# Headless Edge as the UI client (WebSocket + wallpaper fetches stay connected).
$edgeProc = $null
$edgePaths = @("C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", "C:\Program Files\Microsoft\Edge\Application\msedge.exe")
$edge = $edgePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($edge) {
  $profile = Join-Path $env:TEMP ("dshrepro-edge-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $edgeProc = Start-Process -FilePath $edge -ArgumentList @('--headless=new', "--user-data-dir=`"$profile`"", '--window-size=1400,800', '--disable-gpu', $url) -PassThru -WindowStyle Hidden
  Write-Output ("edge pid=" + $edgeProc.Id)
  Start-Sleep 8
} else {
  Write-Output "edge not found; continuing without UI client"
}

# Simulate the user switching the app background (same id the user picked).
try {
  $r = Invoke-WebRequest "$url/plugin-wallpaper/state" -Method POST -ContentType 'application/json' -Body '{"id":"3547990150"}' -UseBasicParsing -TimeoutSec 30
  Write-Output ("state POST -> " + $r.StatusCode)
} catch { Write-Output ("state POST FAILED: " + $_.Exception.Message) }
try {
  $r2 = Invoke-WebRequest "$url/plugin-wallpaper/preview/3547990150" -UseBasicParsing -TimeoutSec 30
  Write-Output ("preview GET -> " + $r2.StatusCode + " " + $r2.RawContentLength + " bytes")
} catch { Write-Output ("preview GET FAILED: " + $_.Exception.Message) }

# Watch liveness for 240s.
$died = $false
for ($i = 1; $i -le 48; $i++) {
  Start-Sleep 5
  if ($p.HasExited) {
    Write-Output ("BACKEND DIED at " + (Get-Date).ToString('HH:mm:ss.fff') + " after ~" + ($i * 5) + "s of watch, exitcode=" + $p.ExitCode)
    $died = $true
    break
  }
}
if (-not $died) { Write-Output ("SURVIVED 240s at " + (Get-Date).ToString('HH:mm:ss.fff')) }

Write-Output "--- stdout tail ---"
Get-Content $out -Tail 25 -ErrorAction SilentlyContinue
Write-Output "--- stderr tail ---"
Get-Content $err -Tail 25 -ErrorAction SilentlyContinue
Write-Output "--- black box ---"
if (Test-Path $blackbox) { Get-Content $blackbox -Tail 20 } else { Write-Output "(no black box log)" }

if ($edgeProc -and -not $edgeProc.HasExited) { Stop-Process -Id $edgeProc.Id -Force -ErrorAction SilentlyContinue }
if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
Write-Output "--- event log (node) ---"
Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddMinutes(-10)} -ErrorAction SilentlyContinue |
  Where-Object { $_.Message -match 'node\.exe' } | Select-Object -First 3 | ForEach-Object { ($_.Message -split "`n" | Select-Object -First 6) -join ' | ' }
Write-Output "repro done"
