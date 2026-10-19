# 知页阅读器 · Pagewise

面向 Android 墨水屏设备的本地阅读应用，基于 [LightRead v1.15.0](https://github.com/yzfly/LightRead/tree/v1.15.0) 二次开发。

源码版本 **1.1.0**。Release 与 Debug 已在文石 Note X3 Pro 上并行安装并完成启动检查。当前仅面向 Android；浏览器用于开发预览和合成测试，不是独立 Web/PWA 产品。本次仓库同步只交付源码，不自动发布 GitHub Release 或上传 APK。

## 阅读与书库

- 通过 Android SAF 授权监测目录，按源文件引用建立书库。扫描不完整或权限丢失时保留错误状态，不把失败当作空目录，也不因此删除书目、笔记或手工标签。
- EPUB、MOBI、PDF、TXT、Markdown 阅读；TXT/Markdown 保留内部适配路径，普通 PDF 保留 PDFium 与 MuPDF 双引擎。
- 搜索、标签、组合筛选、分页、阅读状态、进度与列表返回状态恢复。
- 中英文排版、书内搜索、划线、笔记、目录和阅读锚点；常规页面使用底部五入口，阅读时隐藏主导航。
- Android 原生系统听书、阅读模式与墨水屏布局。原生队列已实现，但连续息屏长听、故障恢复和耗电仍待最终验收。
- 阅读助手、选文解读和点睛阅读。端点、密钥与模型需自行配置；内置点睛通道校验服务端提示词版本，不兼容时明确拒绝，不自动切换服务。在线能力不可用时不应伪装成功。

不提供桌面/iOS 产品、账号或云同步。书单、手动导入入口、显式 EPUB 转换和论文专用工作区已退役；必要的旧数据兼容与 TXT/Markdown 阅读适配仍保留。

## 1.1.0 性能改动与限制

- 系统听书状态和持久化由单一后台线程串行处理。
- SAF 枚举与交互读取分离；阅读生命周期由 App 统一管理，阅读期间暂缓后台扫描。
- 书库复用归一化、排序和会话查询结果。
- PDF 栅格化使用 Worker、有界调度、96 MiB 位图预算和 8 MiB 几何 LRU；可见页受缓存淘汰保护。
- 大文本转换进入 Worker；减少重复排版等待，修复非动画翻页锁和延迟关闭的生命周期问题。

上述改动已完成定向宿主测试、真实浏览器检查和独立审查。Android 安装、启动及原生/前端计时接口也已检查，但**不代表五阶段性能目标全部完成**：PDF 部分初始化、交互和文本工作仍在主线程；实体设备翻页尾延迟、清晰度、残影及长时间听书仍待验收。详见[性能实现状态](docs/performance-implementation.md)。

## 从源码开发

应用源码位于 `reader/`。建议 Node.js 24+，Vite 要求 `^20.19.0 || >=22.12.0`：

```sh
cd reader
npm ci
npm run dev       # 浏览器开发预览
npm run build     # Vue/TypeScript 检查与前端生产构建
```

Android 构建还需 JDK 21、Android SDK API 36、兼容 NDK 与 Rust `aarch64-linux-android` 目标。本次构建使用 NDK 30.0.16248370。当前 Gradle 8.14 不兼容 Java 25；仅为构建子进程选择 JDK 21，无需修改全局 Java 配置。

```sh
npm run android:init -- --ci --skip-targets-install
npm run android:prepare
npm run android:build           # Debug
npm run android:build:release   # Release；签名与交付校验见部署文档
```

`src-tauri/gen/` 是生成工程，原生模板在 `reader/src-tauri/android/`。通用 Release 构建入口不自动携带本机签名配置；不能把 unsigned APK 当作可覆盖安装的交付物。

Release 包名为 `io.pagewise.reader`，Debug 为 `io.pagewise.reader.debug`，各用独立私有数据。覆盖升级必须保持正式包名、原证书和递增 versionCode；不卸载、不清数据，也不自动复制书库或账户配置。见[部署与签名约定](docs/deployment.md)及[1.1.0 安装记录](docs/deployment-1.1-status.md)。

## 测试与验证

```sh
cd reader
npm run test:android-only
npm run test:library
npm run test:feature-trim
node --experimental-strip-types --test scripts/test-device-performance.mjs
```

浏览器测试按脚本使用本机浏览器与新上下文，只用合成数据，不加载个人浏览器配置。性能比较脚本可能需要另行准备冻结基线；不要把缺失的本地报告或基线当作通过。`npm run e2e` 的旧手动导入场景已经过时，不作为当前产品的验收入口。

- [当前验证状态与已知缺口](docs/validation-status.md)
- [性能实现与测量边界](docs/performance-implementation.md)
- [设备准入与历史合成验收边界](docs/device-admission.md)
- [阅读助手与点睛协议](docs/reading-assistant-prompts.md)
- [历史审计记录](docs/audit-20261018.md)

`.cache/`、`.worktrees/`、构建产物、依赖、合成书籍和本机验收证据不提交仓库；签名文件、凭据和真实书库也不入库。

## 数据与许可

目录授权用于读取书籍源，不提供源文件写入或删除接口。AI、在线音色和用户配置的远端端点可能发送所选书籍内容；本地阅读或宿主测试通过，不代表远端服务、隐私边界或模型输出已经验证。APK 更新不会自动部署 relay。

保留 LightRead 作者 yzfly／云中江树署名。阅读器沿用 [AGPL-3.0-or-later](reader/LICENSE)，并保留第三方许可；分发 APK 时应提供对应源码。仓库外围文档与脚本的许可声明不能替代上游阅读器许可。项目源码：[shawnshi/Pagewise](https://github.com/shawnshi/Pagewise)。
