# Pagewise BOOX／Android UI 整改：阶段实施与验证

## 结论

**整体终态：BLOCKED，不是 S0–S4 全部完成，也不具备发布批准。**

R4 阶段的笔记／草稿修复通过定向复审、133 项单元／契约回归、7 项浏览器路径及构建。本轮没有重复这些已完成集合；新增阅读检查点修复另经 11 项测试、完整构建、独立复审和 API 32 原生实测。分版本证据见第 4、8 节。随后获批的项目内生命周期兼容补丁另有 50／50 定向测试、完整构建和独立复审 scoped_OK，见第 9 节；不与历史集合相加。

原正式包的 PW-01 连锁 `native_action_error` 仍未复现／定位。系统字体变化另曾复现 Activity 重建后的 `host_closed` 初始化阻塞；该独立路径已由第 9 节新候选定向修复，不外推原 PW-01。首次文石配置选择、完整 TalkBack／实体墨水屏等仍未完成。本轮没有安装或修改主 BOOX 正式包，没有推送、发布或提交 Git。

## 1. 范围与基线

- 用户批准范围：PW-01～PW-12、S0–S4，本地实现、构建和隔离合成数据测试。
- 受保护内容：原书籍／批注身份、CFI、数据库格式、v1 草稿载荷、统计口径、文件夹所有权、设置提交屏障和未知结果核对机制。
- 两层仓库原有大量未提交修改。基线不是 Git HEAD；保留了原文件、原有差异及生成物恢复点。
- 基线记录：`.cache/ui-ux-20261022/preflight.json`，445 个文件。
- SDK 专项前核对：445 个基线文件均存在；18 个规范源码／测试文件之外没有内容漂移（R4 的 16 个，加检查点 2 个）。后续 SDK 专项另冻结 446 文件，新增 11 文件写集以外无漂移，见第 9 节。
- 根仓库 HEAD：`cff19cb6f9b6242b40cb499410a2adc744ea0c7b`。
- `reader` HEAD：`9027e9a09ef19c1c37cc828c9fd42b21119e1ac9`。两个 HEAD 均未改变。

SDK 专项前的 18 文件代码差异：`.cache/ui-ux-20261022/api32/post-review.diff`。R4 的原始差异与回执保留在上级证据目录，没有覆盖。

```text
588a5079343aca6036a7ec6e5052d86e6a94f22a644c4813bcc4368d1554dcd9
```

逐文件哈希：`.cache/ui-ux-20261022/api32/review-final-input.json`。R4 复审覆盖原 16 文件，本轮复审仅覆盖新增两文件的检查点补丁；不是一次重新审核全部 18 文件。本报告属于交付文档，不冒充代码复审范围。

### 规范变更文件

- `reader/src/views/ReaderView.vue`
- `reader/src/services/noteDrafts.ts`
- `reader/src/services/nativeManagementActions.ts`
- `reader/src/services/readerSession.ts`
- `reader/src/services/textToEpub.ts`
- `reader/src/components/TocList.vue`
- `reader/src/components/TypographyPanel.vue`
- `reader/src/i18n/en.ts`
- `reader/src/i18n/zh.ts`
- `reader/src-tauri/android/NativeLibraryPanel.kt`
- `reader/src-tauri/android/NativePagesController.kt`
- `reader/src-tauri/android/NativeStatsPanel.kt`
- `reader/scripts/test-reader-more-browser.mjs`
- `reader/scripts/test-reader-panels.mjs`
- `reader/scripts/test-ui-ux-text.mjs`
- `reader/scripts/test-native-management-actions.mjs`
- `reader/src/services/onyxNativeAccelerator.ts`
- `reader/scripts/test-native-reader-environment.mjs`

## 2. 阶段状态

| 阶段 | 本轮结果 | 未闭合出口 |
| --- | --- | --- |
| S0 | 冻结源码、原有差异、生成源码和前端产物；建立独立 AVD | 原正式包故障没有在相同数据／系统条件下复现 |
| S1 | 保存前不新增批注；草稿恢复、错误与重复提交保护已修复 | PW-01 根因仍未知，因此 S1 整体未通过 |
| S2 | 已实施藏书、在读、详情、笔记及统计的局部整理 | 不把合成路径正常外推为原正式包已恢复 |
| S3 | 已实施触控、选区菜单、封面交互、排版面板及 TXT 定向修复 | TXT 复杂边界、一般续读定位等仍有未测项 |
| S4 | 构建调试候选，执行定向浏览器与 Android 验证；字号重建和横竖屏基础路径已有专项证据 | 完整横屏／大字体视觉、TalkBack、实体墨水屏和发布验收未闭环 |

依照原方案，PW-01 未闭环前不再扩大视觉改动；未实现的首次推荐配置选择没有被静默改成自动应用。

## 3. 关键语义变更

### PW-02：先编辑草稿，再产生正式批注

- 打开“写想法”不写正式划线；关闭保留本机草稿。
- 新选区草稿采用独立上下文。相同选区在一次正式保存完成后再次新建，仍能产生独立想法，不按 CFI 合并两次意图。
- 草稿到新批注的身份稳定且按书籍隔离。清理失败或回执丢失后的显式重试复用身份，避免重复新增。
- 正式写入确认后保留返回身份；草稿清理失败会留在编辑器并说明状态，不宣称没有保存。
- 写入结果未知时保留输入，提示结果未确认，并提供“查看本书笔记”入口。
- 空正文更新显式发送空字符串，避免原生存储把 `undefined` 当作“不修改”。
- 原生草稿恢复入口携带上下文，书籍加载后直接恢复对应编辑器，无须重新框选。
- 明确放弃只删除指定书籍、指定上下文的草稿。旧 `id` 选择器仍支持；新增仅供选区草稿使用的 `contextId` 选择器，与旧选择器互斥，仍强制 `confirmDiscard`。
- v1 草稿载荷没有新增字段。`draftContextId` 仅是编辑器临时状态，正式写入前被剥离。

### PW-02/R4：坏草稿不能无提示阻断其他书籍

复审发现新增入口的草稿枚举异常原先没有处理。已完成两项失败复现及转绿：

1. 按存储键中的书籍身份过滤后再读取／解析载荷，隔离异书损坏 JSON。
2. 当前书籍／全局读取或解析失败仍是错误，不当作空表继续创建；入口显示持续错误，保留选区和已有输入，不分配新身份、不写正式笔记、不删除损坏数据。

### 其他问题

| 编号 | 已实施内容 | 验证边界 |
| --- | --- | --- |
| PW-01 | 统计读失败不显示为空历史；目标修改受确认状态约束；保留重试与恢复入口 | 人工错误注入通过，不代表原故障根因已修复 |
| PW-03 | 阅读器和目录目标至少 48 CSS px；弹层换行／滚动；搜索与标注文字标签 | 浏览器目标尺寸已测，不是无障碍认证 |
| PW-04 | 自定义选区菜单加入复制、分节全选，按条件抑制系统菜单 | 当前代码有回归；未验证所有 WebView／输入法组合 |
| PW-05 | 搜索提示对比度、管理入口、重复分类与首次空态整理 | 单页藏书的 Previous／Next 在最新原生界面均为 `enabled=false`；没有为此额外改代码 |
| PW-06 | 在读卡优先阅读状态、进度及标签语义 | 未改写或删除用户历史标签 |
| PW-07 | 日期／语言展示、技术文件信息折叠、“笔记与标注”命名 | 不改原始书目元数据 |
| PW-08 | 区分首次空态／筛选空态；零记录不显示分页 | 错误仍单独呈现，不归零 |
| PW-09 | 普通封面图不再被当成交互控件；链接等真实交互元素保留优先级 | 已有合成 EPUB 操作与当前契约回归，不能外推实体屏触感 |
| PW-10 | 排版标签位于控件上方，常用项前置，兼容说明折叠；标注有文字辅助 | 首次“文石推荐／保持当前”选择未实现；未改系统前光／刷新模式 |
| PW-11 | 局部标题与容器规则、焦点语义、触控目标整理 | 原生草稿区域仍有中英混用；完整 TalkBack／横屏／大字体视觉未验收，字号重建基础路径见第 9 节 |
| PW-12 | 严格 UTF-8→GB18030 解码；空文本报错；内存 EPUB 语言为 `und`，布局版本仍为 `2` | 编码样本和定向转换已验证，未声称所有文本边界通过 |

“全选本章”改为“全选当前分节”，因为一个分节可能包含多个 TXT 章节。

## 4. 分版本验证证据

### R4 历史自动化与构建（本轮未重复执行）

| 检查 | 实际结果 | 回执 |
| --- | --- | --- |
| 原验收集合及相关新增契约 | 133／133，通过；源码前后哈希一致 | `r4-validation.json`、`final-contract-r4.log` |
| 浏览器笔记路径 | 7／7，通过；应用级外联拦截无外部请求，`pageErrors=[]` | `browser-final-r4.log` |
| R4 失败复现 | 两项红转绿 | `review-r4-red.log`、`review-r4-green.log` |
| Vue／TypeScript 与 Vite | 成功 | `android-build-r4.log` |
| Android APK 构建 | 退出 0；规范 Kotlin 已编译 | `android-build-r4.log` |
| 独立复审 | 原三项已修复；R4 及直接闭包 OK，无新增阻断 | `independent-review-round2.md`、`independent-review-r4.md` |

以上回执均位于 `.cache/ui-ux-20261022/`。独立审查与物理执行分开计证；审查者未重新执行测试，未独立重算哈希。当前源码哈希由主执行方确定性复核。

浏览器开发服务器日志有 `ResizeObserver` 警告，不描述为完全无警告。LSP 主动检查 16 个路径：0 个确认 clean，14 个 inconclusive，`ReaderView.vue` 超出 5,000 行限制；另有一项 `new URL(url)` 的辅助规则告警，已核对其代码在冻结基线中存在且未变。完整类型检查和 Android 构建是另一条证据，不把 LSP 缺口称为全绿。构建保留既有 Android／Java／Gradle 弃用警告。

最新常见凭据模式扫描覆盖 18 个规范源码／测试文件，0 命中，记录于 `api32/source-secret-scan.json`；不是全库或运行时缓存的秘密审计。

### 隔离 Android：统计错误态

环境为任务独立 `PagewiseAudit`、`emulator-5580`，仅合成数据。通过捕获既有原生请求事件并回复一次 `simulated_read_error`，没有修改不可写的 Tauri IPC 方法，也没有绕过请求 nonce。

- 首次读取失败：明确说明不是空历史，不显示虚假的今日零值，提供重试及恢复入口。
- 同面板已有结果时读取失败：标明旧结果非最新，保留展示但禁用目标修改。
- 重试后恢复真实结果与目标控件。
- “Inspect settings / recovery” 确实打开恢复界面；未点击重应用或放弃设置。

结构化回执：`native-stats-fault-results.json`。首次 CDP 未就绪的尝试及旧不可写方法注入未命中，不计为通过证据。

### 隔离 Android：TXT 与草稿

- 通过系统文件选择器一次导入 UTF-8 BOM 英文 TXT 和 GB18030 中文 TXT，藏书从 1 项变为 3 项。
- 两者均在真实 WebView 打开；正文可读，内存 EPUB 声明为 `und`，观测到正文 DOM 语言分别为 `en`／`zh`。
- 英文 TXT：打开编辑器后正式批注为 0；真实输入并关闭后仍为 0。
- 从原生“全部笔记→恢复编辑”直接恢复文本与原选区，未重新框选；保存后为 1 条，草稿清理完成。
- 再建草稿，经原生明确放弃确认后草稿为 0；已保存批注及其 ID／正文保持不变。
- 软键盘打开时，依据 `visualViewport.offsetTop + height` 核对按钮位于可见区域，并实际点击关闭。不能只拿 `visualViewport.height` 与布局坐标比较；这不是全部键盘场景验收。
- 中文 TXT 正文与目录条目已观测。一般退出重开续读、改字号后定位、横屏、大字体、复杂重复章节及大文件等尚未闭环；模拟器时限结束后未继续重试设备操作。

结构化回执：`native-reading-results.json`；截图／XML：`android-evidence/r4-txt-*`、`r4-native-draft-return.*`、`r4-native-discard-*`。中文正文与目录的渲染依据为 `r4-txt-gb18030-toc.png` 及后续 DOM／XML；`r4-txt-gb18030-open.png` 仍是 Opening 首帧，不算正文渲染通过证据。探针截图与 XML 有采集时间差，不能当作同一瞬间。

## 5. 候选包

```text
.cache/ui-ux-20261022/Pagewise-1.5.0-lifecycle-reviewed-debug.apk
SHA-256: 9e5c4e2d6fac1cb0526b46e40b2257bd749367db623fa6fbb275950b186dd68d
applicationId: io.pagewise.reader.debug
versionName: 1.5.0
versionCode: 1005000
size: 614415236 bytes
```

这是含调试产物的验证包，不是 release 发布包。`apksigner verify --print-certs` 退出 0，证书为 Android Debug；已成功更新安装到独立模拟器的调试包，未安装到主设备。当前元数据见 `lifecycle/candidate-final.json`；检查点候选及 `api32/candidate-checkpoint.json`、旧 R4 候选均保留。

## 6. 恢复与清理

- 恢复点：`before/`、`before-generated/`、`before-dist/`，以及原有 `*-existing.diff`；路径均相对于证据目录。
- 规范 Kotlin 经 `android:prepare` 同步并参与最终编译；生成目录不是唯一修复来源。SDK 专项恢复点及最终 11 文件清单见第 9 节。
- 如需撤销本轮改动，先核对当前哈希仍匹配清单，再仅逆向本轮差异；新建文件按本轮清单单独处理。不能用 `git reset`、HEAD 或全目录覆盖损坏用户既有修改。此处仅静态核验恢复点，未执行实际代码回退或数据恢复。
- SDK 停机控制已定向验证：60 秒触发停机的试验实际约 67 秒确认退出；本轮 3,600 秒时限实际 3,607.07 秒确认退出，退出码 0，任务模拟器进程数为 0。
- 未关闭共享 ADB 服务或清理用户其他环境。R4 旧 AVD 内的探针 XML 随旧缓存保留；本轮 API 32 的远端探针 XML 已删除、CDP 转发已移除、Guest 字体／旋转配置已还原，随后优雅停止。历史回执见 `api32/cleanup.json`；最新专项见 `lifecycle/cleanup.json`、`process-exit.json`，任务 QEMU 为 0。
- AVD、缓存和旧候选仅作为本任务恢复／证据，不作为对外分发物。

## 7. 继续条件

API 32 镜像准备已获批准并完成，未安装到全局 SDK。原跨页 PW-01 仍缺少可复现的原环境证据；不擅自读取私人书库或覆盖主设备。

项目内生命周期专项及随后 SDK 兼容追加范围均已获批准。现已实现锁定 Tauri 2.11.5 的项目内覆盖，未升级依赖或修改全局 SDK 源码。批准原文与当前验收边界见 `docs/android-lifecycle-implementation-20261023.md`；不因此获得主设备、私人数据或发布权限。

## 8. API 32 补充验证（2026-10-23）

### 环境与供应链

官方 Google `dl.google.com` 元数据及归档摘要已保存。标准镜像约 637 MiB，但仅支持 x86_64，不能运行现有 ARM64 APK；随后使用官方 Google APIs API 32 镜像，确认 `libndk_translation.so` 兼容层和 ARM64 支持，两个既有 APK 均原样安装成功。没有为此重编译 x86 包或升级应用依赖。

有效环境：1860×2480、300 dpi、`font_scale=0.85`、Android API 32、补丁 2024-01-01、WebView 120.0.6099.193。BOOX 的 WebView 146 是未匹配变量，不能宣称两环境完全相同。历史镜像仅用于无账号、无私人资料的合成测试；已关闭 Guest 无线网络，不冒充安全生产环境或完整 OS 沙箱。

许可证正文与现有已接受文本仅有空白差异，未新增同意、未改许可标记。归档先匹配官方 SHA-1，再记录本地 SHA-256；每段下载／解包均记录墙钟。全局 SDK 的原有元数据与许可摘要未变。一次配置继承导致的错误镜像路径已保留为 `wrong-sysdir-*` 失败证据，未算作 Google 镜像通过；有效启动另核对了实际加载路径。

### 旧正式包对照

原 APK 哈希仍为 `3fec36cf84c0b0d3c1b8caffed60615e7a96d52f549610631e997e3ca3e86738`。空统计、合成 EPUB 目录、统计→藏书／在读，以及产生 2 分钟合成阅读记录后均正常；切换中文后仍未出现原 `native_action_error`。这是“未复现”，不是原故障已修复。结构化记录：`api32/formal-navigation-results.json`。

### 阅读检查点接收者修复

旧包在阅读时捕获 `Java bridge method can't be invoked on a non-injected object`。`onyxNativeAccelerator.ts` 原先将 Java 方法取出后直接调用，丢失注入接收者；现仅改为成员调用，保留全部参数、限幅及布尔／fallback 语义。

- 新回归先出现 10 过 1 失败，修复后 11 项通过。
- 完整前端／Android 构建退出 0；两文件 LSP 没有诊断但覆盖仍 inconclusive，不称全绿。
- 独立复审 `8754ee3f-0b9b-48fd-ac58-9f61e7eae9c8`：仅此极小范围 OK with notes，未重跑测试或独立重算哈希。
- 新包在 API 32 上，封面真实右侧点击进入正文；原生检查点的 CFI 与当前位置一致，时长增量为 0；接收者异常消失。仍有与旧包相同的字体 fallback／网络异常，未称日志无警告。
- 检查点内容由探针显式消费读取；生产代码未接入 `consumeReadingCheckpoint`，不能宣称原生恢复链已闭环。

回执：`api32/checkpoint-only.diff`、`checkpoint-input.json`、`bridge-receiver-red.log`、`bridge-receiver-green.log`、`checkpoint-independent-review.md`、`checkpoint-cover-next.json`、`android-build-checkpoint.log`。

### TXT 与 S4 出口

英文 TXT 的退出重开 CFI 完全相同，后台返回 CFI 也保持，见 `api32/txt-resume-result.json`、`background-return.json`。未重复旧的 133／7 项集合，也不把旧集合自动升级为本轮全量通过。

系统字体从 `0.85` 改为 `1.3` 后，正式包与候选均进入 `host_closed` 阻塞。已单独保持竖屏、用原正式包验证字体变量；候选的 3 本／正式包的 1 本合成书仍可查询，没有清数据。静态代码显示原生页面插件捕获旧 Activity，而实际 Tauri 2.11.5 管理器只初始化首个 Activity。证据见 `api32/activity-recreation-finding.json`。该历史候选的“大字体下连续可用”和 Activity 重建验收失败，横屏联合截图也不算通过。后续定向修复及新包证据见第 9 节；此问题与原 PW-01 的因果联系仍未成立。

## 9. 已批准的生命周期 SDK 专项

详见 [实施与定向验证](android-lifecycle-implementation-20261023.md)。锁定 Tauri 2.11.5 的项目内覆盖、新 Activity 插件实例／launcher、owner／ticket／epoch 隔离、早到 WebView 暂存已实现。复审发现的 picker 清理 P1，以及 SDK 未知结果与现有 mutation 屏障的兼容问题，均已红转绿。

- 最终 11 文件差异：`lifecycle/implementation-final-input.json`、`implementation-final.diff`，SHA-256 `5676a6529d416d09737666c56c2789e8144a35959780e83cd9cd72bb58a7eb09`。
- 定向测试 50／50；完整前端／Android 构建退出 0。独立 reviewer `0632ab93-d6a2-4e77-af7f-031f681c0c11` 结论 scoped_OK，未独立重跑测试或重算哈希。
- 最终包 API32 实测：字号 0.85→1.3 后 Activity 实例改变，书库／详情／目录／统计可用；SDK 共享 picker 槽占用→拒绝→释放→再次打开成功。打开 chooser 期间改字号、取消返回后，新 chooser 仍可用，未改变目录所有权。
- TXT 字号重建后阅读起点相同，可见范围末端变化，不宣称完整范围 CFI 相同；普通后台返回完整 CFI 相同。横竖屏仅做基础路径，不是完整视觉验收。
- 上游 28 文件哈希未变，授权写集外无漂移，两层 HEAD 未变。恢复了 Guest 设置并移除自有探针／forward，优雅停机，任务 QEMU 为 0。

最新状态为 `lifecycle/scope-decision.json`，自动化／原生证据分别见 `final-affected-tests.log`、`native-acceptance.json`。整体仍 BLOCKED：原 PW-01、完整未决写入／长期任务原生故障注入、首次配置、TalkBack、实体墨水屏及发布验收均未闭合。
