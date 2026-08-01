NapCat Framework + QQ Chat Exporter
NapCat 版本: v4.18.5
QCE 版本: 5.5.67
构建时间: 2026-06-04 08:51:01

这是 Framework 模式的完整包，适合想让 QCE 和正在使用的 QQ 一起运行的场景，比如定时任务、后台备份。

两种使用方式:

方式 A: 直接运行 napiLoader.bat（推荐）
这条路不要求先安装 LiteLoaderQQNT。
1. 解压 NapCat-Framework-QCE-v5.5.67.zip
2. 如果当前 QQ 正在运行，先完全退出 QQ
3. 在解压后的目录里运行 napiLoader.bat
4. 如果 QQ 弹出登录页，按平时的方式登录 QQ
5. 访问 http://localhost:40653/qce-v4-tool

方式 B: LiteLoaderQQNT 插件方式（只有明确要这样装时才用）
只有这条路才要求先安装 LiteLoaderQQNT。
1. 先按 LiteLoaderQQNT 官方文档完成安装: https://liteloaderqqnt.github.io/
2. 装好以后，确认 QQ 设置左侧已经出现 LiteLoaderQQNT
3. 再按 LiteLoaderQQNT / NapCat 的插件安装方式去部署这个包

如果你只是普通使用，优先走上面的 napiLoader.bat 路线就可以。

如何找到 token:
按 Win + R，输入 %USERPROFILE%\.qq-chat-exporter 并回车，打开 security.json 文件，找到 accessToken 字段。
