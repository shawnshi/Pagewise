# 知页 1.5.0 启动初始化修复

状态：启动故障已修复，两版同证书覆盖安装，有限真机启动检查通过。不是全部原生功能或发布验收完成；本补丁未进行新的独立复审。

## 故障与根因

问题编号：`STARTUP-SQLITE-ROW-01`。

测试版现场显示初始化错误代码 `native_state_error`：模块已执行，但 Vue 未挂载，初始化错误面板仍在；原生存储/页面能力版本均为 1。未发现对应 Activity 致命崩溃。

`NativeStateStore`、`NativeLibraryRepository` 和 `NativeImportDatabase` 用 `execSQL` 执行 `PRAGMA busy_timeout=5000`。该语句会返回结果行，Android SQLite 要求走查询 API；此处抛出 `SQLiteException`，插件按原有隐私边界返回通用错误代码。问题并非 WebView 的 DNS、缺少 variations signature 等系统警告。

在同一 Note X3 Pro 上，使用独立 `app_process` 和 **内存空库** 重现：

- `execSQL` 抛出 `android.database.sqlite.SQLiteException`，提示必须使用 query/rawQuery。
- `rawQuery` 正常返回 `5000`。
- 探针不访问应用数据库，临时 DEX 运行后已删除。

## 修复与回归

三处调用改用已有 `rows()` 查询/游标关闭路径，不改 SQL 参数、数据库位置、表结构、数据、迁移或提交回执协议。没有默认目录回退、空数据替换或新持久化所有者。

同时修正宿主 SQLite 边界，使 `execSQL` 遇到返回结果行的语句时按 Android 规则拒绝。最初边界未携带查询标志，未覆盖真实差异；纠正后，原实现 **13 项失败**，应用三处修复后 **13/13 通过**。包含生产状态库/插件的 355 条断言、10 个场景，以及实际导入所有者/SQLite 的 60 条断言；书库字段 CAS、来源保留和统计语义回归也通过。真实 Android 空库行为用于约束宿主模拟，不再把 Python sqlite3 接受该 SQL 当作 Android API 接受。

## 构建与覆盖安装

保持 `1.5.0 / 1005000` 和原有显示名称，不覆盖旧的不可变交付包：

| 变体 | 当前修复包 | SHA-256 |
|---|---|---|
| release | `artifacts/Pagewise-1.5.0-startup-fix-release.apk` | `9431726b593ae132fcfa2ee574f3b4d415dd31916bd1dfeb1a0ca9686467d2e1` |
| debug | `artifacts/Pagewise-1.5.0-startup-fix-debug.apk` | `2af61dbc39e76628d19d71df160782bcf38c8b1193889865d8ad65966f2fcff4` |

仅 Kotlin 连接初始化及对应宿主边界改变；Rust、前端和依赖输入逐项核对未变，复用原先封存的动态库和前端产物，不冒充重新编译了它们。两版 Kotlin/assemble、release R8 实际退出 0，APK 内原生库与封存摘要一致。

两包沿用原证书覆盖安装，安装后 APK 摘要与修复包一致。UID、首次安装时间、数据目录和 CE inode 与修复前相同；未卸载、未清数据、未重置设置。未读取书库正文、批注、密钥或逐条迁移记录。

## 真机启动证据

- 测试版：模块执行与 Vue 挂载均成功；初始化错误代码为空、错误面板消失；原生页面状态区存在且无原生页面打开错误；能力版本仍为 1，探针关闭。
- 正式版：Activity 启动后，通过已有白名单 `PagewisePerf` 捕获真实前端挂载就绪信号。随后重新创建 Activity，以 `PERF_PROBE=false` 正常启动；最终前台为正式版，当前进程无致命异常和额外性能记录。
- `ready` 记录的毫秒数只是探针局部测量，不作为冷启动总耗时或 EPD 性能指标。
- 首次 `/dev/tty` 层级探针未获得有效标记，记为无结论。随后使用设备端临时权限 0600 的 UI 层级文件，仅在设备上提取固定布尔标记：有效层级、可见“藏书”标签，未检测到“数据初始化未完成”或“操作未完成”弹窗。临时文件随即删除；没有导出截图、完整 UI XML 或书籍文本。这仍不是全部页面控件验收。

本机证据位于 `.cache/startup-1.5/`：修复前源码副本、设备内存空库 `probe/result.json`、严格边界红/绿日志、测试版启动布尔值、正式版就绪与正常启动回执；`build/` 保存签名安装与原生库复用证明。原始日志未归档，输出仅保留安全错误代码、能力/挂载状态、固定指标或包身份元数据。

本次验证关闭了已重现的启动初始化故障，不证明真实书籍打开、SAF provider 导入/扫描、完整迁移记录逐项一致、七页全部操作、BOOX EPD/硬件键、物理尺标或在线 AI 已通过。本次源码变更尚未自动提交或推送 GitHub。
