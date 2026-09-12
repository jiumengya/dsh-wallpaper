# dsh-wallpaper —— DeepSeek Harness 的 Wallpaper Engine 插件

让桌面版 DeepSeek Harness 接入 Wallpaper Engine:在**设置面板的「壁纸」分区**里把任意壁纸设为 **DeepSeek Harness 应用背景**(视频壁纸直接回放原视频);同时给 agent 提供 4 个操作桌面 Wallpaper Engine 的工具。

## 前置条件

- 已安装 Steam 与 Wallpaper Engine(任意 Steam 库位置均可,自动发现)
- 已安装 DshNative 桌面应用(rc.17 或更新)

## 安装

右键 `install.ps1` → **使用 PowerShell 运行**(或:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

脚本做三件事:
1. 把插件包复制到 `%LOCALAPPDATA%\DshNative\runtime\node_modules\@deepseek-ai\dsh-wallpaper`
2. 建立 `~\.dsh\profiles\node_modules\@deepseek-ai\dsh-wallpaper` junction(profile 解析需要)
3. 生成 `%LOCALAPPDATA%\DshNative\desktop.yml` overlay(数据目录 overlay 优先于应用目录,免管理员权限),在应用自带条目基础上追加本插件

**重启 DeepSeek Harness 后生效。**

## 使用

**换应用背景(图形界面)**:点击左侧栏底部的 ⚙ 设置按钮,左侧导航里点 **壁纸** 分区——顶部显示当前背景,搜索框过滤标题,下方是预览图网格:**点任意卡片即把它设为整页背景**(整个界面连同侧栏后方都透出壁纸,不加任何遮罩)。「恢复默认」一键还原。卡片类型标注了动效支持:**网页类=完整动效、视频类=动效、场景类=粒子实时动画**(场景是 Wallpaper Engine 专有格式,浏览器无法原生渲染;后端从 scene.pkg 提取图层合成静态底图,粒子系统导出为纯数据定义由前端 canvas 逐帧实时模拟——花瓣/雪/光尘在整页飘动,与 Wallpaper Engine 同源的物理语义;骨骼绑定动画等更复杂的效果仍只有网页/视频类)。每张卡片缩略图右上角还有一个悬停出现的「桌面」小按钮,可顺手把它设为桌面壁纸(走 Wallpaper Engine)。选择持久化在 `~\.dsh\plugin-wallpaper-ui.json`,重启后自动恢复。

对 agent 说自然语言也可以(操作的是**桌面** Wallpaper Engine):

- 「列一下我装了哪些壁纸」
- 「换个壁纸,要初音未来相关的」
- 「现在用的是什么壁纸」
- 「暂停壁纸」「壁纸静音」「隐藏桌面图标」「切下一个壁纸」

提供的 4 个工具:

| 工具 | 作用 |
|------|------|
| `wallpaper_list` | 列出已安装壁纸(id/标题/类型),支持标题过滤 |
| `wallpaper_apply` | 按 workshop id 或标题应用壁纸,可选显示器;未运行时自动启动 Wallpaper Engine,应用后回读配置确认 |
| `wallpaper_control` | pause / play / stop / mute / unmute / next / close / hide_icons / show_icons |
| `wallpaper_current` | 查看当前壁纸(路径 + 标题) |

## 配置(可选)

Steam 或 Wallpaper Engine 装在特殊位置时,编辑 `%LOCALAPPDATA%\DshNative\desktop.yml` 中插件条目:

```yaml
- insert:
    - id: wallpaper
      name: '@deepseek-ai/dsh-wallpaper'
      config:
        steamPath: 'E:\Steam'            # Steam 根目录(默认:注册表自动发现)
        wallpaperEnginePath: ''           # wallpaper64.exe 完整路径(默认:Steam 库自动发现)
```

## 卸载

右键 `uninstall.ps1` → **使用 PowerShell 运行**。移除插件包与链接,并删除数据目录 overlay(应用恢复使用安装目录自带 overlay)。

## 说明

- **应用背景实现(整页,两种挂载方式)**:设置选中后官方 UI 的大面积不透明背景全部透明化(`--dsw-alias-bg-base`、`--dsw-specific-sidebar-fill`,输入框 `--dsw-specific-input-major` 改为半透明玻璃色,明暗主题各一套)——壁纸贯穿整个页面包括侧栏后方;消息卡片等内容面板保留自身背景保证可读性,无任何叠加纱罩。**图片/场景壁纸直接画成 `body` 自身的不透明根背景**(CSS 双层堆叠:场景合成图盖在工作坊方形预览图上,最底是不透明兜底色;预览层在首次场景提取的数秒间先行铺底,真图就绪后盖上去,真图不可用时自然回落到预览)——根背景透明会让 Chromium 全文档关闭子像素抗锯齿(ClearType),灰度渲染的字形就是"壁纸文字发虚"的根因,不透明根背景把彩色子像素渲染找回来(端到端实测文字边缘彩色占比 56-60%,灰度渲染时接近 0)。**视频/网页壁纸仍走 `body` 下的 `position:fixed; z-index:-1` 背景层**(`<video>`/`<iframe>` 无法做 CSS 背景),其上文字保持灰度渲染是 Chromium 的固有约束。**弹窗(设置/Modal)是液态玻璃且壁纸保持动态**:弹窗打开时壁纸动画继续跑(弹窗只是浮在上面);面板为静态绘制的液态玻璃(82% 半透明底 + 160° 镜面渐变高光 + 1px 亮边 + 内光晕,明暗主题两套),遮罩减淡到 45%。**刻意不用 backdrop-filter**:Chromium 中任何 backdrop-filter 元素覆盖在视频/iframe 壁纸上时会冻结其动画帧(官方遮罩自带的 blur(2px) 也在其列),全部显式禁用,玻璃质感靠多层静态样式表达。
- **局部自适应反色(暗壁纸可读性)**:客户端把壁纸按区域采样亮度(64×36 canvas,左侧 22% 为侧栏区、其余为主区;视频每 2 秒重采样,图片/网页壁纸取预览图采一次),侧栏区和主区各自独立判断:浅色主题下壁纸偏暗(<0.38)→ 该区域的文字/图标翻成官方暗色主题的墨色(近白);暗色主题下壁纸偏亮(>0.62)→ 翻回浅色主题墨色;中间调保持主题默认。作用域只覆盖直接坐在壁纸上的两块——侧栏(`[class*='sidebarCol']`)和空状态 hero(`[class*='_composerHero']`),新会话按钮(自带白底)排除在外;输入框玻璃在冲突时增浓到 86% 保深色文字可读。即"壁纸暗→字变白,壁纸亮→字变黑",自动跟随视频播放的明暗变化。
- **进程稳定性(流式与子进程)**:视频/静态文件流式响应全部挂错误监听(`stream.on('error')` 销毁响应、`res.on('close')` 销毁流——浏览器切壁纸/隐藏标签页会随时中断背景视频请求,未消费的错误事件会打死整个后端进程);`startWallpaperEngine` 的 detached spawn 补 error 监听(exe 路径失效是异步 'error' 事件,同样会崩进程);JSON/文本响应在 headers 已发出后不再二次 writeHead。
- **三种渲染模式**(按壁纸类型自动选择):视频壁纸播原视频(`<video>`,4K 原画质);**网页壁纸用 iframe 加载其 html 入口,壁纸自身的动效、粒子效果原生运行**(spine 骨骼动画、canvas 粒子等);**场景壁纸 = 静态底图 + 粒子实时动画**:后端从 scene.pkg 提取合成无粒子的图层底图(`?flat=1`),粒子系统编译为纯数据定义(`/scene-anim/<id>` JSON + `/scene-anim-tex/<id>/<idx>` 纹理图集,scene-art.js:发射器/初始化器/操作符语义,含 alpha/size/color 各 33 点曲线与振荡频率区间),前端 `#dshWpAnim` 叠层(`z-index:-1`,pointer-events none)canvas 逐帧模拟——年龄推进/重生、解析弹道积分(重力/阻力/涡旋)、参考实现语义的角速度积分、X/Y 轴独立随机振荡、雪碧表帧动画、逐粒子染色缓存;**canvas 每帧先重绘底图再混粒子,additive 混合(`lighter`)直接加在真实场景像素上**(透明叠层会让 additive 纹理的黑底经元素级合成显形为黑方块);封面变换与 body 背景一致,dpr≤2 超采样;导出不可用或底图解码失败时自动回落烘焙稳态合成图(纹理链支持 RGBA/DXT1/3/5/RG88/R8/JPEG + LZ4——约 1/4 场景壁纸的主图层是 JPEG-in-TEX,由内置 jpeg-js 解码器(vendored,Apache-2.0)光栅化,不丢层;共享粒子纹理回退到 WE assets 库;提取在 worker 线程,磁盘缓存 v5)。
- 网页壁纸的静态资源( html/js/css/图片/字体/内嵌视频)由宿主半边 `/plugin-wallpaper/web/<id>/<路径>` 流式服务(支持 HTTP Range,路径 resolve 后做前缀校验防目录穿越,非文件返回 404)。
- 控制走 Wallpaper Engine 官方命令行接口(`wallpaper64.exe -control ...`),读取当前壁纸走其 `config.json`(实测 `-control getWallpaper` 的输出无法从外部进程捕获)。
- 壁纸列表每次调用实时扫描 workshop 目录,安装新壁纸无需重启。
- 应用壁纸对 scene/video/web 类型统一传 `project.json` 路径(官方文档支持)。
