# Detached stability watch: launches the installed DshNative via explorer (user session,
# outside any agent command tree), drives realistic wallpaper traffic against its backend,
# and monitors the node backend for 10 minutes. All output goes to the result file.
$ErrorActionPreference = 'Continue'
$result = "$env:TEMP\dsh-stab-result.txt"
$backendLog = "$env:LOCALAPPDATA\DshNative\backend.log"
$blackbox = "$env:USERPROFILE\.dsh\plugin-wallpaper-crash.log"
$exe = 'D:\dshcode\DeepSeek Harness\DshNative.exe'

function Log($text) {
  Add-Content -Path $result -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss.fff'), $text)
}
Set-Content -Path $result -Value ("=== stability watch started {0} ===" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

# Marker so we only read log lines appended after launch.
$logMark = "STAB{0}" -f (Get-Random -Maximum 99999)
$before = if (Test-Path $backendLog) { (Get-Item $backendLog).Length } else { 0 }

if (-not (Test-Path $exe)) { Log "FATAL: exe not found: $exe"; exit 1 }
Log ("launching via explorer: " + $exe)
Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $exe + '"')

# Wait for a new ready line appended after launch.
$url = $null
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 700
  $len = (Get-Item $backendLog -ErrorAction SilentlyContinue).Length
  if ($len -gt $before) {
    $fs = [System.IO.File]::Open($backendLog, 'Open', 'Read', 'ReadWrite')
    $fs.Seek($before, 'Begin') | Out-Null
    $sr = New-Object System.IO.StreamReader($fs)
    $chunk = $sr.ReadToEnd()
    $sr.Close(); $fs.Close()
    if ($chunk -match 'dsh web: (http://127\.0\.0\.1:\d+)') { $url = $Matches[1]; break }
  }
}
if (-not $url) { Log "FATAL: backend did not become ready in 120s"; exit 1 }
Log ("BACKEND READY: " + $url)

# Find the backend node pid by command line.
function FindNode {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*dsh*bin.js*' } |
    Select-Object -First 1
}
$node = FindNode
if ($node) { Log ("node pid=" + $node.ProcessId) } else { Log "WARN: node pid not found yet" }

# Realistic traffic: page + wallpaper state.
try { $r = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 30; Log ("GET / -> " + $r.StatusCode + " (" + $r.RawContentLength + " bytes)") } catch { Log ("GET / FAILED: " + $_.Exception.Message) }

$wpId = '3547990150'
try { $r = Invoke-WebRequest "$url/plugin-wallpaper/state" -Method POST -ContentType 'application/json' -Body ('{"id":"' + $wpId + '"}') -UseBasicParsing -TimeoutSec 30; Log ("POST state -> " + $r.StatusCode) } catch { Log ("POST state FAILED: " + $_.Exception.Message) }

$src = $null; $mode = $null
try { $r = Invoke-WebRequest "$url/plugin-wallpaper/state" -UseBasicParsing -TimeoutSec 30; $j = $r.Content | ConvertFrom-Json; $mode = $j.mode; $src = $j.src; Log ("state: mode=" + $mode + " src=" + $src) } catch { Log ("GET state FAILED: " + $_.Exception.Message) }

# Drive media like the real front end: ranged streaming reads with an abort,
# repeated for the whole watch window.
$round = 0
for ($i = 1; $i -le 20; $i++) {
  Start-Sleep 30
  $node = FindNode
  if (-not $node) { Log ("BACKEND DIED at round " + $i + " (t+" + ($i * 30) + "s)"); break }
  $round = $i
  if ($src) {
    try {
      $req = [System.Net.HttpWebRequest]::Create(($url + $src))
      $req.AddRange(0, 262143)
      $resp = $req.GetResponse()
      $stream = $resp.GetResponseStream()
      $buf = New-Object byte[] 65536
      $read = 0
      while ($read -lt 131072) {
        $n = $stream.Read($buf, 0, $buf.Length)
        if ($n -le 0) { break }
        $read += $n
      }
      $stream.Close(); $resp.Close()
      Log ("t+" + ($i * 30) + "s: node alive pid=" + $node.ProcessId + "; stream read " + $read + "B ok")
    } catch { Log ("t+" + ($i * 30) + "s: node alive pid=" + $node.ProcessId + "; stream FAILED: " + $_.Exception.Message) }
  } else {
    Log ("t+" + ($i * 30) + "s: node alive pid=" + $node.ProcessId)
  }
  # Toggle wallpaper back and forth every other round, like a user browsing.
  if ($i % 4 -eq 2) {
    try { $r = Invoke-WebRequest "$url/plugin-wallpaper/state" -Method POST -ContentType 'application/json' -Body '{"id":null}' -UseBasicParsing -TimeoutSec 30; Log ("  toggle off -> " + $r.StatusCode) } catch { Log ("  toggle off FAILED: " + $_.Exception.Message) }
  } elseif ($i % 4 -eq 0) {
    try { $r = Invoke-WebRequest "$url/plugin-wallpaper/state" -Method POST -ContentType 'application/json' -Body ('{"id":"' + $wpId + '"}') -UseBasicParsing -TimeoutSec 30; Log ("  toggle on -> " + $r.StatusCode) } catch { Log ("  toggle on FAILED: " + $_.Exception.Message) }
  }
}

$nodeFinal = FindNode
if ($nodeFinal) { Log ("SURVIVED: node pid=" + $nodeFinal.ProcessId + " after " + ($round * 30) + "s of traffic") } else { Log ("FINAL: node gone after " + ($round * 30) + "s") }
if (Test-Path $blackbox) { Log "--- blackbox ---"; Get-Content $blackbox -Tail 10 | ForEach-Object { Log ("  " + $_) } } else { Log "blackbox: (none)" }

# Cleanup: kill the whole DshNative tree we launched.
$d = Get-Process DshNative -ErrorAction SilentlyContinue
if ($d) {
  foreach ($p in $d) { Start-Process -FilePath 'taskkill' -ArgumentList @('/pid', $p.Id, '/T', '/F') -WindowStyle Hidden }
  Log ("cleanup: killed DshNative pid(s) " + (($d | ForEach-Object Id) -join ','))
}
Log "=== watch done ==="
