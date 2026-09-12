# dsh-wallpaper 插件卸载脚本
# 移除运行时插件包、farm 链接,并删除数据目录 overlay(恢复应用自带 overlay)。

$ErrorActionPreference = 'Stop'

$pkgName = 'dsh-wallpaper'
$runtimePkg = Join-Path $env:LOCALAPPDATA "DshNative\runtime\node_modules\@deepseek-ai\$pkgName"
$farmLink = Join-Path $env:USERPROFILE ".dsh\profiles\node_modules\@deepseek-ai\$pkgName"
$dataYml = Join-Path $env:LOCALAPPDATA 'DshNative\desktop.yml'

if (Test-Path $runtimePkg) {
    Remove-Item -Recurse -Force $runtimePkg
    Write-Host "[1/3] 已移除运行时插件包 $runtimePkg"
} else {
    Write-Host "[1/3] 运行时插件包不存在,跳过"
}

if (Test-Path $farmLink) {
    $item = Get-Item $farmLink -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        $item.Delete()
        Write-Host "[2/3] 已移除依赖链接 $farmLink"
    } else {
        Write-Host "[2/3] $farmLink 是普通目录,未动;请手动确认"
    }
} else {
    Write-Host "[2/3] 依赖链接不存在,跳过"
}

if (Test-Path $dataYml) {
    Remove-Item -Force $dataYml
    Write-Host "[3/3] 已删除 $dataYml(应用将恢复使用安装目录自带 overlay)"
} else {
    Write-Host "[3/3] overlay 不存在,跳过"
}

Write-Host ""
Write-Host "卸载完成。重启 DeepSeek Harness 后生效。"
