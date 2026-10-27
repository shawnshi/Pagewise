# R10 后续验收：UI 源码门关闭，整体仍 BLOCKED

## 结论

**已在任务模拟器启动资源绑定候选，修复 UI 失效准入及独立复核发现的 2 项 P1、1 项 P2。45 项相关测试通过，源码独立复核为 `scoped_OK`。没有部署真实设备，也没有恢复原损坏数据库。**

整体仍为 **BLOCKED**，不得安装到真实书库或发布：

1. 正式数据库尚无 DB/WAL/SHM 物理副本，原记录是否删除、重建及可恢复程度未知。
2. 新发现 `R10-FAST-RETURN-CFI-01`：快速首次打开后返回，Reader 已卸载，但 CFI 未保存；三次同条件试验后停止。第三次已等到 `foliate-view.lastLocation.cfi` 就绪，仍读回空位置，不能仅归因于正文尚未加载。
3. 最终 release 只确认签名、安装和启动指令成功；首次 UI 树为空，第二次观察遇到模拟器期限结束，**内容就绪未验收**。本轮新增合成数据的最终数据库副本与完整性检查也未取得。

原 10 本真实书审计仍是 **0/10**。合成数据不能替代该审计。

## 执行边界与源码修补

承接已授权的 R10 修复及“继续”验收，只使用任务 AVD `PagewiseAudit32Google` / `emulator-5580`。真实设备 `9D7BC516` 仅核对非敏感包/备份能力元数据及正式包无 PID，不启动、安装、清数据或读取其私有数据库。

本轮生产代码仅改动：

- `reader/src-tauri/android/NativeLibraryPanel.kt`
- `reader/src-tauri/android/NativePagesController.kt`

新增测试：

- `reader/scripts/test-native-library-admission.mjs`
- `reader/scripts/test-native-library-admission-async.mjs`

保持原生管理页＋Web 阅读器、包名/版本、持久化格式、书籍身份、CFI 及已接受业务/未知结果合同。没有升级依赖、改锁文件、修改全局 SDK/Cargo 配置或提交、推送。

### 已关闭的问题

- **失效后的元数据/弹窗准入**：失败递增 epoch，锁存 fatal，停用旧结果；保留已有输入，禁用弹窗肯定/清除/列表操作，迟到回调不能重新添入可用控件。
- **R10-UI-MENU-01，原 P1**：面板失败通知控制器；控制器 `currentDialog` 同步失效。菜单入口、回调、最终修改/移除入口和移除确认重查准入；旧菜单不能使用允许离开的 `canLeave()` 绕过屏障，确认同时核对 generation。
- **R10-UI-NAV-01，原 P1**：打开书籍时捕获 epoch；会话保存回执到达后先释放 `navigating`，再核对 epoch 和当前准入。已经接受的保存仍可结算，不新增取消或业务重放。
- **R10-UI-RECOVERY-01，原 P2**：阅读页“显示更多”的中间页读取失败、目录变化、合并数量不符及 JSON 异常统一进入失败态，提供普通错误重载入口，fatal 不提供循环重试。

此前构建清单与工作树存在 Kotlin 格式漂移；已保留两者，并对受影响文件做忽略空白、注释和尾逗号后的 token 比对。没有覆盖用户格式改动或重写旧构建哈希。本轮最终冻结 **452 项输入**，收尾检查无漂移。

## 验证：分层报告，不合并计数

| 层级 | 实际结果与限制 |
| --- | --- |
| 相关测试 | `related-ui-green.log`：**45 通过 / 0 失败**。包含下面两层测试，不再相加制造总数。 |
| 纯 Kotlin 准入 | 生产准入函数 **64 组合**，4 项顶层测试通过。其余部分包含静态连接断言，不能冒充真实弹窗测试。 |
| 异步顺序回归 | 原样提取生产 `remember`、`showFailure`、`collectReadingPages`、`patchBook`、`removeBook` 等方法，在受控 transport/UI 端口及既有 JSON adapter 上执行。冻结的 v1 源码 **7 失败 / 2 成功**；v2 **9 场景通过**。覆盖迟到回执、旧确认、未知批次、已接受写入结算及补齐页失败。不是 Android instrumentation。 |
| 最终 debug 实际运行 | `498933…` 已在任务模拟器安装/启动，原生页就绪，包含 **2,243 本本轮合成书＋3 本既有合成记录**。错误条滚动前后均为 `[45,172][1815,226]`；可见旧按钮禁用，普通错误可显式重载，fatal 无重试入口，根页 Back 返回 Android 启动器。错误是受控协议注入，未故意损坏该数据库。 |
| 搜索/IME | 较早 v1 候选实际暂挂取页请求，继续输入并使用 IME Back，释放回执后保留最新 `R10 synthetic`，实际页尾为 `1 / 187 · 2243 items`。此证据没有改称 v2 实测。 |
| Web/原生遮挡 | 最终 debug 原生页确认显示后 `#app` 为 `aria-hidden=true/inert`；实际进入 EPUB 后恢复原始 `aria-hidden=null/inert=false`，正文内容文档及 2 项目录可读。未完成 TalkBack、键盘焦点及实体墨水屏验收。 |
| 书籍端到端 | B01 的标签主题保存、移除任务主题并保留 legacy 标签、EPUB 打开、实际下一页触控、工具栏返回处理器、Reader 卸载及 CFI 读回通过。B02/B03 标签清理完成，但快速返回后的 CFI 断言失败；其余 7 个合成样本未继续。返回调用使用实际 `__pagewiseReaderBack('toolbar')`，不是伪造保存 ACK。 |
| 最终构建 | debug 完整 Kotlin/Gradle、release Kotlin/R8/assemble 均退出 0。沿用已冻结、字节核对的 Rust/前端 ELF；本轮未改 Rust/前端，Kotlin 已重新编译。release 仍有 Kotlin metadata 不兼容诊断及 R8 警告，不能称为无诊断构建。 |
| LSP | 4 个变更文件探测：73 项辅助诊断，0 个确认 clean、1 个 findings、3 个 inconclusive；不声称 LSP 全绿。物理编译和测试另列。 |
| 数据完整性 | 上轮 API32/SQLite3.32.2 的 19 项后端防护证据仍归上轮；**没有把它当成本轮新增合成库的最终 integrity_check**。原真实库始终未开库检查。 |

有限性能观察：任务模拟器中 2,246 项完整 metadata 列表的三次调用约 **1,154 / 1,015 / 989 ms**，包含桥接和解码。不是 BOOX 实机分页延迟、冷启动、P95 或泄漏证明；不与此前真实库异常分页观测直接比较。

### 新阻塞：快速返回未落库

`R10-FAST-RETURN-CFI-01` 的稳定条件为：首次快速阅读后，返回处理器接受、路由离开 Reader，但 `getBook().location` 仍为空。

- 两次快速场景分别在 B02、B03 观察到空位置。
- 第三次 B03 等待 **1,511.5 ms**，确认 live CFI 已存在，再调用实际工具栏返回处理器；返回 `true`、路由 `#/book/r10-1415`，仍 `hasSavedCFI=false`。
- 较长 B01 会话能读回 `epubcfi`，是可保存路径的对照，不消除快速返回缺陷。
- 根因尚未建立，尚未修改 Reader 保存代码。已经达到三次语义试验上限，**不自动开展第四次试验**。

测试过程中也修正了观察器：Enter 后输入框已失焦；过滤数量位于页尾而非全库汇总；根页 Back 会退出 Activity；已有进度的按钮是 `Continue reading`；保存后读回须等待提交 revision。失败回执保留，没有通过重复未知保存或删除断言制造通过。上述修正不能解释或消除最后一次 live-CFI 就绪后仍未保存的结果。

## 候选、复核与证据

最终候选仅存放在验收缓存，**不是可部署成品**：

```text
.cache/r10-acceptance-20261023/Pagewise-1.6.0-r10-admission-v2-debug.apk
SHA-256: 498933a5e0326e447a94afd3401c2019382f65ba95dbed9bafc2386909fdbbfc

.cache/r10-acceptance-20261023/Pagewise-1.6.0-r10-admission-v2-release.apk
SHA-256: 5b4067c8e3fc3f52d9a7bc5d4080c97a2b2d9cd1615e79ef2ae0fdd5d6b67796

source-inputs-v2.json SHA-256:
901bb44c4b44c72a8e4151661a835d651521859cec907047c076863eaf60224f
```

安装前 APK 哈希、manifest、签名及内嵌原生库核对通过；通过标准 ADB 安装。未拉回模拟器安装后的 `base.apk` 作字节级回证。沿用原 Android Debug 侧载证书，不是商店发行签名。

独立审查保留两份：

- `651eac14-71ae-467d-ad1a-ec2354c33672`：BLOCK，发现 2P1/1P2。
- `9794516c-246a-485f-872d-182b5a033428`：三项关闭，`scoped_OK`。仅通过该源码门，不审批运行、原库保全或发布；没有独立重跑测试或重算哈希。

可回查证据根 `.cache/r10-acceptance-20261023/`：

- `preflight.json`、`format-drift.json`、`before/`、`before-review-fix/`
- `source-inputs-v2.json`、`final-own-source.diff`、`ui-review-fix-v2.diff`
- `admission-green.log`、`async-kotlin-red/run.log`、`async-kotlin/run.log`、`related-ui-green.log`
- `independent-ui-v1.md`、`independent-ui-v2.md`
- `v2/guarded-live-ready.json`、`v2/failure-case.json`、`v2/transient-fixed-notice.png`
- `v2/books-cases.json`、`v2/fast-return-blocker.json`、`v2/fast-return-final-attempt.json`
- `v2/release-startup-final.json`、`cleanup.json`、`acceptance.json`

## 原库保全、收尾与下一步

正式包 targetSdk 36、非 debuggable；`allowBackup` 不保证可提取。Android 12 官方说明：target API31 及以上应用的数据默认不包含在 `adb backup` 中，开发测试 opt-in 需要 `android:debuggable=true`。因此没有试运行不可靠的 ADB 备份，也没有为提取而改包、覆盖正式安装、绕过私有目录权限或调用云备份。

来源：[Android 12 behavior changes — ADB backup restriction](https://developer.android.com/about/versions/12/behavior-changes-12)。可用的近期备份或厂商离线能力仍需用户提供/确认，不将能力未知说成“无数据”。

收尾事实：

- 真实正式包最后核验无 PID，本轮未安装或启动；debug 真机包也未操作。
- 两段任务模拟器期限均已结束，最后为 `task_deadline`；不再启动。没有清除 userdata，共享 ADB 未停止，自有 `tcp:19258` 已不存在。
- JNI 恢复为指向同一原始目标的符号链接，原目标 SHA-256 `2cf15c…` 核对一致；不是把 APK 中 stripped ELF 当成原始目标恢复。
- 452 项输入无漂移；4 个本轮源码/测试文件的三种凭据模式扫描无命中，不作全项目秘密保证。未 reset、暂存、提交或推送。

下一步先取得原 DB/WAL/SHM 可用副本；然后为快速返回 CFI 问题制定新的受控定位/修复方案，再补 release 内容就绪、合成库完整性及未完成的运行验收。**原库保全和 Reader 关键断言未关闭前，不恢复真实书测试或正式部署。**

本报告补充而不改写 [上轮 R10 程序整改报告](r10-repair-20261023.md) 的历史失败与门禁记录。
