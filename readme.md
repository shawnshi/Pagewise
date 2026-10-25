<p align="center">
  <img src="Pagewise.png" width="160" alt="知页阅读器 · Pagewise 项目 Logo">
</p>

# 知页阅读器 · Pagewise

面向文石（Onyx BOOX）Android 墨水屏设备的本地阅读应用。当前版本为 **1.9.0**，Android 版本码为 **1009000**。

项目只面向 BOOX Android 设备。浏览器用于界面开发和合成测试，不提供桌面、iOS 或 PWA 发行版。

## 当前状态

1.9.0 已在 **Note X3 Pro（Android API 32）** 上同签名覆盖安装两个版本：

| 变体 | 显示名称 | 包名 |
|---|---|---|
| Release | 知页 | `io.pagewise.reader` |
| Debug | 知页 1.9.0 测试版 | `io.pagewise.reader.debug` |

本版整合 Android 原生管理页与存储保护、AI 简介预览、书库推荐，以及统计/设置的墨水屏呈现改造。EPUB/PDF 正文保留现有阅读实现；两版包名和私有数据目录分离，不自动复制书库或设置。

**已验证**：实际 Vue/TypeScript 检查、Vite 构建、两版 Rust/Kotlin/assemble、Release R8、签名与 APK 身份检查通过；本轮关联测试 **67/67**。两包完成五个主页面、统计标签与设置目录的真机导航检查；Debug 自有合成 EPUB 的正文打开、翻页及正常返回保存通过。覆盖安装未卸载或清数据，安装身份保持。

**验收边界**：这是限定验证，不是完整功能回归。统计/设置原生 P1 为 27/27，其余五个预定配置尚未执行；真实 AI 服务、完整无障碍/旋转/进程死亡矩阵、物理 EPD 波形与残影仍待验证。Release 没有完整物理数据库备份或逐字段对照，不能把安装身份保持写成全部数据不变。详见 [1.9.0 功能与验证范围](docs/release-1.9.0.md)。

## 功能范围

- **原生管理页**：藏书、正在阅读、书籍详情、全部笔记、阅读统计、设置、使用手册使用 Android 原生控件，不是新增 WebView 包装。
- **书库**：授权目录监测、手动导入、原生书目/封面提取、分类与高级筛选、分页及批量操作；目录访问依赖 Android SAF 授权，未知提交不自动重放。
- **阅读**：EPUB、MOBI、PDF、TXT、Markdown 的现有解析与阅读入口，以及目录、排版、进度、查找和批注功能。EPUB/PDF 正文链路保留原有实现；格式入口存在不等于所有文件均已真机验收。
- **书籍简介**：按最小书目信息请求 AI，生成结果先预览、编辑或复制；显式确认后以 CAS 替换简介，不发送原简介、正文或批注，未知提交结果不自动重放。
- **书库推荐**：在正在阅读、书籍详情和书末提供入口；默认按本地书目与分类信息排序，不读取正文或批注、不凑数。可选 AI 需要单独同意元数据分享，失败时保留本地结果；不是外部向量嵌入服务。
- **统计与设置**：统计分为概览、趋势、年历；设置按八组目录组织。原生与 Web 开发界面使用有界布局和灰阶呈现，保留原统计口径、设置 canonical 值及提交恢复边界。
- **伴读与阅读助手**：章节理解、提问和分层阅读等交互；服务选择与授权由用户控制。
- **AI 服务**：支持用户配置的 DeepSeek、OpenAI、Gemini、OpenRouter；已移除内置试用及伴读回退，支持模型下拉选择和保留已保存型号。模型目录是带核验日期的内置列表，不自动联网更新，也不保证始终是最新型号。见 [AI 服务说明](docs/ai-services.md)。
- **听书**：提供系统语音、引擎选择与播放控制入口；具体可用性取决于设备及配置。
- **BOOX 适配**：包含硬件按键、刷新、前光、笔迹和原生文件处理桥接。接口存在不代表对应硬件能力已经验收。

切换 AI 服务不会把其他服务的密钥复制过去，也不会自动把已退役服务切到其他服务；未配置时不发 AI 请求。伴读运行时统一使用 `PagewiseCompanion` 命名；旧配置、缓存和 relay 协议中的兼容字段按契约保留，不应机械批量改名。见 [伴读命名与兼容说明](docs/companion-naming.md)。

## 架构与数据

| 层 | 主要实现 | 职责 |
|---|---|---|
| 原生管理界面 | Kotlin、Android Views | 七页管理控件、草稿离开屏障和原生导航；调用现有业务所有者 |
| 正文阅读与共享服务 | Vue、TypeScript、Vite、foliate-js | EPUB/PDF 正文、排版、伴读及可复用的非 UI 业务服务 |
| 应用容器 | Tauri 2、Rust、受保护 IPC | Android 封装、存储/任务入口与原生命令边界 |
| 原生存储与设备能力 | Kotlin、SQLite、Android API、BOOX 反射桥接 | 同一数据库、导入任务、SAF、TTS/MediaSession、窗口与 EPD 调度 |

原生页面通过受保护 IPC 复用现有业务服务，不另建书库、草稿、导入、TTS 或 EPD 所有者。PDF 书目与首封面使用原生解析能力，正文仍保留 MuPDF、PDFium 和 Worker 等现有处理链；不能将原生元数据/封面解析写成整个 PDF 阅读器已替换。

BOOX 桥接通过反射探测设备 API。不同机型、固件或 SDK 可见性可能导致能力不可用；当前不能宣称完整接入了文石 SDK，或已经达到固定刷新延迟。

原生层包含外部 URI 暂存、ZIP 检索和阅读恢复点等接口。这里不把这些入口写成“零拷贝”“防丢”或已闭环的性能承诺，实际链路仍需逐项验证。

Android 书目、批注、设置与阅读统计共用原有 `lightread.db`；既有 ID、CFI、手工分类/锁定项、阅读位置和计数保留。启动迁移核对分块及事务回执；完成后旧 WebView `localStorage`/IndexedDB 只读保留为迁移前恢复副本，不双写。导航/显示偏好与草稿继续使用其既有所有者；内存草稿不保证跨进程退出恢复。

设置提交失败时可从原生管理页直接核对原请求回执，并在结果明确后显式选择重新应用或丢弃已知内存编辑；无回执不等于未提交。目录监测引用的原书依赖持续有效的 SAF 权限；应用数据、源书和导出备份不是同一份备份。详见[迁移与恢复合同](docs/android-native-pages.md)。

### 目录

```text
Pagewise/
├── readme.md                   # 项目唯一总说明
├── docs/                       # 架构、部署和验证记录
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

需要 Node.js/npm、Rust，以及 Android 构建使用的 JDK、SDK 和 NDK。1.9.0 本地构建使用 Node.js 25.9.0、JDK 21、Android SDK 36、NDK `30.0.16248370`、Kotlin 2.4.20、Gradle 8.14.3 和 AGP 8.11.0；这是已使用的环境记录，不代表其他组合已经验证。构建脚本只设置子进程环境，不要求修改全局 Java/SDK。

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

本轮验证的本地产物为 `artifacts/Pagewise-1.9.0-debug.apk` 和 `artifacts/Pagewise-1.9.0-release.apk`；历史包保留作恢复参考。这些是本地产物，不随 GitHub 源码同步上传，也不代表已创建 GitHub Release。

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

# 原生设置恢复、共享状态、受保护注册表及统计恢复入口（合成边界）
node --experimental-strip-types --test scripts/test-native-settings-editing.mjs scripts/test-native-state.mjs scripts/test-native-pages-contract.mjs scripts/test-native-stats-recovery-ui.mjs
```

更多专项脚本见 `reader/package.json` 和 `reader/scripts/`。浏览器、Mock 和源码契约测试只能证明各自覆盖的范围，不能替代 BOOX 真机验收；原生/前端 ready 信号也不证明书籍读取、目录扫描或远端 AI 服务可用。

性能探针和详细部署证据应保留在对应测试或部署记录中，不能仅凭进程存在、接口返回或哈希一致就宣称功能完成。

## 文档入口

- [1.9.0 功能与验证范围](docs/release-1.9.0.md)
- [七页原生管理、迁移与恢复（历史设计）](docs/android-native-pages.md)
- [构建、签名与安装指南](docs/deployment.md)
- [Android-only 约束](docs/android-only.md)
- [Android 原生能力路线与待验项](docs/android-native-roadmap.md)
- [伴读命名与兼容契约](docs/companion-naming.md)
- [AI 服务与模型目录](docs/ai-services.md)
- [使用手册](reader/docs/manual/README.md)
- [验证状态记录](docs/validation-status.md)

## 隐私与许可

本地阅读文件和索引由应用存储管理。AI、网络语音和元数据等联网功能涉及各自的请求与服务端处理，使用前应检查实际授权、配置和服务条款。API Key、书库、私人日志和签名材料不应提交到项目仓库；应用沙盒也不等同于加密存储。


项目仓库：[shawnshi/Pagewise](https://github.com/shawnshi/Pagewise)。
