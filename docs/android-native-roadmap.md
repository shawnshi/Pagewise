# Pagewise：Android / BOOX 原生边界审计与分步改造

## 当前阶段：1.5.0 七页原生管理与共享存储

藏书、正在阅读、书籍详情、全部笔记、阅读统计、设置和使用手册已改为 Android 原生 Views；EPUB/PDF 正文保留现有实现。设置与统计迁至同一原生数据库，业务、草稿、导入、TTS 和 EPD 仍各有单一所有者，不能据历史章节将当前管理页误记为 Vue 页面。

七页源码/host 实现通过 v4 独立复审。1.5.0 release/debug 已构建、签名并在 Note X3 Pro 覆盖安装；本次未主动启动应用，也未验收真实书籍/SAF/原生迁移、物理尺标或 EPD。详见[原生管理页与迁移](android-native-pages.md)和[1.5.0 安装记录](deployment-1.5-status.md)。

以下保留各阶段当时的范围、设备清单和审计判断，不作为当前版本仍缺少这些实现、或已经通过真机验收的依据。

## 历史阶段：原生解析、封面与批量入库（实现复核通过，待设备验收）

本阶段保留 Vue 页面和现有书库，不另建书籍、批注或分类存储。权威代码位于 `reader/src-tauri/android/`；生成 Android 工程由 `prepare-android-project.mjs` 原子同步。

- `NativeBookMetadata.kt` 读取 EPUB OPF、MOBI/EXTH/KF8、TXT、Markdown；`NativePdfMetadata.kt` 使用 PDFium 读 PDF 书目，使用 Android `PdfRenderer` 提取首页面封面。封面失败可独立降级，不能把书籍解析、目录权限或数据库错误伪装成空结果。
- `NativeBookImporter.kt` 与 `NativeImportDatabase.kt` 在现有 `application.dataDir/lightread.db` 中逐书提交，仅增加 `native_import_batches` 回执表。已有书籍只按引用 CAS 更新文件关联和可用性，不覆盖手动分类、标签、批注或阅读历史；只有无扫描错误的完整目录结果才可标记未见文件缺失。自定义书库路径明确拒绝，不偷偷改用默认库。
- `NativeFileJobs.kt` 复用既有前台服务，`index`、`import` 共用单写入 lane。提交期取消/超时必须等提交结果落定；SQLite 回执与逐书写入同事务，提交结果未知保留恢复入口。
- `nativeBookImport.ts` 在上传前保存批次身份、已分配暂存路径和输入位置，重载后复用同一 SQL 批次，而非重新生成 ID、重新上传整批。最后一本提交后即保存可恢复的完成回执；原生任务 JSON 尚未写成功的崩溃窗口通过请求指纹和 SQLite 对账。中断、数据库错误及提交结果未知的恢复输入不再被观察回执的一小时 TTL 删除；仍须考虑 Android 自行回收 cache 的可能性。提交结果未知在释放提交保护的同一临界区落定，优先于提交期间及 catch/finally 间隙的新取消意图。
- 上传前即预留字节，失败或丢失响应的上传仍计入单批 1 GiB 额度。`ExportPlugin.kt` 登记排队和执行中的上传路径；原生清理与入库读取先等这些所有者物理结束，再封闭 token，迟到 IPC 不得重新创建已释放路径。进程内跟踪最多 16384 个路径，满额明确报资源限制。改名后的 inspect 使用完整请求身份，并保留旧任务的取消／释放回执，不能把新文件名塞进旧任务。
- 发布文件保留原扩展名大小写，匹配现有 `bookPath()` 的读取和删除行为。目录读取仍限 64 MiB；复制输入单文件/单批最多 1 GiB、128 项，目录最多 5000 项，原生任务期限 15 分钟。复制前的 Blob 分块上传仍由前端驱动，不能承诺在上传完成前切后台也能继续。

### 已执行证据与剩余门禁

证据位于 `.cache/native-import-20261021/`：

- `commit-settlement-race-green.log`、`kotlin-full/compile.log`：最新全部原生模板以 Kotlin **2.4.20**、Gradle 8.14.3、AGP 8.11.0 编译通过；生产导入所有者／仓储执行 **60 条断言**，覆盖 SQLite 回滚、过期后的部分批次续跑、提交结果未知叠加取消、大小写读取／删除、丢失最终任务状态恢复和上传／入库共享释放保护。新增调度闸门精确暂停在异常分类与 guard settlement 之间，再触发取消；`commit-settlement-race-red.log` 记录修复前失败，green 记录未知结果保留及两项批次续跑成功。host 仅插入该时序闸门，Android/provider/bitmap 为受控适配器。元数据的 **30 条断言**仍见 `final-android-host-tests.log`，包含 48 MiB heap 下不解压未使用的 64 MiB ZIP 章节。
- `upload-owner-tests.log`、`review-fixes-tests.log`：生产 ExportPlugin 的 **18 个生命周期场景**通过，包括销毁 WebView 后旧 append 仍在 COMMIT 内、清理必须等待、迟到 begin 不得重建 token。测试仅替换 Android 与文件输出流构造边界，未模拟真实 PDF 成功。
- `final-frontend-tests.log`：**78 项**通过，覆盖真实前端 import 分支、持久批次、丢 ACK／重载、失败上传额度、更名 inspect 和损坏日志拒绝；prepare 的失败回滚与幂等也通过。`vue-tsc -b --pretty false` 通过。主动 LSP 返回零诊断但全部为 inconclusive，不把静默当作 clean。
- `dependency-audit.json`、`osv-response.json`：经用户批准，从存在 **GHSA-r937-wjx7-w2jp / CVE-2026-53914** 的 2.4.0 升至项目内 **2.4.20**。当前 **33 项** Maven 坐标（含实际 compiler/daemon classpath）完成本地 SHA-256、仓库 SHA-1 和许可证核验，在线 OSV 没有返回匹配公告。此为有界检索，不是“无漏洞”保证，亦不覆盖嵌入式 PDFium/C++ 二进制或完整 SBOM。未修改全局环境或 Cargo registry 中的 Tauri 源码。
- 较宽的旧回归曾为 134/136：Kotlin 并发 harness 的版本问题已修复并通过；另一项 SSE 失败对应未改动的 `test-book-tagging.mjs` 与 HEAD 一致的 AI／分类模块，单列保留，没有借本任务修改标签工作。不能把该宽回归称为全绿。
- `device-inventory.json` 当前在线、离线及未授权设备均为 0。未安装 APK、未读取真实用户书库。PDF 运行时、设备 SQLite、后台／进程终止／SAF 生命周期、通知权限、电子墨水屏整机表现仍须真机验收；JVM 和 Gradle 结果不能替代这些证据。最终独立复核已闭合：v3 的四项问题和 v4 的提交／取消竞态均获修复确认，`independent_review_completed: true`，实现门禁 PASS。报告依次为 `native-import-final-review.md`、`native-import-recheck.md`、`native-import-race-closure.md`（保留在本会话托管的 subagent 输出目录），本地验收索引见 `acceptance.json`。这不是整机运行验收通过。

安全来源：[GitHub 公告](https://github.com/advisories/GHSA-r937-wjx7-w2jp)、[OSV 原始记录](https://api.osv.dev/v1/vulns/GHSA-r937-wjx7-w2jp)。回滚恢复点为本阶段 `preflight.json`、`before/`、`generated-before/`；仅恢复本阶段 write-set，保留其他未提交工作。回滚旧代码不删除现有书籍或新增回执表，且本次 host 测试只写合成数据库。

## 上一阶段：原生文件任务与 EPD 调度

以下为当前工作区相对 `b5291853` 的增量；后面的 2026-10-19—20 记录是历史审计，不代表本次设备状态。

- **文件访问与大文件暂存**：`MonitoredFolderIo.kt` 是 picker 插件与后台服务共同使用的 SAF 授权和 I/O 实现。保留目录归属、tree membership、只读权限、复制后权限复查、64 KiB 缓冲区和 64 MiB 实际字节上限。
- **后台任务**：新壳经 `monitored_file_job` 将目录遍历和单文件暂存交给非导出的 `NativeFileJobService`（`dataSync` 前台服务）。一条枚举 lane、一条读取 lane；JS 仅观察回执，不驱动任务。回执原子持久化，页面重建可以按请求 ID 重连。
- **失败与恢复**：启动被系统拒绝、provider 错误、取消、120 秒超时、进程／服务中断分别保留明确状态。watchdog 不等待阻塞 provider 就发布超时终态；未返回的实际 worker 仍占用物理额度，迟到结果丢弃，不能以逻辑结束冒充 IO 已停止。进程重启将未完成回执标为 `interrupted`，不自动重放源文件操作。
- **资源和清理**：最多 16 份回执，完整 envelope 统一限制 8 MiB，终态一小时过期。前端独立保存待释放 ID，重连时有界补做 ACK；ACK 幂等且允许权限丢失后的清理。取消接口不返回目录结果或暂存路径。
- **阅读设备控制**：EPD 快速模式的延迟退出和弹层关闭后的重绘改由 Kotlin Handler 持有。新手势会撤销旧退出任务，Activity 暂停／销毁清理两类定时任务。新壳状态以原生快照为准，不再由 JS 定时器重复执行。
- **后台朗读与媒体控制**：继续复用已有 `SystemTtsService`／`NativeSpeechSession`、音频焦点、MediaSession、通知控制和原生窗口／按键所有者。没有新增竞争服务或另一套阅读位置状态。
- **旧壳兼容**：缺少 `nativeFileJobsVersion()` 的旧壳继续使用既有窄化 SAF 命令；新服务返回失败时不回落为旧 IO，也不返回假空目录。旧壳不具备本次服务化保证。

**实施边界**：这不是整个导入流程的原生重写。书籍解析、封面提取、批量入库编排和页面渲染仍使用现有 Web 路径；单文件暂存结束后，前端仍会读取字节，因此不声称零复制、整批导入后台完成或无限制大文件支持。已 force-stop 的应用不会自动完成任务，不能承诺进程死亡后续跑。

**本次验证**：TypeScript 检查、所有 authoritative Kotlin 模板对真实 Android 36／AndroidX／Tauri 类型编译、离线 Android Rust cross-check，以及定向 Node／生产 Kotlin host 测试。Host 覆盖失联重连、权限撤销、独立 lane、取消与阻塞超时、迟到结果、原子回执重启恢复、完整回执大小边界；原有窗口与 SAF copy host 包含 58 条断言。Android prepare 已在当前生成工程执行并验证模板一致、服务声明和幂等；未安装 APK。

本次 ADB 列表没有连接设备。尚未验证真实 DocumentsProvider、Android 前台服务许可／通知、锁屏与杀进程行为、BOOX 波形和性能；编译或 host 成功不能替代这些验收。基线中已有的 Reader Back 测试 harness 缺少 `onyxNativeAccelerator`，不在本次修复范围。

复验入口：

```sh
cd reader
node --test scripts/test-native-file-jobs.mjs scripts/test-native-file-jobs-host.mjs scripts/test-native-epd-scheduler.mjs
node --test scripts/test-folder-kotlin-compile.mjs
node scripts/check-reader-environment-kotlin.mjs host
```

本次恢复点、原有脏工作树快照和实际日志在 `.cache/native-boundaries-20261021/`；回退只恢复本次 write-set，保留开始时已有的四个标签修改。没有数据库迁移或依赖升级。

---

## 历史记录：2026-10-19—20

审计与实施：2026-10-19—20。基线：`baa1d76` 加本次开始时的未提交工作树。没有把已有原生 TTS、导出、PDF Worker 等改动计算为本次新增能力。

## 结论

**应原生化系统所有权和跨进程 I/O，不应为了“原生”重写 EPUB、书库或整套界面。** Pagewise 目前是 Vue / Foliate / WebView + Tauri / Rust + Kotlin。主要收益来自减少大块桥传输、正确处理 Android 生命周期，以及明确文件发布的提交点，而不是把 TypeScript 逐文件翻译成 Kotlin。

本轮已完成四个有限切片：

1. Android 原生设备能力事实供给，接入墨水屏建议和 PDF 位图预算。
2. 原生窗口状态管理：暂停释放常亮，恢复按阅读意图重放，销毁后拒绝迟到请求。
3. SAF 统一有界流式暂存，移除依赖 provider 声明大小的 Base64 分支。
4. 原生导入/导出追加上限修正，以及书籍文件的原子替换发布。

**验收边界：代码、前端构建、原生源文件编译和离线测试已执行；尚未打包、安装本次 APK，也未完成真实 BOOX 窗口、DocumentsProvider 或物理屏幕刷新验收。** 后续候选不代表已经实现。

## 1. 已核验的环境与现状

- 只读 ADB 探针识别到连接设备为 BOOX Note X3 Pro、Android 12；manufacturer=`ONYX`，brand=`Onyx`。
- 生成 Android 工程 `minSdk=24`。原生补丁没有采用 API 26 才提供的 `java.nio.file.Files.move`。
- 设备 `dalvik.vm.heapgrowthlimit` 配置为 `256m`。这不是当前 WebView 剩余堆，也不能直接替代运行时 `ActivityManager.memoryClass`。
- 本轮开始时工作区已有大量修改。恢复副本、原始工作树状态和精确 write-set 存于 `.cache/android-native-20261019/`；不使用过期符号图作为最终源码证据。
- SAF、系统 TTS、后台语音所有权、导入导出及 Android Back 原先已有 Kotlin 实现。应改善其边界，不再复制第二套服务。

本地证据入口：

- [Android 壳与生命周期](../reader/src-tauri/android/MainActivity.kt)
- [SAF 原生读取](../reader/src-tauri/android/MonitoredFolderPlugin.kt)
- [原生导入导出](../reader/src-tauri/android/ExportPlugin.kt)
- [既有后台语音服务](../reader/src-tauri/android/NativeSpeechService.kt)
- [EPUB 阅读页](../reader/src/views/ReaderView.vue)、[PDF 阅读页](../reader/src/views/PdfReaderView.vue)
- [前端 SAF 适配器](../reader/src/services/monitoredFolder.ts)

## 2. 哪些模块应交给 Android

| 模块 | 使用体验与响应 | 稳定性 | 可维护性取舍 | 处置 |
|---|---|---|---|---|
| 设备能力、窗口、常亮、系统栏 | 不依赖被简化的 WebView UA；恢复阅读时保持用户意图 | 系统生命周期是原生事实源 | 保留一个薄桥和一个窗口状态所有者 | 本轮已改 |
| SAF 文件读取、大文件传输 | 去掉 Java Base64 大字符串及编码成本 | 按实际字节限额，保留取消、权限复查与清理 | 统一一种原生传输结果；旧 Base64 前端兼容仍保留 | 本轮已改 |
| 私有书籍文件发布、分块追加 | 大文件不再冒险先删旧书 | 超限块写前拒绝；替换失败保留旧文件 | 不改调用方或数据格式，复用既有插件 | 本轮已改 |
| 系统“打开方式” / `content://` | 从文件管理器直接打开更符合 Android 使用习惯 | URI 授权应由 Android 接收与及时暂存 | Web 只接受受控交付 token，不新增任意 URI 访问桥 | 下一阶段候选，未实施 |
| 实体翻页键 | 仅在 Android 没有正确转发 DOM 事件时有明确收益 | 需避免 iframe 焦点、输入框、长按重复与路由失效 | 导航仍由现有阅读器负责，不建立第二套页码 | 条件实施，未抢占音量键 |
| BOOX 刷新模式 / 局部与全刷 | 可能改善残影、闪屏和交互反馈 | 强依赖机型、固件及公开 SDK 支持 | 只做可关闭的厂商适配，不能散布反射调用 | 需目标固件核验，未实施 |
| 后台 TTS / 播放 | 锁屏、音频焦点和通知属于系统能力 | 已有原生服务，应验证进程与 WebView 生命周期的区别 | 复用现有服务，不新增竞争播放所有者 | 保留已有原生实现 |
| PDF 栅格化 | 大页可能受益，也可能因双重解析和跨桥位图复制更慢 | 需要验证原生文档句柄、缓存和页面资源回收 | 优先保留 Worker；实测后才替换一个栅格后端 | 本轮仅接入原生内存提示 |
| EPUB 排版与批注 | CFI、DOM 选择、字体和分页目前紧密相连 | 全面替换会扩大位置与批注回归面 | 无免费替换的 Android 系统 EPUB 引擎 | 不建议本轮原生重写 |
| 书库、设置、笔记、伴读 UI | 当前没有证据证明瓶颈来自 Vue 本身 | 多套界面会增加状态同步问题 | 保留一份业务模型；系统对话框继续用原生 | 保留 Web |

### 可溯源的推演断言

- **NATIVE-01：**SAF 的 provider 声明大小不能作为内存分配边界。旧代码依据声明大小选择 Base64，但实际读取允许到 64 MiB，低报或读取中增长会绕过原来的 8 MiB 分流阈值。统一暂存消除这一分支，而不是宣称整个读书链路已零复制。
- **NATIVE-02：**`setKeepScreenOn` 的阅读意图与 Activity 当前可施加的窗口效果是两个状态。暂停时释放效果、恢复时重放意图，可以处理后台期间退出阅读或迟到桥请求；不需要全局停止 JavaScript timers。
- **NATIVE-03：**桥传输改成文件路径不等于响应一定更快。小文件新增一次磁盘暂存；前端仍通过 plugin-fs 完整读取为字节，再创建 Blob。净收益需要真实 provider 和书籍 A/B 测试。
- **NATIVE-04：**原生栅格化只有在端到端开销下降时才值得替换。保留 Web 文档语义再加一份原生文档解析，有可能增加总内存；把大 Bitmap 转回 Base64 也会抵消收益。
- **NATIVE-05：**原生返回、实体页键与 Web 阅读导航必须保持单一业务所有者。Android 可以负责捕获和分发，不能独立维护 CFI、PDF 页码或批注保存流程。

## 3. 本轮实施详情

### 第一步：原生环境事实与受限 PDF 预算

变更：[MainActivity.kt](../reader/src-tauri/android/MainActivity.kt)、[nativeReaderEnvironment.ts](../reader/src/services/nativeReaderEnvironment.ts)、[pdfRenderBudget.ts](../reader/src/services/pdfRenderBudget.ts)、[useReadingModes.ts](../reader/src/composables/useReadingModes.ts)。

- 在既有 `LightReadInsets` 薄桥增加可选、只读的 `getReaderEnvironment()`。
- 仅返回 schema 版本、BOOX 品牌提示、`isLowRamDevice` 和 `memoryClass`。不采集设备序列号、账户或书籍内容。
- 前端严格检查版本、字段类型与内存范围；区分旧壳不提供能力、无效响应和调用错误。正常路径缓存事实，避免每次翻页执行同步桥调用。
- 原生 BOOX 提示只参与“是否建议开启墨水屏模式”，不自动改用户已保存设置；原有 UA / media-query 识别保留作补充。
- PDF 原来的 12,000,000 像素上限保留为最高值，再按原生内存提示收紧。常规页保留原 DPR；超预算时等比降低位图分辨率，CSS 显示尺寸不变。

确定性预算示例：

| 原生报告 | 单页像素上限 | 一份 RGBA 原始缓冲区上界 |
|---|---:|---:|
| 旧壳 / 网页，无有效原生事实 | 12,000,000 | 48,000,000 bytes |
| `memoryClass=128 MiB`，非低内存设备 | 4,194,304 | 16,777,216 bytes |
| `memoryClass=256 MiB`，非低内存设备 | 8,388,608 | 33,554,432 bytes |
| 低内存设备 | 不高于 2,000,000 | 不高于 8,000,000 bytes |

这只是单个位图的计算界限，不是整个进程内存峰值、无 OOM 保证或实测性能提升；文档解析、相邻页、canvas 和 Worker 都可能另外占用内存。较低预算也可能降低高倍率放大的清晰度，需要实机复核。

### 第二步：原生窗口生命周期所有权

新增 [ReaderWindowState.kt](../reader/src-tauri/android/ReaderWindowState.kt)，由 MainActivity 单独持有。

- 创建但尚未 resumed 的窗口不施加常亮效果。
- `onPause` 释放 `FLAG_KEEP_SCREEN_ON`，正常调用父类生命周期。
- `onResume` 和重新取得窗口焦点时按当前阅读意图恢复窗口效果。
- 后台期间新的关闭请求优先于之前的开启意图。
- 销毁后迟到的请求不能重新激活窗口。
- 不引入 `pauseTimers()`、`resumeTimers()` 或保持 WebView 假前台的行为，不重新设计 TTS 服务。
- Android prepare 明确识别、校验和复制新 Kotlin 文件；缺依赖或模板不合法时先失败，不把不可编译工程留给打包阶段。

### 第三步：SAF 原生流式暂存

[MonitoredFolderPlugin.kt](../reader/src-tauri/android/MonitoredFolderPlugin.kt) 不再将任何文件编码为 Java Base64 字符串。

保留原契约：

- 源目录只读、tree membership 检查、持久授权归属不变。
- provider 声明超过限制时仍提前拒绝；实际读取时仍执行 64 MiB 上限。
- 使用 64 KiB copy buffer；超时或取消、I/O 异常均保留错误，不转换为空文件。
- 完成复制后再次检查期限和授权；失败时丢弃本次暂存。
- 仍使用 `cache/pagewise-read/<uuid>.bin`，由真实前端适配器读取并在 finally 清理；原生一小时过期清理作为兜底。
- 书籍 ID、批注、阅读位置、目录引用和持久格式不变。

**没有实现**从 SAF 到最终书库的端到端零复制。下一轮若实际内存仍为瓶颈，再设计原生源文件发布路径，不在本次偷偷改变存储所有权。

### 第四步：追加边界与书籍文件原子发布

[ExportPlugin.kt](../reader/src-tauri/android/ExportPlugin.kt)：

- `append` / `appendImport` 现在同时检查单块 4 MiB 上限和“现有长度 + 本块长度”，跨越 256 MiB / 1 GiB 总上限时在写入前拒绝。
- 原先 `publishImport` 会先删除已有目标，再尝试 rename/copy；失败可能丢失旧书。现在同文件系统使用 `Os.rename` 原子替换。
- 仅遇到 `EXDEV` 才走跨文件系统复制：先在目标同目录写完暂存文件、同步文件内容，再 rename 提交；错误时保留旧目标和可重试的源文件，清理本次暂存。
- 没有修改公开命令、路径白名单、返回码或书库布局。

**范围限制：**本轮没有改变既有 `run()` 超时/取消语义，也没有将 `delete` 收敛到同一串行队列。因此不能把这次修补称为完整导入导出事务；超时不应被调用方理解为“确定没有提交”。原子名称替换也不等于断电持久性保证。

## 4. 验证及证据

所有证据均来自本次执行，不借用既有 APK 或运行进程冒充新版本验证。

| 检查 | 实际结果 | 不证明什么 |
|---|---|---|
| 定向及调用方回归 | 167 / 167 通过，包含阅读模式、PDF、Android prepare、返回键、真实 SAF 前端适配器、归档与书库入口 | 不证明真实 provider / 实机窗口行为 |
| Kotlin 窗口及 SAF copy host | 35 条断言通过；实际生产状态类及暂存方法，覆盖空文件、16 MiB、64 MiB边界、超限、取消、超时和 I/O 清理 | Android 描述符/provider 为受控替身 |
| Kotlin 原生发布 host | 42 条断言通过；生产 command bodies，覆盖边界追加、覆盖/新建、EXDEV、复制/同步中断、两类 rename 失败及 sync 先于提交的事件顺序 | 测试缩小 byte ceilings 并使用受控 OS/输入流；不验证生产队列与超时 |
| 导入追加缺陷基线 | 冻结版本运行同一断言失败：跨越上限仍返回成功；补丁后通过 | 不是在补丁之后捏造一个旧实现 |
| 四个生产 Kotlin 源文件 | 对实际安装的 Android API32、AndroidX、Tauri 类型编译，退出 0 | 不是完整 APK 打包或安装 |
| `vue-tsc -b --pretty false` | 退出 0 | 不替代 UI / 设备测试 |
| 隔离 Vite production build | 退出 0，输出在本次 `.cache` 命名空间 | 不是 Android 安装包 |
| prepare 故障注入 | 模板缺失/畸形、写入失败、回滚及幂等均通过 | 未改写当前生成工程或设备 |
| 变更新增行定向凭证模式检查 | 未匹配高可信私钥/token模式 | 不冒充完整供应链或全仓安全审计 |

LSP 主动检查配合完整 vue-tsc 使用。两个辅助静态规则命中的是基线已有的 `unknown` 返回与 prepare 内 JSON.parse；已按冻结副本逐字核对，未借本次任务改写这些无关逻辑。部分 LSP push-only 结果不能证明 clean，不以静默当作通过。

第一轮独立只读审查：`OK with notes`，无 P0/P1 新生产回归；提出 SAF `path` 结果缺真实前端消费 oracle。本轮已补齐真实适配器 + plugin-fs JS 调用路径，覆盖读取成功、读取失败、超限、路径越界、finally 删除及删除失败不覆盖原始错误。第二轮独立只读复核同样为 `OK with notes`，未发现 P0/P1；针对当时的 34 条发布断言指出同步失败和事件顺序覆盖不足。随后补齐同步故障、同步完成后才提交以及非 EXDEV 不进入复制的断言，现为 42 条通过。补测由主代理自审，不冒充再次独立复核；实际审查回执记录于验收记录。

可回查文件：

- `.cache/android-native-20261019/baseline.json`、`baseline/`：恢复点。
- `implementation.diff`、`current-hashes.json`：相对于本次真实脏基线的差异，不是整个仓库旧 Diff。
- `final-regression.log`、`folder-adapter.log`、`typecheck.log`、`build.json`。
- `kotlin/android.log`、`kotlin/host-run.log`、`export-before.log`、`export/current/run.log`。
- `acceptance.json`：测试与未验证范围汇总。

复验命令：

```sh
node --test reader/scripts/test-native-reader-environment.mjs reader/scripts/test-monitored-folder.mjs reader/scripts/test-native-export-commit.mjs
node reader/scripts/check-reader-environment-kotlin.mjs host
node reader/scripts/check-reader-environment-kotlin.mjs android
```

后两个命令依赖本机已安装的 Android / Gradle / Kotlin 缓存；缺输入会明确失败，不自动联网安装。完整 167 项集合见 `final-regression.log` 及当前交付记录。

## 5. 后续阶段与停止条件

### 先做：本次 APK 的 BOOX 实机验收

需要独立获得覆盖安装授权：只在已连接 Note X3 Pro 上操作，保留应用数据，不卸载。签名不匹配时停止，不以卸载解决。

验收至少覆盖：

1. 普通阅读、沉浸、暂停/恢复、锁屏/解锁、系统对话框返回，以及后台期间关闭常亮请求。
2. EPUB / TXT / PDF 打开、翻页、选择、批注与离开阅读；无重复导航。
3. 本地与真实 SAF provider 的小文件、大文件、大小未知/低报、读取失败和权限撤销；核对暂存清理。
4. 已有目标书籍替换的成功及故障路径；核对字节而不是只看 UI 成功提示。
5. 合成书籍 A/B 的首开、章节跳转、翻页 p50/p95、内存峰值和冷/热缓存；单独记录刷新模式。
6. 墨水屏内容真正可读的时间必须用设备/光学证据测量；JavaScript 回调、Android UI 提交时间都不能替代物理刷新完成。

未完成这些步骤前，不对外宣称本次修改已经提高 BOOX 翻页速度、解决 OOM 或完成设备发布。

### 再做：系统文件打开入口

当前 Rust 打开事件只保留能转成普通文件路径的 URL；`content://` 到达该分支会被过滤。但 Manifest 和实际 Intent 投递尚未做本轮运行验证，不能直接宣称所有“打开方式”都失效。

若实机确认缺口：Android 接收系统交付的 URI，在授权有效时流式暂存；Web 接收受控交付 token，复用既有解析、入库和导航。必须覆盖冷/热启动、无扩展名、MIME 不符、重试去重与确认后出队；不得新增任意 URI 读桥。

### 条件实施：页键和 BOOX SDK

先记录真实物理键码和焦点链路。已有 DOM 事件正确时不增加原生桥；新增原生分发时仅处理确认的页键，长按不建立无界翻页队列，默认不占用音量键。

BOOX SDK 以官方样例及目标固件支持为准。刷新策略需要同时看清晰度、残影、闪烁和延迟；不能未经测量强制每页全刷，也不能凭品牌检测调用隐藏反射 API。

### 暂不做：全原生 EPUB / PDF / 界面重写

只有真实端到端数据证明当前后端是主要瓶颈、并且已有书籍位置/批注/搜索/渲染兼容 oracle 时，才评估原生 PDF 栅格后端。EPUB 和 Vue 界面没有达到这个条件。

## 6. 回退与残留风险

- 源代码回退以冻结副本为准，仅撤回本轮引入的差异；回退前先比对 `current-hashes.json`，发现后续漂移必须重新核验，不直接覆盖用户新修改。
- 新增文件仅在确认仍是本轮版本时移除。禁止 `git reset --hard`、清理脏树或撤销其他未提交工作。
- prepare 的原子替换/回滚已在独立 fixture 注入失败验证；本轮未安装，因此不涉及设备数据回滚。
- 已成功写出的外部文件不能靠代码回退撤回。尚未修复的导出超时与取消问题应进入单独的提交语义切片，不能靠盲重试处理。
- 小文件统一暂存可能增加磁盘 I/O；PDF 自适应降采样可能降低高倍率清晰度。均需实机 A/B，不将计算上界当作实测收益。
- 私有临时文件在进程突然死亡时仍可能残留；本轮没有新增跨目录后台清理或完整断电恢复机制。

## 7. 外部依据

- [Android Activity](https://developer.android.com/reference/android/app/Activity)：生命周期与物理 KeyEvent 分发。
- [Android ActivityManager](https://developer.android.com/reference/android/app/ActivityManager)：`memoryClass` / `isLowRamDevice` 为设备提示，不是可用 WebView 堆。
- [Android WebView](https://developer.android.com/reference/android/webkit/WebView)：`pauseTimers()` 影响进程内全部 WebView 的 timers，不适合作为局部阅读暂停手段。
- [Android Os.rename](https://developer.android.com/reference/android/system/Os#rename(java.lang.String,%20java.lang.String)) 及 [Linux rename(2)](https://man7.org/linux/man-pages/man2/rename.2.html)：原子替换与 EXDEV 语义。
- [BOOX 官方 OnyxAndroidDemo](https://github.com/onyx-intl/OnyxAndroidDemo)：公开 SDK 样例存在，不代表当前机型固件已验证兼容。
