# 正式版10本随机书测试：数据安全阻塞与问题分析

## 结论

**本轮未完成10本书测试。正式包在书库分页期间检出 canonical 数据库 `lightread.db` 损坏，Android默认处理器还记录了删除数据库文件的尝试。已停止正式包，禁止本轮脚本继续操作。**

这不是“标签编辑和阅读全部通过”，也不能只作为一般的分页慢处理。下一步必须先取得现存数据库及其日志文件副本，再做隔离、只读校验；不能在原库上继续重现、切换journal或运行修复。

**已确认数据库损坏异常及删除尝试；尚未物理验证文件是否删除、是否已重建空库，以及书目、批注、标签、进度的完整性。书籍原始文件是否保留也未核验。** 界面残留的2,243项不能作为数据库仍完整的证明。

## 范围与实际完成情况

- 设备：NoteX3Pro，API32，arm64-v8a，1860×2480，300dpi，字号0.85。
- 包：`io.pagewise.reader`，正式release变体，1.6.0 / 1006000，非debuggable。
- 从设备拉回的APK SHA-256：`921ec896d509a34c2f922236bddeb7f19d58834aca0d0b4a051b0f3c9a6c1fa8`，与上一轮已部署修复包一致。
- 已安装版本对应的454项源码摘要与当前磁盘一致。本轮未改程序源码、依赖、安装包或全局设备策略。

书库界面显示2,243项、每页12项、187页。固定种子`20261023`、无放回抽出的零基位置为：

```text
B01=1036 B02=1082 B03=827 B04=2185 B05=1444
B06=985  B07=1503 B08=93  B09=1667 B10=315
```

这些是**计划位置，不是已测试的10本书**：尚未绑定书籍身份，排序/筛选会话也未完成冻结。准备先到第8页的B08时受阻。

实际覆盖：

- 接入正式包；从原先已打开的阅读页正常返回，并进入原生书库。
- 分页由第1页到第2、3页；前两次脚本未及时确认，后来界面实际更新，不能计成两次确定的程序失败。
- 第三次观察约55.5秒仍停在第3页，随后顶部可见`native_action_error`。
- **随机目标书籍查看0/10，标签编辑0/10，随机目标书籍阅读0/10。** 原先阅读页的返回不是随机样本，不能充数。
- 未打开标签编辑器，未添加测试标签，未提交书籍元数据修改；但正常离开阅读页可能落盘进度/时长，分页本身也会保存UI会话，不能声称整个过程没有数据库写入。

## R10-01｜P0：数据库损坏后进入默认删库处理路径

**实机证据。** 同一正式进程PID15135的日志：

```text
13:35:09.886 SQLiteLog: (11) database disk image is malformed in "PRAGMA journal_mode"
13:35:09.887 SQLiteDatabaseCorruptException ... code 11 SQLITE_CORRUPT
13:35:09.887 DefaultDatabaseErrorHandler: Corruption reported by sqlite on database
13:35:09.905 SQLiteDatabase: DB wipe detected ... reason=corruption
13:35:09.917 DefaultDatabaseErrorHandler: deleting the database file
```

本地筛查确认涉及正式包内部`lightread.db`，报告不保存完整私有路径。没有`delete failed`日志，但**没有失败日志不等于删除成功的物理证明**。

**程序保护缺口。** `NativeStateStore.kt:131-133`检查文件存在后，调用两参`SQLiteDatabase.openOrCreateDatabase(file.path, null)`，没有传入应用自定义的保全型损坏处理器。开库后的schema检查，不能阻止开库内部已经发生的默认损坏处置。

[AOSP Android12.1默认处理器源码](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-12.1.0_r1/core/java/android/database/DefaultDatabaseErrorHandler.java)显示：`wipeDetected`先记录，再进入`deleteDatabaseFile`，后者调用`SQLiteDatabase.deleteDatabase`。设备日志也确实到达“deleting”阶段；删除最终结果仍需物理取证。

**建议顺序：**先保全，再修改开库/损坏处置，使损坏进入明确的非破坏性阻断；禁止默认删除、自动用空库顶替或未经授权重放写入。当前不要直接修改PRAGMA或升级依赖。

## R10-02｜P1：同进程两套SQLite实现共同访问一份数据库

**源码与构建已确认的危险结构；尚未证明就是本次损坏的唯一原因。**

- Android入口：`NativeStateStore.kt:133`使用系统`android.database.sqlite.SQLiteDatabase`；`NativeImportDatabase.kt:19-22`也访问同一`lightread.db`，并带`ENABLE_WRITE_AHEAD_LOGGING`。
- Rust入口：`storage/tauri.ts:120-121`使用`tauri-plugin-sql`打开`sqlite:lightread.db`。
- 离线feature解析确认`sqlx-sqlite 0.8.0 → libsqlite3-sys 0.28.0`启用`bundled`；与已部署APK匹配的原生ELF无系统SQLite共享库依赖。
- `NativeStatePlugin.kt:33`每次请求创建并关闭`NativeStateStore`，而其他连接可能仍然存活。

[SQLite官方故障说明§2.2–2.3](https://sqlite.org/howtocorrupt.html)明确列出：同进程多份SQLite各自维护文件锁状态，一方关闭连接可能解除另一方仍依赖的POSIX锁，造成损坏。这不是“SQLite允许多连接，所以必然安全”的场景。

日志另有WAL→TRUNCATE协商时的锁告警，支持连接策略存在冲突，但**不能仅凭锁告警断言损坏成因**。本轮未取得现场数据库、锁状态或连接时序，故保留因果缺口。

建议保持“原生管理页＋Web阅读器”界面架构，单独决策数据库执行/连接所有权；统一journal名称或增加单通道mutex，不能未经验证就当成解决了跨实现文件锁问题。先在隔离合成库中复现并做完整性校验。

## R10-03｜P1：错误隐藏、旧结果残留，用户无法判断当前状态

**实机证据与源码一致。**

- 分页失败后，旧书目、旧页码、阅读按钮及分页按钮仍保留。
- 错误放在顶部状态文本中；停在页尾的用户看不到错误。本轮向上滚动后才看到`native_action_error`。
- 失败画面没有清晰说明“旧结果”“未提交的新页”“数据安全阻断”，按钮仍显示可用。
- 界面直接暴露开发错误码，无法区别数据库损坏、繁忙、宿主失效或普通加载失败。

`NativeLibraryPanel.kt:336-400`的保存会话/加载失败路径主要更新`status.text`，而分页与行操作仍位于原结果区域。建议增加可见、持久的失败状态和明确的数据新鲜度；对数据库损坏阻断写操作，不能只放一个可被滚走的字符串。

证据：`native-error-header-redacted.png`、`pagination-redacted.png`、`native-library-error-final.json`。截图只包含公共错误/控件区域。

## R10-04｜P2：普通交互承担过重的整库及会话保存成本

**静态结构问题，尚无干净的耗时基线。**

- `NativeLibraryPanel.kt:389`分页先保存UI会话，再查询结果，恢复状态写入失败会阻断本次分页。
- `remember()`在进入书籍前，通过`action.librarySelectionPage`每批500收集整个筛选集的ID，再保存`orderedBookIds`，而不是仅为当前书建立最小导航上下文。
- 按界面显示的2,243项计算，全量收集需要5次selection-page调用，再加会话保存，位于进入书籍前的串行路径。
- `NativeStateStore.kt:133-147`每个请求重新开库，并执行8项`CREATE TABLE IF NOT EXISTS`和schema检查；需要确认是否必须在每次短请求中承担这些工作。
- 187页只有前/后翻页入口，深页定位成本高；不能把这种成本全部推给搜索。

建议在数据保全与数据库所有权修正后，再用合成大书库量化：输入→确认、进入书籍前IPC次数、开库次数、DB等待及渲染阶段。不在损坏原库上继续压测。

## R10-05｜P2：原生与Web底栏同时出现在可访问树

`library-before-sampling.json`同时记录Web的“书库/设置”和原生“藏书/设置”等控件，区域重叠。说明原生管理页显示时，底层Web导航仍被UIAutomator暴露。

这是已观察到的可访问树重复，不等于已经完成TalkBack测试；需要核查焦点是否可能进入被覆盖控件、是否重复播报。修正时要保留后台桥接所需生命周期，不能简单销毁WebView解决。

## 性能数据的边界

本轮仅取得现有进程的快照/累计计数：

- PSS 269,731KiB，约263MiB；RSS 370,496KiB，约362MiB。
- gfx累计975帧、504帧janky（51.69%），含此前会话，未清零且没有空载对照。
- 首次`am start -W`是HOT：TotalTime90ms、WaitTime96ms，不是冷启动或正文ready耗时。
- 55.5秒是包含UIAutomator取树开销的未确认观察窗口，不是可直接报告为每页平均加载时间的指标。

这些数据不能证明内存泄漏，也不能把墨水屏上的gfx统计等同普通手机帧率；本轮没有合格的P95、冷启动、大书解析、物理残影/闪烁或连续阅读基线。

## 停止、保全与剩余未知

13:39:38已仅对`io.pagewise.reader`执行force-stop并确认进程停止。仍安装、enabled=0、数据目录inode52086；目录inode不变不证明内部DB未被删除或重建。`stopped=true`是本轮安全停止，不是重新被文石冻结。debug包未动。

未卸载、清数据、重启、切journal、运行integrity_check或修复命令；未通过ADB/主机工具直接读写数据库文件。任务临时CDP forward已移除，未改剪贴板和全局设置。脚本加了安全停止闸门，阻止误续测。

**目前仅有APK、脱敏日志和截图，没有数据库物理副本。APK不包含书库数据备份。** 当前shell为普通UID2000，正式包非debuggable，未尝试绕过私有目录权限。需要先确认现有备份或不启动正式包的受控提取途径。

损坏是在本轮普通操作期间被检出的；无法仅凭现有证据判断损坏何时开始，也不能证明某次分页、锁冲突或双SQLite实现单独造成了本次故障。原PW-01是否同因仍未知。

在副本取得并只读核验前，暂不要打开正式版、重装、清库或运行自动恢复。后续修复、数据库取证及重新完成10本测试需按各自授权和保全门推进。本报告不是完整10本验收，也不是独立红队复核。

证据目录：`.cache/release-10book-audit-20261023/`。
