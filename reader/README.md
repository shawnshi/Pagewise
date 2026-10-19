# 知页阅读器 · Pagewise

面向 Android 墨水屏设备的本地阅读应用，基于 LightRead v1.15.0 二次开发。当前源码版本 **1.1.0**；Android Release 与独立 Debug 已完成安装和启动检查，完整的实体面板与长时间听书验收仍未完成。

## 开始阅读

1. 授权需要监测的书籍目录，应用按源文件引用建立书库。请只授权你希望阅读器访问的范围。
2. 在书库中搜索、按标签或阅读状态筛选并打开书籍。当前支持 EPUB、MOBI、PDF、TXT 和 Markdown。
3. 阅读时主导航隐藏；使用目录、进度、书内搜索、排版设置、划线与笔记。返回列表后恢复筛选和位置。
4. 源目录权限失效或扫描失败会保留错误状态，不据此清空书库、笔记或手工标签。阅读器不提供删除或修改源书籍的接口。

当前不提供桌面/iOS 产品、账号或云同步。手动导入入口、书单、显式 EPUB 转换和论文专用工作区已退役；旧数据兼容及 TXT/Markdown 的内部阅读适配仍保留。浏览器只是开发和合成测试入口，不是独立 Web/PWA 产品。

## 听书、阅读模式与 PDF

系统听书使用 Android 原生队列与后台串行状态处理；阅读模式提供大字、排版和墨水屏适配。系统音色的可用性取决于设备 TTS 引擎，在线音色另需网络。连续息屏长听、故障恢复与耗电尚未完成最终验收。

PDF 保留 PDFium 与 MuPDF 双引擎。1.1.0 将栅格化移入 Worker，限制并发和位图/几何缓存，并保护可见页；部分初始化、文本和交互仍在主线程，不能保证所有 PDF 的打开或翻页延迟。大文本转换同样使用 Worker，书库查询和页面生命周期也已做定向优化。

## 阅读助手与点睛

端点、密钥和模型需自行配置并核验可用性。内置点睛通道要求匹配的服务端提示词版本；协议不兼容时明确拒绝，不自动切换服务。API、在线音色及用户配置的远端端点可能发送所选内容，本地阅读和测试通过不代表远端服务或输出已验证。

更新 APK 或源码不会自动部署 relay。运行配置、账户字段、签名材料和真实书库不提交源码仓库。

## 开发与验证

Vue/Tauri 应用、Android 模板和测试脚本位于本目录。`src-tauri/gen/` 是生成工程，不提交；原生模板位于 `src-tauri/android/`。

```sh
npm ci
npm run dev
npm run build
```

Android 还需要 JDK 21、Android SDK API 36、兼容 NDK 和 Rust Android 目标；当前 Gradle 8.14 不支持 Java 25。Release 与 Debug 使用不同包名和私有数据；正式包升级必须保持包名、原证书及递增 versionCode，不能用卸载、清数据或复制真实书库来替代。

[完整构建与验证说明](https://github.com/shawnshi/Pagewise/blob/main/readme.md)

[部署与签名](https://github.com/shawnshi/Pagewise/blob/main/docs/deployment.md) · [1.1.0 安装记录](https://github.com/shawnshi/Pagewise/blob/main/docs/deployment-1.1-status.md) · [性能状态与未完成项](https://github.com/shawnshi/Pagewise/blob/main/docs/performance-implementation.md) · [阅读协议](https://github.com/shawnshi/Pagewise/blob/main/docs/reading-assistant-prompts.md)

## 许可

保留上游作者 yzfly／云中江树署名，阅读器沿用 [AGPL-3.0-or-later](https://github.com/shawnshi/Pagewise/blob/main/reader/LICENSE) 与第三方许可。分发 APK 时应提供对应源码。外围文档或脚本许可不替代上游阅读器许可。
