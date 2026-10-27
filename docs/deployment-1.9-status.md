# 知页 1.9.0 双包部署回执

**状态：部署完成，限定验证通过（不是完整功能回归）。**

- 收尾核验：2026-10-25 13:36（Asia/Shanghai）。
- 设备：`9D7BC516`，BOOX NoteX3Pro，Android API 32，arm64。
- 版本：`1.9.0` / `1009000`。
- 采用 `adb install -r` 覆盖安装；未卸载、未清数据，未修改 BOOX 全局冻结策略。

## 产物与实际安装

| 类型 | 桌面实际显示名 | 包名 | APK |
|---|---|---|---|
| release | 知页 | `io.pagewise.reader` | `artifacts/Pagewise-1.9.0-release.apk` |
| debug | 知页 1.9.0 测试版 | `io.pagewise.reader.debug` | `artifacts/Pagewise-1.9.0-debug.apk` |

桌面应用列表已核实两种名称。APK 所有语言资源的应用名、版本、包名、既有签名、ABI、SDK 配置均完成静态校验；安装后拉回 APK，并在收尾再次核对设备 APK SHA-256。

- release：`5655f6fbff9370da2c97ecf31afe5c8af1fb371f863baf37f04f9b4e738371e6`
- debug：`87410876fe12e2a566c67ed55177edc02afeee8ad843ba0f9d9435742b77065a`

旧 `1.8.0-ui-fix` 产物保留，仅将状态标记为已被设备上的 1.9.0 替代；没有删除历史 APK 或失败证据。

## 本轮实际验证

### 构建与宿主

- Vue/TypeScript 检查通过，实际覆盖 `appVersion.ts`。
- 本轮关联测试 **67/67**，无失败、跳过或取消。不是把以往不同轮次的数量相加。
- 实际调用 Vite `build()`；release、debug 分别真实重新编译 Rust，不复用旧 UI-fix ELF。
- 两包 Kotlin / Gradle assemble 通过，release R8 通过。
- npm、Cargo 依赖图保持不变；六个版本 owner 统一为 1.9.0。
- 88 个本轮 JS 资源名在各自新 ELF 中命中。这是名称嵌入核验，不冒称逐资源内容哈希证明。
- 安装前独立只读审查通过、零阻断；设备执行证据另行记录，没有用静态审查替代实机验证。

### 物理设备

两包分别完成：

- 藏书、正在阅读、全部笔记、阅读统计、设置五个主页面的包名与原生页标题核验。
- 统计「趋势／年历／概览」三个标签入口触发；这是入口与导航验证，不是所有统计值、日期明细的完整逐项断言。
- 设置「阅读与声音／通用／关于与帮助」目录入口触发，确认原生关于内容实际渲染。未保存或修改用户设置。

debug 另用本任务自有合成 EPUB 验证：

- 正文实际可见、两个目录数据项、Web 焦点/无障碍遮罩已解除。
- 下一页改变实时 CFI。
- 正常工具栏返回完成保存，保存 CFI 与最后可见 CFI 一致，Reader 卸载且旧 owner 已释放。
- 运行时应用版本 API 返回 `1.9.0`。

未在 release 上额外写入合成书，因此不声称 release 合成阅读链路也完成了同等验证。release 曾停留在一个非主导航内容页；未读取内容，仅正常 Android Back 一次返回藏书后完成五页验证。

既有原生关于页没有版本号/版本代码标签；本轮没有为验证而新增该功能。版本依据桌面名称、安装包、PackageManager 与 debug 运行时 API 核对，不伪造「关于页已显示版本号」的结论。

实际屏幕为 1860×2480；运行时 density 300dpi、DPR 1.875、debug viewport 992×1322 CSS px，系统 fontScale 0.85。不能把这些结果等同于预定模拟器矩阵或物理 EPD 波形验收。

## 数据与恢复边界

| 项目 | release | debug |
|---|---|---|
| UID | 10097，不变 | 10095，不变 |
| ceDataInode | 59051，不变 | 52263，不变 |
| firstInstallTime | 2026-10-23 21:06:06，不变 | 2026-10-23 10:55:31，不变 |
| 数据目录 | 原路径保持 | 原路径保持 |

- **release 非 debuggable，没有完整物理 DB/WAL/SHM 备份，也没有全字段或完整库 integrity 对照。安装身份保持不等于证明全部数据逐字节不变。**
- debug 安装前在其 UID 内，对默认 canonical DB、存在的 sidecar 与 locator 做静止字节副本并核验摘要；不是整馆藏/书文件备份，也不单独证明数据库 integrity。
- debug 的合成书测试前后：原有 **8 个书目 ID 摘要一致、2 条批注数量一致、integrity_check 为 ok**。该次基线取于安装后、合成测试前，不冒称新做了完整安装前后数据库对照。
- 合成测试书和其对应 EPUB 文件已移除；临时 JS context、任务专属 ADB forward 已清理。没有宣称正常阅读未留下任何 session/时长统计变化。
- 已保存旧安装 APK，并生成同版本号的旧代码恢复 APK；payload 与签名做了静态核验，**未实际演练代码回滚，更不是数据库备份或数据回滚保证**。

## 收尾与失败证据

- BOOX 曾把 release 设为 `enabled=3`，使直接 `am start` 报 Activity 不存在。通过桌面官方应用图标的可点击 `cover_container` 正常解冻启动，没有执行全局或持久免冻结修改。收尾两包均 `enabled=0`，不承诺以后不会自动冻结。
- debug 首次页标题 oracle 不接受「标题＋聚合摘要」，按生产结构修正测试后通过；没有为迎合断言修改产品代码。
- 关联 Kotlin 编译闭包补入 `NativeStatsSettingsUi.kt` 后 67/67；原失败日志保留。
- APK 首次校验误要求 debug 主 DEX 必须改变，改为比较完整 multidex 集合；真正变化位于 `classes9.dex`，依赖 DEX 相同是正常情况。
- 当前 490 个冻结源码/派生输入与构建、审查 manifest 一致。除版本 owner、测试编译列表及派生版本属性外，没有追加产品改动。
- JNI 恢复原 symlink 形态，指向本轮重编的 raw release ELF；对副本执行同样 strip 后，与已验证 release ELF 完全一致。没有把旧 1.8 ELF 恢复到新产物中。
- 97 个既有生成文件中 90 个不变、7 个发生预期生成变化，无文件缺失；详见生成态回执。
- 两个相关 TS/JS 路径完成主动 LSP 探针：无 error/warning，测试脚本保留 9 条 style hint。不是全工作区 clean 结论；诊断后源码摘要仍一致。
- 指定本轮 app PID 的 Java crash buffer 未见 `FATAL EXCEPTION`；不替代完整 Native crash / ANR 审计。

## 明确未覆盖

- 统计/设置原生 P1 的历史限定结果为 27/27；**其余五个配置仍未执行**，本轮实机字体配置不能顶替它们。
- 完整 TalkBack、复杂 IME、旋转、进程死亡、自定义根、真实 AI 调用/质量、推荐真实馆藏质量、PDF 连续滚动实景。
- 物理 EPD 灰阶可读性、刷新波形、残影和刷新次数。
- 历史真实十本审计仍 0/10，旧 CFI/恢复问题未因本次部署关闭。

## 主要证据

目录：`.cache/deployment-1.9-20261025/`

- `acceptance.json`、`artifact-verification.json`、`device-after.json`
- `independent-preinstall-review.md`、`review-input/binding.json`
- `install-debug.json`、`install-release.json`、`launcher-labels.json`
- `smoke-debug-v2.json`、`smoke-release-v4.json`
- `debug-reader-result.json`、`debug-postcheck.json`、`debug-file-cleanup.json`
- `debug-canonical-backup.json`、`rollback-readiness.json`
- `jni-restoration.json`、`generated-final.json`、`lsp-final.txt`
- `verification-corrections.json`（失败、修正及验证语义说明）
