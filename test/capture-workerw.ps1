# Capture ONLY the WorkerW wallpaper window (WE's D3D render) without desktop
# icons / taskbar. Usage: capture-workerw.ps1 <out.png>
param(
  [Parameter(Mandatory = $true)][string]$OutPath
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class WorkerWCap {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")]
  public static extern bool SendMessageTimeoutW(IntPtr hWnd, uint msg, UIntPtr wParam, UIntPtr lParam, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll")]
  public static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassNameW(IntPtr hWnd, StringBuilder name, int max);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")]
  public static extern IntPtr GetWindowDC(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool BitBlt(IntPtr dst, int xd, int yd, int w, int h, IntPtr src, int xs, int ys, uint rop);
  [DllImport("user32.dll")]
  public static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  public static List<string> Debug = new List<string>();
  public static IntPtr FindWorkerW() {
    IntPtr progman = FindWindowW("Progman", null);
    Debug.Add("progman=0x" + progman.ToString("X"));
    if (progman == IntPtr.Zero) return IntPtr.Zero;
    // WE renders into its own D3D child of Progman (behind the icon view);
    // fall back to the classic WorkerW when that window is absent.
    IntPtr wpe = IntPtr.Zero, worker = IntPtr.Zero;
    EnumChildWindows(progman, (h, lp) => {
      var sb = new StringBuilder(64);
      GetClassNameW(h, sb, 64);
      var cls = sb.ToString();
      Debug.Add("child 0x" + h.ToString("X") + " cls=" + cls + " vis=" + IsWindowVisible(h));
      if (cls == "WPEDesktopDX11Window") wpe = h;
      else if (cls == "WorkerW" && IsWindowVisible(h)) worker = h;
      return true;
    }, IntPtr.Zero);
    if (wpe != IntPtr.Zero) return wpe;
    return worker;
  }
}
"@

$workerw = [WorkerWCap]::FindWorkerW()
[WorkerWCap]::Debug | ForEach-Object { Write-Host $_ }
if ($workerw -eq [IntPtr]::Zero) { throw "WorkerW not found" }

$rect = New-Object WorkerWCap+RECT
[WorkerWCap]::GetWindowRect($workerw, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
Write-Host "WorkerW $workerw rect $($rect.Left),$($rect.Top) ${w}x${h}"

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [WorkerWCap]::PrintWindow($workerw, $hdc, 2)  # PW_RENDERFULLCONTENT
if (-not $ok) { $ok = [WorkerWCap]::PrintWindow($workerw, $hdc, 0) }
$g.ReleaseHdc($hdc)
$g.Dispose()

if (-not $ok) { throw "PrintWindow failed" }
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "saved: $OutPath"
