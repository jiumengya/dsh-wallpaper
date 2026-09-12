# Clean wallpaper ground truth: temporarily hide the desktop icon view
# (SHELLDLL_DefView) and minimize covering windows, BitBlt the physical
# screen, then ALWAYS restore everything. Captures WE's D3D wallpaper
# without icon/taskbar/window pollution.
# Usage: capture-desktop-clean.ps1 <out.png> [-MinimizeAll]
param(
  [Parameter(Mandatory = $true)][string]$OutPath,
  [switch]$MinimizeAll
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CleanCap {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassNameW(IntPtr hWnd, StringBuilder name, int max);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int xd, int yd, int w, int h, IntPtr src, int xs, int ys, uint rop);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);

  public static IntPtr FindIconView() {
    IntPtr progman = FindWindowW("Progman", null);
    if (progman == IntPtr.Zero) return IntPtr.Zero;
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(progman, (h, lp) => {
      var sb = new StringBuilder(64);
      GetClassNameW(h, sb, 64);
      if (sb.ToString() == "SHELLDLL_DefView") found = h;
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static System.Collections.Generic.List<IntPtr> MinimizeCovering() {
    var minimized = new System.Collections.Generic.List<IntPtr>();
    EnumWindowsProc del = (h, lp) => {
      var sb = new StringBuilder(64);
      GetClassNameW(h, sb, 64);
      var cls = sb.ToString();
      if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" ||
          cls == "Shell_SecondaryTrayWnd" || cls == "SysListView32" ||
          cls == "SHELLDLL_DefView") return true;
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(256);
      GetWindowTextW(h, t, 256);
      if (t.Length == 0) return true;
      if (ShowWindow(h, 6)) minimized.Add(h);  // SW_MINIMIZE
      return true;
    };
    EnumWindows(del, IntPtr.Zero);
    GC.KeepAlive(del);
    return minimized;
  }

  public static void RestoreAll(System.Collections.Generic.List<IntPtr> handles) {
    for (int i = handles.Count - 1; i >= 0; i--) ShowWindow(handles[i], 9);  // SW_RESTORE
  }
}
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
"@

[CleanCap]::SetProcessDPIAware() | Out-Null

$icons = [CleanCap]::FindIconView()
if ($icons -eq [IntPtr]::Zero) { throw "SHELLDLL_DefView not found" }
$wasVisible = [CleanCap]::IsWindowVisible($icons)
Write-Host "icon view 0x$($icons.ToString('X')) visible=$wasVisible"

$w = [CleanCap]::GetSystemMetrics(0)
$h = [CleanCap]::GetSystemMetrics(1)
Write-Host "screen ${w}x${h}"

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$minimized = $null
try {
  if ($MinimizeAll) { $minimized = [CleanCap]::MinimizeCovering() }
  if ($wasVisible) { [CleanCap]::ShowWindow($icons, 0) | Out-Null }  # SW_HIDE
  Start-Sleep -Milliseconds 600
  $hdc = $g.GetHdc()
  $screenDc = [CleanCap]::GetDC([IntPtr]::Zero)
  try {
    $ok = [CleanCap]::BitBlt($hdc, 0, 0, $w, $h, $screenDc, 0, 0, 0x00CC0020 -bor 0x40000000)  # SRCCOPY | CAPTUREBLT
    if (-not $ok) { throw "BitBlt failed" }
  } finally {
    [CleanCap]::ReleaseDC([IntPtr]::Zero, $screenDc) | Out-Null
    $g.ReleaseHdc($hdc)
  }
} finally {
  if ($wasVisible) { [CleanCap]::ShowWindow($icons, 5) | Out-Null }  # SW_SHOW
  if ($minimized) { [CleanCap]::RestoreAll($minimized) }
}
$g.Dispose()

$restored = [CleanCap]::IsWindowVisible($icons)
if ($wasVisible -and -not $restored) {
  [CleanCap]::ShowWindow($icons, 5) | Out-Null
  Start-Sleep -Milliseconds 100
  Write-Host "icon restore retry: visible=$([CleanCap]::IsWindowVisible($icons))"
}

$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "saved: $OutPath (icons visible=$restored)"
