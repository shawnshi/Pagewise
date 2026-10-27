# 书籍简介生成：源码实现与验收状态

> 历史阶段记录。后续原生弹窗布局已修复，同组16/16合成验收通过；最新范围与限制见[布局修复报告](book-introduction-layout-fix-20261024.md)。下文原始缺口与回执不重写；生产APK尚未打包安装。

## 结论

已实现 Web 与 Android 原生详情页“概览信息 → 生成简介 → 编辑／复制预览 → 确认替换”。本轮只交付源码与合成测试，未调用真实模型，未打包或安装生产 APK，未操作 BOOX 书库。

**整体状态：BLOCKED（原生最终运行验收缺口）。** 持久化、桥接与生命周期独立复审为 `scoped_OK`；修正后的原生代码已编译，但最终 Activity 验收未执行。不能将此状态写成已在 BOOX 生效。

## 功能与边界

- 沿用既有 `aiConfigured()`、`chatStream()` 和当前 AI 配置，不新增服务商、密钥配置或自动回退。
- 保留用户原始提示词、四段分析框架、`500-800 words` 和“语言跟随题名”指令。额外系统约束要求把书目信息当作数据，并说明识别不确定性；没有把字数要求改成汉字数。
- 模型请求仅包含书名、作者、出版社、出版日期和本次可选丛书输入，不包含正文、批注、进度或原简介。丛书输入不持久化，不新增数据库字段。
- 生成不写库。预览可编辑、复制；点击“确认替换”后才提交。原简介不会在生成过程中被覆盖。
- 保存通过 ID、书名、作者、出版社、出版日期和原简介快照做 CAS。Dexie 使用事务，Tauri 使用单条条件 UPDATE；冲突为零覆盖，不退回普通 `updateBook()`。
- 取消／切换书籍会失效晚到生成结果。已提交保存不能假称取消；结果未知时保留稿件，并禁止本轮重复保存或重新生成，要求关闭后重新打开详情核对。
- 生成等待设 90 秒上限，非空输出最多 16,000 字符；即使传输未响应 AbortSignal，界面等待也会结束。不能据此承诺远端计算已经停止。
- 预览仅保存在内存，15 分钟过期、最多 16 份。未实现草稿持久化。
- AI 内容明确标为未经事实核验；本轮没有验证真实输出的事实、语言或 500–800 words 合规性。

## 主要路径

- 生成与提示词：`reader/src/services/bookIntroduction.ts`
- 预览／确认动作：`reader/src/services/bookIntroductionActions.ts`
- 原子简介更新：`reader/src/services/bookDescription.ts`、`reader/src/storage/{types,dexie,tauri}.ts`
- Web：`reader/src/components/BookIntroductionDialog.vue`、`reader/src/views/BookDetailView.vue`
- 原生：`reader/src-tauri/android/NativeBookIntroductionEditor.kt`、`NativePagesController.kt`
- 桥接与复制：`NativeManagementDispatcher.kt`、`NativeManagementHost.kt`、`reader/scripts/prepare-android-project.mjs`

未修改版本号、数据库 schema、书籍／批注 ID、CFI、分类、阅读状态、统计口径、文件夹所有权或设置提交屏障。

## 验证结果

各轮及各类证据单列，不合并原生历史轮次。

- 最终核心／真实存储／相关回归：**53/53**。包括生成、取消、超时、显式确认、书籍归属、冲突零写入、未知结果不重放，以及真实浏览器 IndexedDB／宿主 SQLite 的并发、删除、回滚与重开后持久性。
- Web 合成界面：**9/9**。覆盖编辑保存、原稿保留、晚到回复、书籍切换、保存期间路由屏障、未知结果禁重生／重放、HTML 仅作文本和 320／1400 px 及放大文字布局。所有请求限制在测试回环服务，未访问真实模型。
- 原生 action key：**13 项 JVM 检查通过**。执行从生产 Host 提取的 key 表达式，验证书籍／请求 nonce 隔离、相同保存 token 去重及原有非简介 fence 不变；不是 Android Host 完整生命周期验证。
- 原生编译：compileSdk 36、缓存 Kotlin 工具链，**15 个真实生产模块及两份 fixture 编译通过**。Host／Dispatcher 闭包使用一个明确的编译专用仓储依赖 stub；不称整套生产 APK 编译或原生持久化执行。
- Vue 类型检查：通过。
- 真正调用 `vite-isolated.mjs` 导出的 `build()`：通过，转换 430 个模块，输出到任务缓存；未覆盖旧 `reader/dist`，未执行 Rust 或生产 APK 打包。
- LSP：13 路径中 0 路径确认 clean、12 路径 inconclusive，另有 3 项既有 JSON／校验抛错辅助发现；没有语言服务器 clean 证明。类型检查和编译结果另列，不替代这一缺口。

## 独立复审

初轮审查超时，只留下 BLOCK 报告；没有当作完成。恢复原独立审查员后完成复审：

- `INTRO-REV-001`：新动作加入 Host 就绪合同。
- `INTRO-REV-002`：简介动作按 `[action, bookId, requestId 或 save token]` 隔离 fence，保留旧动作原 key。
- `INTRO-REV-003`：未知提交结果时，两套界面均禁用重新生成及再次保存。
- `SELF-004`：原生延迟 onDismiss 只清理自己拥有的 dialog，不能清除替换后的弹窗引用。

复审结论仅为持久化／桥接／生命周期源码 `scoped_OK`，不是运行批准。

## 原生运行缺口

仅使用 fresh userdata 的 `BookIntroductionUi32 / emulator-5598` 和测试包 `io.pagewise.introduction.test`，没有生产包、私人数据库或 INTERNET 权限。该模拟器按 720 秒期限退出，未停止共享 ADB。

1. `native-activity-v1`：13/13 失败。测试在 AlertDialog 的 onShow 消息执行前点击按钮，属于 fixture 时序错误，不计生产红灯。
2. `native-activity-v2`：**11/13 通过、2 项失败**；失败涉及在异步 dismiss 回调前断言关闭／取消回执。保留原回执。
3. `native-activity-v3`：fixture 新增回调参数后编译失败，未执行 Activity。
4. 修正后 `native-activity-v4`：编译通过，但模拟器已经到期，身份预检拒绝运行；没有最终运行结果。

最终 fixture 已修正并编译，不宣称相关断言通过。旧大字号 Canvas 图仅供定位；底部按钮有裁切迹象，不能将旧几何检查当作最终布局通过。原生最终功能、完整触控／键盘、TalkBack、API 33 返回路径和 BOOX 墨水屏均未完成验收。

不自动续期或换条件重复耗尽的原生验收。下一步须另立有界方案：先完成 fixture 编译预检，再启动 fresh AVD，检查关闭／取消回调及大字号完整按钮可达性。生产打包和设备部署仍需单独授权。

## 证据与恢复

任务目录：`.cache/book-introduction-20261024/`。

- `preflight.json`、`source-inputs-before.json`、`before/`：460 个原源码输入摘要及必要修改前副本。
- `scope-supplement.json`：Host 就绪／fence 修复和独立原生 fixture 的范围补充。
- `final-core-storage-related.log`、`browser-review-fixes.log`、`host-key-runtime/`、`native-host-final-compile/`、`frontend-build-final.log`。
- `native-activity-v1/` 至 `native-activity-v4/`、`android32/process.json`：历史运行及自动停止记录。
- `own-source.diff`、`source-inputs-after.json`、`scope-verification.json`、`acceptance.json`：最终源码绑定与保留缺口。

回退仅针对 `own-source.diff` 中本轮改动，在校验当前字节后恢复相应 `before/` 或移除本轮新文件；不要 reset 脏工作树。这里不是设备数据库备份或已演练的 APK 回退。
