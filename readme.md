# 知页阅读器 · Pagewise

面向文石（Onyx BOOX）Android 墨水屏设备的本地阅读应用，基于 [LightRead v1.15.0](https://github.com/yzfly/LightRead/tree/v1.15.0) 二次开发。当前版本为 **1.4.0**，Android 版本码为 **1004000**。

项目只面向 BOOX Android 设备。浏览器用于界面开发和合成测试，不提供桌面、iOS 或 PWA 发行版。

## 当前状态

已在 **Note X3 Pro（Android API 32）** 上同签名覆盖安装两个版本：

| 变体 | 显示名称 | 包名 |
|---|---|---|
| Release | 知页 | `io.pagewise.reader` |
| Debug | 知页 1.4.0 测试版 | `io.pagewise.reader.debug` |

两版包名和私有数据目录分离。1.4.0 已包含伴读命名统一、书库筛选位置调整，以及 AI 服务与模型选择变更。

**已验证**：前端构建、两版原生构建、Release R8、APK 名称与版本、签名、安装包摘要、升级前后数据目录身份，以及两版前端启动就绪；本轮另执行了 138 项回归测试。没有卸载或清除应用数据。详见 [1.4.0 部署记录](docs/deployment-1.4-status.md)。

**已知限制**：设备上书籍无法打开和文件夹扫描出错的问题，根因仍未确认，不能把本次打包或启动成功当作修复证明。EPD 刷新、前光、手写、合盖恢复、完整原生加速链路和真实 AI 服务调用也未完成专项真机验收。

## 功能范围

- **书库**：授权目录监测、手动导入、分类、筛选和排序；目录访问依赖 Android SAF 授权。
- **阅读**：EPUB、MOBI、PDF、TXT、Markdown 等格式的解析与阅读入口，以及目录、排版、进度、查找和批注相关功能。格式支持不等于所有文件都已通过真机验证。
- **伴读与阅读助手**：章节理解、提问和分层阅读等交互；服务选择与授权由用户控制。
- **AI 服务**：保留内置试用、DeepSeek、OpenAI、Gemini、OpenRouter，支持模型下拉选择和保留已保存型号。模型目录是带核验日期的内置列表，不自动联网更新，也不保证始终是最新型号。见 [AI 服务说明](docs/ai-services.md)。
- **听书**：提供系统语音、离线和网络引擎相关入口；可用性取决于设备、模型和网络配置。
- **BOOX 适配**：包含硬件按键、刷新、前光、笔迹和原生文件处理桥接。接口存在不代表对应硬件能力已经验收。

切换 AI 服务不会把其他服务的密钥复制过去，也不会自动把已退役服务切换到试用通道。伴读运行时统一使用 `PagewiseCompanion` 命名；旧配置、缓存和 relay 协议中的兼容字段按契约保留，不应机械批量改名。见 [伴读命名与兼容说明](docs/companion-naming.md)。

## 架构与数据

| 层 | 主要实现 | 职责 |
|---|---|---|
| 界面与阅读逻辑 | Vue、TypeScript、Vite | 书库、阅读视图、排版、伴读和设置 |
| 应用容器 | Tauri 2、Rust、SQLite | Android 应用封装、持久化与受控原生命令 |
| Android 适配 | Kotlin、Android API、BOOX 反射桥接 | SAF、生命周期、硬件能力探测与原生处理入口 |

电子书阅读使用 `foliate-js` 等现有组件；PDF 包含 MuPDF、PDFium 和 Worker 相关处理代码。Android `PdfRenderer` 也有桥接入口，但不能据此声称它已经替代整个 PDF 阅读主链路。

BOOX 桥接通过反射探测设备 API。不同机型、固件或 SDK 可见性可能导致能力不可用；当前不能宣称完整接入了文石 SDK，或已经达到固定刷新延迟。

原生层包含外部 URI 暂存、ZIP 检索和阅读恢复点等接口。这里不把这些入口写成“零拷贝”“防丢”或已闭环的性能承诺，实际链路仍需逐项验证。

应用在 Android 私有目录管理索引、源文件和缓存，轻量设置使用 WebView `localStorage` 等现有存储方式。目录监测引用的原书依赖持续有效的 SAF 权限；应用私有数据、源书和导出备份是不同对象，不应混为一份备份。

### 目录

```text
Pagewise/
├── readme.md                   # 项目唯一总说明
├── docs/                       # 架构、部署和验证记录
├── .github/workflows/          # 仓库工作流
└── reader/
    ├── package.json            # 前端及 Android 命令
    ├── src/                    # Vue 界面、服务与存储适配
    ├── src-tauri/
    │   ├── src/                # Rust 命令与容器逻辑
    │   ├── android/            # 受管 Kotlin 模板
    │   ├── gen/android/        # 本地生成的 Android 工程
    │   ├── Cargo.toml
    │   └── tauri.conf.json
    ├── scripts/                # 准备、构建检查与测试
    ├── relay/                  # 可选 AI 中继服务
    └── docs/                   # 使用手册与功能专题
```

生成工程、构建缓存、APK 和签名材料不随源码提交。可复用的 Android 行为应维护在受管模板和准备脚本中，而不是只修改生成工程。

## 开发与构建

### 环境

需要 Node.js/npm、Rust，以及 Android 构建使用的 JDK、SDK 和 NDK。1.4.0 本地部署使用 Node.js 25.9.0、JDK 21、Android SDK 36 和 NDK `30.0.16248370`；这是已使用的环境记录，不代表其他组合已经验证。

先在仓库根目录执行：

```bash
cd reader
npm ci

# 浏览器开发预览，不等同于 Android 功能验收
npm run dev

# Vue/TypeScript 检查与前端生产构建
npm run build
```

配置 Android SDK/NDK 路径，并安装 Rust Android 目标后：

```bash
rustup target add aarch64-linux-android

# 首次生成 Android 工程
npm run android:init

# 准备原生模板、版本属性及两版名称
npm run android:prepare

# Debug / Release APK
npm run android:build
npm run android:build:release
```

`android:prepare` 包含两个步骤：`prepare-android-project.mjs` 和 `prepare-android-variants.mjs`。只运行前者不会同步两版名称及版本属性。构建前必须确认 npm、Cargo、Tauri 和 Android 版本一致，并在构建后检查实际 APK 元数据。

Release 构建还需要按 [部署指南](docs/deployment.md) 配置签名。构建命令成功不代表签名与设备上的旧包一致；不要将 keystore、密码或 API Key 写入仓库。

### 侧载与升级

默认 Android APK 输出位于：

- `reader/src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk`
- `reader/src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release.apk`

本次本地封存的交付包为 `artifacts/Pagewise-1.4.0-debug.apk` 和 `artifacts/Pagewise-1.4.0-release.apk`。这些是本地产物，不随 GitHub 源码同步上传，也不代表已创建 GitHub Release。

只有在包名、版本、ABI 和签名检查通过后，才对指定设备覆盖安装：

```bash
adb -s <设备序列号> install -r -t <debug.apk>
adb -s <设备序列号> install -r <release.apk>
```

先验证 Debug，再安装正式版。签名不匹配时停止，不通过卸载或清数据绕过升级校验。降级和恢复也需独立检查版本码与数据兼容性。

## 测试与验证边界

在 `reader/` 下可运行：

```bash
npm run build
npm run test:android-only
node scripts/test-android-variants.mjs
npm run test:ai-providers
npm run test:companion
node --experimental-strip-types --test scripts/test-library-categories-sort.mjs
```

更多专项脚本见 `reader/package.json` 和 `reader/scripts/`。浏览器、Mock 和源码契约测试只能证明各自覆盖的范围，不能替代 BOOX 真机验收；原生/前端 ready 信号也不证明书籍读取、目录扫描或远端 AI 服务可用。

性能探针和详细部署证据应保留在对应测试或部署记录中，不能仅凭进程存在、接口返回或哈希一致就宣称功能完成。

## 文档入口

- [1.4.0 部署结果与限制](docs/deployment-1.4-status.md)
- [构建、签名与安装指南](docs/deployment.md)
- [Android-only 约束](docs/android-only.md)
- [Android 原生能力路线与待验项](docs/android-native-roadmap.md)
- [伴读命名与兼容契约](docs/companion-naming.md)
- [AI 服务与模型目录](docs/ai-services.md)
- [使用手册](reader/docs/manual/README.md)
- [验证状态记录](docs/validation-status.md)

## 隐私与许可

本地阅读文件和索引由应用存储管理。AI、网络听书、OPDS 和元数据等网络功能涉及各自的请求与服务端处理，使用前应检查实际授权、配置和服务条款。API Key、书库、私人日志和签名材料不应提交到项目仓库；应用沙盒也不等同于加密存储。

保留上游作者 **yzfly／云中江树** 署名，阅读器沿用 [AGPL-3.0-or-later](reader/LICENSE)。分发修改后的 APK 时，应按许可证提供对应完整源码。第三方组件遵循各自许可；中文词表来源见 [词表说明](reader/src/data/zh-lexicon.README.md)。

项目仓库：[shawnshi/Pagewise](https://github.com/shawnshi/Pagewise)。
