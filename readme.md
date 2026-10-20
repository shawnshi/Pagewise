# 知页阅读器 · Pagewise

> **专注阅读，随页理解。**  
> 面向 **文石（Onyx BOOX）Android 墨水屏电纸书** 深度定制的本地阅读与随页理解应用（基于 [LightRead v1.15.0](https://github.com/yzfly/LightRead/tree/v1.15.0) 二次开发，当前源码版本 **`1.2.0`**）。

---

## 一、项目定位与产品边界

### 1.1 核心定位
Pagewise（知页）是一款专为 **文石（Onyx BOOX，以 Note X3 Pro 等 300 PPI 电磁笔墨水屏机型为基准）** 打造的混合原生阅读器。它将现代电子书排版内核（Foliate-js / MuPDF / PDFium）与 **文石官方 `com.onyx.android.sdk` 硬件控制能力** 及 **Android 原生 I/O 快车道** 深度融合，解决通用 Web/混合应用在电纸书上常见的翻页残影、CSS 调暗噪点、手写延迟、大体积 PDF 内存溢出（OOM）、物理翻页键弹窗闪烁以及合盖休眠丢进度等核心痛点。

### 1.2 核心能力全景
* **多格式专业阅读**：支持 `EPUB`、`MOBI`、`PDF`、`TXT`、`Markdown`（TXT/Markdown 自动流式转换为章节化结构）。
* **文石 `com.onyx.android.sdk` 四大硬件深度驱动**：
  1. **EPD 墨水屏刷新与波形控制（`EpdController`）**：WebView 对比度锐化、静态阅读默认 `REGAL` 波形、满 N 页自动触发 `GC` 全刷消残影、连续滚动与 PDF 缩放动态切入 `DU`/`A2` 快刷并在停手后重绘高清字形、关闭弹窗自动消除边框残影。
  2. **双色温阅读前光硬件接管（`FrontLightController`）**：直接控制文石物理冷光（亮度）与暖光（色温）LED 及前光总开关，联动日间、护眼、夜间模式，彻底替代在反射式电子纸上产生灰阶噪点的软件黑幕遮罩。
  3. **Wacom 电磁笔低延迟手写批注（`TouchHelper` / `RawInputCallback`）**：落笔走 EPD 硬件直写（Direct-to-Screen，延迟 < 20ms），支持钢笔/铅笔/马克笔与笔尾橡皮擦，抬笔自动归一化为页面级 SVG 矢量笔迹持久化，并在打开任何抽屉/弹窗时自动挂起手写拦截锁。
  4. **高分屏硬件画像与 1:1 像素预算（`Device` / `DeviceUtils`）**：识别文石屏幕物理分辨率（如 Note X3 Pro `1860×2480`）、DPI、RAM 档位与彩屏（Kaleido）特征，为高分屏提供点对点 PDF 栅格化预算。
* **电纸书原生稳定性快车道（Native Fast-Path）**：
  * **双通道书源获取**：支持 Android SAF 授权目录增量监测，以及从文石系统文件管理器、微信等通过 `content://` Intent (`ACTION_VIEW` / `ACTION_SEND`) 零拷贝流式打开入库；
  * **物理翻页键原生拦截**：在阅读页原生拦截音量加减键（`VOLUME_UP/DOWN`）与蓝牙翻页器/保护套按键（`PAGE_UP/DOWN`），抑制系统音量悬浮条闪烁并拒绝长按连发积压；
  * **合盖极速休眠防丢（Checkpoint）**：针对文石合上保护套瞬间冻结进程的特性，在 `Activity.onPause()` 将当前阅读位置（CFI/页码）与阅读时长通过 `fd.sync()` 原子写入本地恢复点。

### 1.3 明确的产品边界（Non-Goals）
* **仅面向 Android 电纸书交付**：桌面浏览器与 Headless Chromium 仅用于开发预览和自动化回归测试，不发布独立的 Web/PWA、桌面端或 iOS 产品。
* **本地优先与源安全**：通过 SAF 监测目录建立书库时仅读取源文件，**绝不提供修改或删除用户源书籍文件的接口**；目录权限失效或扫描异常时显式保留错误状态，绝不将读取失败归一化为“空目录”而误删已有书目、笔记或标签。
* **已退役模块**：书单、旧版手动导入弹窗、显式 EPUB 导出转换、论文专用分栏工作区及匿名遥测已退役（仅保留旧数据库 Schema 与存档的向后读取兼容）。

---

## 二、核心架构与目录拓扑

### 2.1 三层混合系统架构

```text
+-----------------------------------------------------------------------------------+
|                        1. Web 视图与排版表现层 (Vue 3 + TS)                        |
|  - 阅读视图: ReaderView.vue (EPUB/MOBI/TXT/MD), PdfReaderView.vue (PDF)           |
|  - 排版与伴读: foliate-js 多栏/连续滚动排版, 点睛伴读 (离线分词着色 + AI 解读)       |
|  - 文石前端服务: onyxEpd.ts / onyxFrontLight.ts / onyxScribble.ts / OnyxInkLayer   |
+-----------------------------------------+-----------------------------------------+
                                          |
                     Tauri IPC Commands   |   WebView @JavascriptInterface
                  (@tauri-apps/api/core)  |   (window.LightReadInsets 同步低延迟桥)
                                          v
+-----------------------------------------+-----------------------------------------+
|               2. Tauri v2 宿主层 (Rust)  |  3. Android 原生与文石硬件层 (Kotlin)    |
|  - SQLite 持久化 (tauri-plugin-sql)      |  - MainActivity.kt (生命周期/按键/系统栏) |
|  - 受控导入导出桥 (export_file.rs)       |  - ReaderWindowState.kt (纯策略状态机)   |
|  - SAF 目录插件桥 (monitored_folder.rs)  |  - OnyxSdkBridge.kt (文石 SDK + 原生加速)|
|  - 系统 TTS 桥 (system_tts.rs)           |  - MonitoredFolderPlugin.kt (SAF 流式)   |
|                                         |  - SystemTtsPlugin / NativeSpeechService|
+-----------------------------------------+-----------------------------------------+
```

### 2.2 代码仓库目录拓扑

```text
Pagewise/
├── readme.md                         # 项目唯一权威说明文档 (本文档)
├── docs/                             # 架构设计、部署规范、性能基线与审计文档
└── reader/                           # 应用核心工程根目录
    ├── package.json                  # 前端依赖、构建与测试脚本入口 (v1.2.0)
    ├── scripts/                      # 构建准备脚本 (prepare-android-*) 与自动化测试套件 (test-*)
    ├── src/                          # 前端源码
    │   ├── views/                    # 核心页面 (LibraryView / ReaderView / PdfReaderView / NotesView / StatsView / SettingsView)
    │   ├── components/               # UI 组件 (ReadingModePanel / TypographyPanel / OnyxInkLayer 等)
    │   ├── composables/              # 组合式状态 (useReadingModes / usePagewiseCompanion / useReadingTimer)
    │   ├── services/                 # 核心领域服务 (onyxEpd / onyxFrontLight / onyxScribble / onyxNativeAccelerator / pdfRasterClient / bookSearch 等)
    │   ├── storage/                  # 持久化抽象层 (tauri.ts SQLite+FS 实现 / browser.ts IndexedDB 实现)
    │   ├── stores/                   # Pinia 全局状态 (settings.ts / library.ts)
    │   └── vendor/foliate/           # 定制化电子书流式排版与分页引擎
    └── src-tauri/                    # Tauri 宿主与 Android 原生工程
        ├── tauri.conf.json           # Tauri 应用标识 (io.pagewise.reader) 与权限配置
        ├── src/                      # Rust 宿主代码 (lib.rs / monitored_folder.rs / export_file.rs / system_tts.rs)
        ├── android/                  # 【受管原生模板源】构建时由脚本校验并同步至 gen/android
        │   ├── MainActivity.kt       # Activity 主入口、InsetsBridge、按键分发、Intent 接收
        │   ├── ReaderWindowState.kt  # 窗口、EPD 波形、前光映射、手写互斥锁、按键与 Checkpoint 纯状态机
        │   ├── OnyxSdkBridge.kt      # 文石 SDK 四大控制器适配 + ZipFile 检索 + PdfRenderer + content:// 导入
        │   ├── MonitoredFolderPlugin.kt # SAF 目录增量扫描与 64KB 有界流式复制插件
        │   ├── ExportPlugin.kt       # SAF 归档导出与流式导入插件
        │   ├── SystemTtsPlugin.kt    # Android 原生 TextToSpeech 插件
        │   └── NativeSpeechService.kt# 后台听书前台媒体服务 (MediaPlayback Foreground Service)
        └── gen/android/              # Gradle 生成工程 (由 npm run android:prepare 幂等维护)
```

---

## 三、技术架构深度解析

### 3.1 技术栈清单

| 层级 | 技术选型 | 核心用途 |
|---|---|---|
| 前端框架与状态 | Vue 3.5 + TypeScript 5.8 + Pinia 3 + Vite 8 | 响应式阅读 UI、设置与书库状态管理 |
| 流式电子书内核 | `foliate-js` (深度定制版) | EPUB / MOBI / TXT / Markdown 解析、CSS 多栏分页与跨章连续滚动 |
| PDF 渲染双通道 | Android `PdfRenderer` (原生快车道) + `MuPDF` / `PDFium` WASM (Worker) | 本地书籍低内存按页栅格化、96 MiB 位图 LRU 预算、8 MiB 文本几何选区缓存 |
| 宿主与数据库 | Tauri v2 + Rust + `tauri-plugin-sql` (SQLite) | 本地关系型数据存储 (`lightread.db`)、跨平台插件调度 |
| 电纸书硬件层 | Kotlin 1.9 + Android SDK 36 + `com.onyx.android.sdk` | 文石 EPD 波形刷新、冷暖双色温前光、Wacom 电磁笔直写、SAF 文件流 |

### 3.2 文石（Onyx BOOX）SDK 硬件集成机制
1. **`EpdController` 刷新状态机（`OnyxEpdState` + `onyxEpd.ts`）**：
   * `attachWebView` 时自动开启 `EpdController.setWebViewContrastOptimize(webView, true)` 并设默认波形为 `UpdateMode.REGAL`；
   * 翻页时递增 `pageTurnCount`，未达阈值保持 `REGAL` 无闪翻页，达到 `gcIntervalPages`（默认 10 页）时调用 `EpdController.repaintEveryThing(UpdateMode.GC)` 全局清残影；
   * 跨章连续滚动与 PDF 双指缩放期间调用 `applyApplicationFastMode(true)` 切入 `DU`/`A2` 快刷，停手 180ms 后自动退出快刷并重绘高清字形；
   * 任何抽屉、目录、排版面板关闭后下一帧自动触发 `REGAL` 刷新，消除浮层边框阴影残影。
2. **`FrontLightController` 双色温前光控制（`OnyxFrontLightSnapshot` + `onyxFrontLight.ts`）**：
   * 自动探测 `hasFrontLight` 与 `hasCTMBrightness`（冷暖双色温），读取硬件原生步进量程（`getColdLightValues` / `getWarmLightValues`）并双向无损映射为 `0–100%` 百分比；
   * 在墨水屏模式下停用 CSS `rgba(0,0,0,alpha)` 调暗遮罩，由排版面板中的“文石双色温前光”分区直接驱动物理冷光与暖光，并在切换夜间/护眼模式时自动应用对应色温预设。
3. **`TouchHelper` 电磁笔低延迟手写（`OnyxScribbleState` + `onyxScribble.ts` + `OnyxInkLayer.vue`）**：
   * 开启手写批注时，前端测量页面容器 `limitRect` 与工具栏防误触排除区 `excludeRects`（按屏幕 `density` 转为物理像素 `Rect`），交由 `TouchHelper` 驱动 EPD 帧缓冲直写；
   * 抬笔或使用电磁笔尾橡皮擦时，通过 `RawInputCallback` 将采样点 `(x, y, pressure, size, timestamp)` 回传前端，归一化为页面相对坐标 `[0..1]` 存入本地并渲染为 SVG 矢量层；
   * **安全互斥锁**：当打开任何弹窗/抽屉（`modalOpen`）或 Activity 进入 `onPause` 时，立即调用 `setRawDrawingEnabled(false)` 释放触控拦截。

### 3.3 数据持久化架构
* **SQLite（`lightread.db`）**：
  * `books`：书目元数据、阅读进度（`location` CFI、`progress` 百分比）、累计阅读秒数（`reading_seconds`）、置顶状态与格式分类；
  * `annotations`：文本高亮（`kind = 'highlight'`，含 `cfi`、选区原文 `text`、想法 `note`、颜色/线型标识 `color`）与书签（`kind = 'bookmark'`）；
  * `reading_daily`：按日聚合的阅读时长统计，支撑阅读热力图与每日目标达成计算；
  * `sources` / `booklists`：OPDS/WebDAV 书源与历史兼容表。
* **本地文件系统（`AppLocalData` / `filesDir`）**：
  * `books/`：受管书籍文件副本（支持 64KB 流式导入与零拷贝暂存移入）；
  * `covers/`：书籍封面缩略图；
  * `onyx-reading-checkpoint.json`：合盖休眠时由原生 `onPause` 经 `fd.sync()` 原子落盘的阅读进度恢复点。
* **`localStorage`**：
  * `lightread-settings`（版本 `v16`）：全局界面、排版、阅读模式、墨水屏、听书及 AI 配置；
  * `pagewise-onyx-ink:v1:{bookId}:{pageKey}`：按书籍与页码/章节归一化的电磁笔矢量笔迹数据。

---

## 四、核心业务逻辑流转

### 4.1 书库建立与外部打开双通道
1. **SAF 授权目录监测（主通道）**：
   用户在书库页授权文石本地存储目录（如 `Books/`） -> `MonitoredFolderPlugin.kt` 通过 `DocumentContract` 增量枚举支持格式（`epub, mobi, pdf, txt, md, markdown`） -> 经 64KB 有界缓冲区流式落盘至临时文件（上限 512 MiB，支持超时与取消信号） -> 提取书目元数据与封面并建立源引用映射。阅读器活动期间自动挂起后台目录扫描，防止抢占翻页 I/O。
2. **系统外部应用直接打开（`content://` 快车道）**：
   用户在文石“文件管理器”或“微信”中点击电子书选择“用知页打开” -> `MainActivity.onCreate` / `onNewIntent` 捕获 `ACTION_VIEW` / `ACTION_SEND` -> `OnyxSdkBridge.ingestExternalIntent` 通过 `ContentResolver` 直接流式落盘至 `cacheDir` -> `externalOpen.ts` 调 `commitStagedExternalFile` 零拷贝移入书库并自动跳转至对应阅读页（EPUB 走 `/read/:id`，PDF 走 `/read-paper/:id`）。

### 4.2 自适应排版与墨水屏阅读闭环
* **三级排版配置解析**：按 `单书专属覆盖 (typographyBooks) > 语种默认配置 (typographyLanguages: zh/en/mixed) > 全局默认配置` 自动解析字号、行高、页边距、段间距、首行缩进与两端对齐。
* **墨水屏高对比纸墨视觉（`.lr-eink`）**：日间采用纯白 `#ffffff` 底与纯黑 `#000000` 字，夜间采用纯黑 `#000000` 底与浅灰 `#e8e8e8` 字，全局剥离 CSS 过渡动画与阴影；四种批注颜色在墨水屏下自动映射为四种高辨识度单色底线（**实线、双线、虚线、波浪线**），且绘制在字形框外侧以免遮挡笔画。

### 4.3 全书检索、伴读与 AI 阅读助手
* **极速全书检索（`bookSearch.ts`）**：支持多关键词同段匹配、大小写敏感、全词匹配与正则表达式。在文石本地 EPUB 上优先通过 `OnyxSdkBridge.searchNativeEpubText`（基于 `java.util.zip.ZipFile` 中央目录）秒级筛出命中章节，跳过未命中章节的 DOM 构建开销，再生成精确到字符偏移的 `CFI` 定位。
* **伴读（点睛阅读 `usePagewiseCompanion`）**：
  * **基础版（离线）**：利用内置 6.6 万词分词词表（jieba + DeepSeek 词表生成）与 ICU 分词器，在本地进行词组交替着色或重点词提取，完全不联网；
  * **智能版（AI）**：首次开启须经用户显式授权（可设“仅本书”或“所有书”），校验服务端 Prompt 协议版本后生成章首要义卡、全书脉络与选文深度解读。

### 4.4 多引擎听书（TTS）
* **Android 原生系统语音（`system`）**：由 `SystemTtsPlugin.kt` 与 `NativeSpeechService.kt` 驱动，在单一后台线程串行处理朗读队列与持久化，启动前台媒体播放服务（`mediaPlayback`）支持息屏朗读，并在电话或其它音频抢占焦点时自动暂停。
* **本地离线神经语音（`local`）与在线语音（`edge`）**：支持本地离线语音包管理与在线神经音色切换，与阅读页面翻页锚点实时同步。

---

## 五、部署、编译与真机安装指南

### 5.1 开发环境要求
* **Node.js**：建议 `24+`（Vite 8 要求 `^20.19.0 || >=22.12.0`）
* **Java / JDK**：**必须使用 JDK 21**（当前 Gradle 8.11/8.14 不兼容 Java 25；可仅在终端会话设置 `JAVA_HOME` 指向 JDK 21）
* **Android SDK & NDK**：`compileSdk = 36`、`targetSdk = 36`、`minSdk = 24`，兼容 NDK（如 `30.0.16248370`）
* **Rust 工具链**：安装 `rustup` 并添加 Android 编译目标：
  ```sh
  rustup target add aarch64-linux-android
  ```

### 5.2 从源码构建步骤

```sh
cd reader

# 1. 安装前端依赖
npm ci

# 2. 本地浏览器开发预览 (仅用于 UI 与合成测试)
npm run dev

# 3. TypeScript 类型检查与前端生产构建
npm run build

# 4. 首次初始化 Tauri Android 工程 (若 gen/android 已存在可跳过)
npm run android:init -- --ci --skip-targets-install

# 5. 将 src-tauri/android/ 原生模板与变体配置原子同步至 gen/android
npm run android:prepare

# 6. 编译 Android APK
npm run android:build           # 编译 Debug 变体 (io.pagewise.reader.debug)
npm run android:build:release   # 编译 Release 变体 (io.pagewise.reader)
```

### 5.3 Release / Debug 包名隔离与 ADB 覆盖安装
| 构建变体 | Application ID (`applicationId`) | 桌面显示名称 | 数据目录隔离 |
|---|---|---|---|
| **Release（正式版）** | `io.pagewise.reader` | `知页 1.2` | 独立私有目录，用于日常真实书库阅读 |
| **Debug（测试版）** | `io.pagewise.reader.debug` | `知页 1.2 试版` | 独立私有目录，可与正式版在同台文石设备上并存 |

* **ADB 覆盖升级安装命令**：
  ```sh
  # 安装或覆盖升级 Debug 试版 (保留应用内已有数据)
  adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
  ```
* **正式版升级铁律**：覆盖升级 `io.pagewise.reader` 必须保持相同正式包名、同一签名证书及递增 `versionCode`；严禁将未签名的 `unsigned.apk` 当作正式交付物，严禁通过卸载旧版或清空数据来绕过签名校验（详见 [部署与签名约定](docs/deployment.md)）。

### 5.4 文石（BOOX OS）真机“应用优化”推荐设置
在文石电纸书（如 Note X3 Pro）安装完成后，建议在系统下拉栏 **「E-Ink 中心 / 应用优化」** 中确认以下两项：
1. **颜色/漂白增强**：关闭“高对比度文字色块强行反色”或“网页背景强行漂白”（Pagewise 已原生内置 `#ffffff/#000000` 纸墨对比度与 `EpdController.setWebViewContrastOptimize`）；
2. **后台与合盖策略**：如需使用长时间息屏听书，请在文石系统「设置 -> 电源管理」中允许知页后台音频运行并授予通知权限。

---

## 六、主要配置参考

### 6.1 应用内核心运行配置（持久化于 `lightread-settings`）

| 配置分类 | 配置路径 / 键名 | 默认值 | 可选值与业务说明 |
|---|---|---|---|
| **墨水屏模式** | `readingMode.eink.enabled` | `false`（识别文石设备自动提示开启） | 开启后切换至纯黑白纸墨主题、字重 +100、禁用翻页动画、启用四线型批注 |
| **全刷消残影间隔** | `readingMode.eink.gcIntervalPages` | `10` | `0 (仅系统) / 1 / 5 / 10 / 20` 页；满指定页数触发原生 `EpdController` `GC` 全刷 |
| **文石双色温前光** | `TypographyPanel` -> `文石双色温前光` | 实时读取硬件 | 直接调节 `FrontLightController` 前光开关、冷光亮度（`0–100%`）、暖光色温（`0–100%`） |
| **阅读版式流** | `reader.flow` / `reader.continuousScroll` | `paginated` / `true` | 支持多栏分页模式、单章滚动与跨章连续滚动（滚动期间自动切入 `DU` 快刷） |
| **PDF 渲染配置** | `pdf.renderer` / `pdf.layout` / `pdf.fit` | `mupdf` / `original` / `fitW` | 支持原始版式与重排模式（Reflow）、单页/双页跨页视图及原生 `PdfRenderer` 加速 |
| **听书引擎** | `ttsEngine` / `ttsRate` | `edge` / `1.0` | `system`（Android 原生前台服务队列）、`local`（Kokoro 离线包）、`edge`（在线神经语音） |
| **AI 阅读助手** | `aiProvider` / `aiBaseUrl` / `aiApiKey` / `aiModel` | `trial` | 支持自定义 OpenAI 兼容接口（如 DeepSeek 等），按服务商独立保存 `aiProfiles` |
| **伴读（点睛阅读）** | `dianjing.level` / `dianjing.density` | `basic` / `normal` | `basic`（离线分词与重点词）或 `ai`（智能章首卡/脉络/解读）；密度可选 `low / normal / high` |

### 6.2 构建与版本受管配置
* **版本单一事实源**：`reader/package.json` 的 `"version"` 与 `reader/src-tauri/tauri.conf.json` 的 `"version"` 必须严格一致（当前为 `1.2.0`，对应 `versionCode = 1002000`）。`prepare-android-variants.mjs` 会在构建前校验两者一致性并自动生成 `tauri.properties`。
* **原生模板白名单**：`reader/src-tauri/android/` 下的 `.kt` 文件受 `prepare-android-project.mjs` 强校验保护（包含 `MainActivity.kt`、`ReaderWindowState.kt`、`OnyxSdkBridge.kt`、`MonitoredFolderPlugin.kt`、`ExportPlugin.kt`、`SystemTtsPlugin.kt`、`NativeSpeechService.kt`）。

### 6.3 原生性能探针配置（`PERF_PROBE`）
如需在真机采集打开书籍与翻页的端到端物理耗时（`PWPERF` 日志），可通过 ADB 传入布尔 Extra 启动 Activity：
```sh
adb shell am start -n io.pagewise.reader.debug/io.pagewise.reader.MainActivity --ez io.pagewise.reader.PERF_PROBE true
adb logcat -s PagewisePerf:I
```
*注：该探针仅在显式传入 `PERF_PROBE=true` 时激活，单次启动最多记录 512 条原语耗时样本（`action=ready|open|turn engine=probe|reflow|pdf`），不记录任何书籍正文或隐私路径。*

---

## 七、测试验证与开源许可

### 7.1 自动化测试套件
在 `reader/` 目录下可执行以下确定性测试与编译检查：

```sh
cd reader

# 1. Android 专机平台边界与模板幂等性校验
npm run test:android-only
node --test scripts/test-android-prepare-failure.mjs scripts/test-android-variants.mjs

# 2. Kotlin 原生状态机 Host 单元测试与 Android 字节码编译检查
node scripts/check-reader-environment-kotlin.mjs host
node scripts/check-reader-environment-kotlin.mjs android

# 3. 文石硬件画像、EPD 波形、双色温前光、电磁笔手写与 Stage 1–4 原生加速测试
node --test scripts/test-native-reader-environment.mjs scripts/test-paper-ink.mjs

# 4. 真实 Chromium 浏览器墨水屏渲染与 PDF/EPUB 交互端到端验证
node scripts/test-paper-ink-browser.mjs

# 5. PDF Worker 有界调度、归档流式边界与性能探针测试
node --experimental-vm-modules --test scripts/test-pdf-worker.mjs scripts/test-bounded-archive.mjs scripts/test-device-performance.mjs
```

### 7.2 相关专题文档索引
* [部署与签名约定](docs/deployment.md) · [1.2.0 安装记录](docs/deployment-1.2-status.md)
* [当前验证状态与已知缺口](docs/validation-status.md) · [设备准入边界](docs/device-admission.md)
* [性能实现状态与测量边界](docs/performance-implementation.md)
* [阅读助手与伴读提示词协议](docs/reading-assistant-prompts.md)

### 7.3 数据隐私与开源许可
* 本地阅读与离线伴读不发送任何外部请求；AI 阅读助手、智能版伴读、在线 TTS 音色及用户自配的远端端点会将所选文本发送至对应服务端。
* `.cache/`、`.worktrees/`、构建产物、签名证书（`.jks`/`.keystore`）、API 密钥与个人书库数据严禁提交至版本库。
* 本项目保留上游 LightRead 作者 **yzfly／云中江树** 署名，阅读器沿用 [AGPL-3.0-or-later](reader/LICENSE) 许可证及第三方组件许可（包括 jieba 与 DeepSeek 词表 MIT 许可，见 `reader/src/data/zh-lexicon.README.md`）。分发修改后的 APK 时须按协议提供对应完整源码。项目仓库：[shawnshi/Pagewise](https://github.com/shawnshi/Pagewise)。
