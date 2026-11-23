# NapCat 运行时备份

上游 `NapNeko/NapCatQQ` 有删库风险（2026-11-23 本地连不上该仓库），这里留一份能直接跑的副本。

## 为什么只备份这些

| 内容 | 是否收录 | 原因 |
|---|---|---|
| `napcat.mjs` / `package.json` / `qqnt.json` / `loadNapCat.js` | ✅ | 程序本体，没有它就跑不起来 |
| `NapCatWinBootMain.exe` / `NapCatWinBootHook.dll` | ✅ | Windows 注入启动器 |
| `launch-napcat.ps1` / `add-napcat-account.ps1` | ✅ | 本项目的启动/建号脚本 |
| `plugins/napcat-plugin-builtin` | ✅ | 内置插件 |
| `download.zip`（110 MB） | ❌ | 超过 GitHub 单文件 100 MB 限制，且可重新下载 |
| `config/` | ❌ | **含 OneBot token、QQ 号、WebUI 密码，不能进版本库** |
| `cache/`、`guild1.db*`、`*.log` | ❌ | 运行时缓存与日志 |

`config-template/onebot11_example.json` 是脱敏后的配置样板：`token` 换成 `__YOUR_ONEBOT_TOKEN__`，账号名换成 `<ACCOUNT>`。

## 恢复步骤（Windows）

1. 把本目录的文件复制到 `C:\Users\20633\NapCat\`
2. 补配置：
   - `config\onebot11_<QQ>.json` —— 抄 `config-template/onebot11_example.json`，填自己的 token 与端口
   - `config\napcat.json`、`config\napcat_<QQ>.json`、`config\napcat_protocol_<QQ>.json` —— 首次启动 NapCat 会自动生成，不用手写
   - `config\webui.json` —— 首次启动自动生成（含 WebUI 密码，不要提交）
3. 启动：`powershell -ExecutionPolicy Bypass -File launch-napcat.ps1 -QQ <QQ号>`

## 两个必须记住的配置项

- **`reportSelfMessage: true`** —— 否则 bot 读不到自己号发出的消息（自己手动发言会被当成"对方说的"，导致记忆错位）
- **`messagePostFormat: "array"`** —— 消息段用数组格式，解析代码依赖这个

## 版本

- NapCat 本体：随附 `napcat.mjs`（3.1 MB，2026-10 版本）
- 与 QQ NT 版本强绑定：如果出现 `PacketBackend 不支持当前QQ版本`，说明 QQ 升级了，需要换对应的 NapCat 版本
