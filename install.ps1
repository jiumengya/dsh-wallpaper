# dsh-wallpaper 插件安装脚本
# 把插件包装进 DshNative 运行时、建立 farm junction、生成数据目录 overlay。
# 用法:右键"使用 PowerShell 运行",或 powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = 'Stop'

$pkgName = 'dsh-wallpaper'
$pluginId = 'wallpaper'
$srcPkg = Join-Path $PSScriptRoot 'pkg'
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'DshNative\runtime\node_modules\@deepseek-ai'
$runtimePkg = Join-Path $runtimeRoot $pkgName
$farmRoot = Join-Path $env:USERPROFILE '.dsh\profiles\node_modules\@deepseek-ai'
$farmLink = Join-Path $farmRoot $pkgName
$dataYml = Join-Path $env:LOCALAPPDATA 'DshNative\desktop.yml'

function Find-AppDesktopYml {
    $guid = '{7C9F3A54-1E2B-4D8C-9A6F-0B3D5E8A2C41}_is1'
    $keys = @(
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$guid",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\$guid"
    )
    foreach ($k in $keys) {
        try {
            $loc = (Get-ItemProperty $k -ErrorAction Stop).InstallLocation
            if ($loc) {
                $yml = Join-Path $loc 'desktop.yml'
                if (Test-Path $yml) { return $yml }
            }
        } catch {}
    }
    foreach ($d in @(
        "${env:ProgramFiles}\DeepSeek Harness",
        "${env:ProgramFiles(x86)}\DeepSeek Harness",
        'D:\dshcode\DeepSeek Harness',
        'E:\DeepSeek Harness'
    )) {
        $yml = Join-Path $d 'desktop.yml'
        if (Test-Path $yml) { return $yml }
    }
    return $null
}

# ── 1. 复制插件包到运行时 ─────────────────────────────────────────
if (-not (Test-Path (Join-Path $srcPkg 'lib\index.js'))) {
    throw "找不到插件包源:$srcPkg\lib\index.js"
}
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
if (Test-Path $runtimePkg) { Remove-Item -Recurse -Force $runtimePkg }
Copy-Item -Recurse $srcPkg $runtimePkg
Write-Host "[1/3] 插件包已复制到 $runtimePkg"

# ── 2. 建立 farm junction(profile 解析依赖链接) ─────────────────
New-Item -ItemType Directory -Force -Path $farmRoot | Out-Null
if (Test-Path $farmLink) {
    $item = Get-Item $farmLink -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        $item.Delete()
    } else {
        throw "存在同名普通目录(非链接):$farmLink — 请手动确认后删除再安装。"
    }
}
New-Item -ItemType Junction -Path $farmLink -Target $runtimePkg | Out-Null
Write-Host "[2/3] 已建立依赖链接 $farmLink -> $runtimePkg"

# ── 3. 生成数据目录 overlay(DataDir 优先于应用目录,免管理员权限) ──
$entry = @"

# Wallpaper Engine 壁纸工具:列出/应用/控制壁纸(见 plugins\dsh-wallpaper)。
- insert:
    - id: $pluginId
      name: '@deepseek-ai/$pkgName'
"@
if (Test-Path $dataYml) {
    $content = [IO.File]::ReadAllText($dataYml)
    if ($content.Contains('@deepseek-ai/' + $pkgName)) {
        Write-Host "[3/3] overlay 已包含插件条目,跳过"
    } else {
        [IO.File]::WriteAllText($dataYml, $content.TrimEnd("`r`n") + $entry + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "[3/3] 已追加插件条目到 $dataYml"
    }
} else {
    $appYml = Find-AppDesktopYml
    if ($appYml) {
        $content = [IO.File]::ReadAllText($appYml)
        [IO.File]::WriteAllText($dataYml, $content.TrimEnd("`r`n") + $entry + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "[3/3] 已从应用 overlay($appYml)生成 $dataYml"
    } else {
        $fallback = "# DshNative 桌面 overlay(安装脚本生成;未找到应用原版,以下是内置副本)`r`n" +
            "- id: session-log-download`r`n  disabled: true`r`n" +
            "- insert:`r`n    - id: browser-use`r`n      name: '@deepseek-ai/dsh-browser-use'`r`n      config:`r`n        headless: false`r`n"
        [IO.File]::WriteAllText($dataYml, $fallback + $entry + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "[3/3] 未找到应用 overlay,已用内置副本生成 $dataYml(建议检查内容)"
    }
}

Write-Host ""
Write-Host "安装完成。重启 DeepSeek Harness 后生效;对 agent 说「换一个xxx壁纸」即可。"
Write-Host "卸载:运行 uninstall.ps1"
