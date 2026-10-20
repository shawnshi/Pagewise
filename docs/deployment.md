# Android 单机部署与签名

当前范围是侧载部署到 Note X3 Pro，不是应用商店发行。**当前 Release 与 Debug 均为 1.4.0 / 1004000**，已同签名覆盖安装并通过前端启动就绪检查；桌面名称分别为 **知页**、**知页 1.4.0 测试版**。包摘要、验证范围和限制见 [1.4.0 安装记录](deployment-1.4-status.md)。书籍读取与文件夹扫描问题尚未确认修复，安装和启动检查不能代替这些场景验收。

## 构建与包身份

先准备 JDK 21、Android SDK API 36、兼容 NDK 与 Rust Android 目标。当前 Gradle 8.14 不支持 Java 25；只调整构建进程的环境，不修改系统 Java/SDK。原生模板位于 `reader/src-tauri/android/`，`src-tauri/gen/` 为生成目录。

```sh
cd reader
npm ci
npm run android:init -- --ci --skip-targets-install
npm run android:prepare
npm run android:build           # Debug
npm run android:build:release   # Release
```

通用 Release 入口不会自动携带本机签名配置，可能生成 unsigned APK。不得把 unsigned APK 当作已签名交付物，也不得把超时写成顶层构建命令成功。若采用分阶段构建，只能复用已校验且与源码绑定的产物，保留实际任务结果，不能任意跳过未完成的编译步骤。

- 正式包名固定为 `io.pagewise.reader`，显示名称保持“知页”；Debug 使用 `io.pagewise.reader.debug`，显示名称为“知页 {完整版本号} 测试版”，私有数据相互独立。
- 覆盖升级保持正式包名、既有证书及递增 versionCode；不卸载、不清数据、不自动复制书库或账户设置。
- 切换 Debug/Release 不会自动迁移数据。确需迁移时另行授权并验证应用支持的导出/导入流程。
- Release 应开启 R8，关闭 debuggable。APK 更新与 GitHub main 推送都不会自动部署 relay。

## 签名材料

本次个人侧载复用既有本机证书以保持升级连续性；证书容器的历史文件名仍为 `debug.keystore`，不代表生成一个新 debug key 就能覆盖安装，也不是生产签名方案建议。

- 私钥、签名容器、口令和备份位置不提交源码仓库，不放入资源打包目录。
- 换机器前安全备份原签名材料。缺失时停止签名，不通过重新生成、卸载或清数据绕过覆盖失败。
- 新机器恢复签名材料后，先验证证书，再构建或安装。使用标准签名工具的认证提示，不把口令写在文档、命令行或日志中。

```sh
apksigner verify --print-certs /path/to/signed-candidate.apk
```

## 安装检查与回退

安装前核对 ZIP CRC、包名、版本、ABI、SDK、debuggable、签名及源码/原生库绑定；安装后核对设备 `base.apk` 与候选包摘要一致，再做实际启动检查。包名、证书或版本不符时停止，不退回“先卸载再装”。

正式包不保证允许版本降级。需要恢复旧代码时，应使用同证书、递增 versionCode 的恢复包，并单独核验数据兼容性；旧 APK 文件本身不是可靠回退方案。

计时探针默认关闭，只在 Activity 创建时通过 `io.pagewise.reader.PERF_PROBE=true` 显式启用。热 Intent 不能证明探针已启用；测试后正常重启并明确关闭。探针仅记录固定数值标签，不输出书名、正文或 CFI；它测量软件事件到提交，不测面板显影或触摸硬件延迟。

## 验收边界与分发

- Activity 启动、计时接口 ready、宿主测试或浏览器 Worker 检查不等于实体墨水屏翻页、清晰度、残影或连续息屏听书通过。
- SAF 持久授权跨固件更新的保留、长期后台行为、其他 Android 版本及远端服务，需要各自验证；不从本次安装结果外推。
- 旧离线 TXT/PDF 听书与音频焦点试验保留在[验证记录](validation-status.md)，不能代替新包的长时间验收。
- 分发 APK 时保留上游署名、第三方许可和对应源码，并说明 AI、在线音色及用户配置远端端点的数据流向。详见[性能状态](performance-implementation.md)和[阅读协议](reading-assistant-prompts.md)。
