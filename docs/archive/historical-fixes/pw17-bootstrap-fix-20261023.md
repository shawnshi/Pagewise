# 1.7.0 首启与恢复页修复：已部署

**本轮终态：DONE。** 已修复 `PW17-RELEASE-INIT-01`、`PW17-RECOVERY-01`、`PW17-TOUCH-01`，并覆盖更新设备 `9D7BC516` 上的 release 1.7.0「知页」。这不表示此前 S4、真实书审计、标签输入或精确 CFI 恢复问题已通过。

## 改动

- 保持原生 Android 管理页＋Web 阅读器，不改版本号、包名、数据库格式或依赖。
- 原生设置迁移完成不再被当作书库表已就绪的证明。新增内部 `sql.initialize`，沿用 Web 存储中的原有建表 SQL，在首次普通 SQL 探针之前以一个原生事务执行。
- 仅允许默认根目录下明确识别的空首启状态引导建表。部分书库表、未知对象、已有书籍/封面文件、阅读/哈希等数据或非空迁移证据均阻止空库替代。正常 SQL 仍保留原先的缺表拒绝；缺库、损坏处理不放宽。
- 恢复页增加可展开诊断和“复制错误代码”，复制失败可见；仅显示受限错误代码，不显示凭据/完整异常。取消“旧副本未删除”的无依据承诺，不提供清数据或删库操作。
- 恢复页按钮及诊断入口至少48 CSS px，支持窄屏换行和键盘焦点。

生产文件：`reader/src/main.ts`、`reader/src/services/nativeSqlDatabase.ts`、`reader/src/storage/tauri.ts`、`reader/src-tauri/android/NativeSqlDatabase.kt`、`reader/src-tauri/android/NativeStatePlugin.kt`。另修改1个既有测试，新增3个测试文件。原稿和用户已有差异保存在证据目录的 `before/`、`user-diff-before.patch`。

## 分层验收

- **Android API32实际框架：** 新增15项通过。修改前同一引导场景出现2项预期失败，修改后全部通过；覆盖原生设置迁移→SQL初始化、幂等/已有行保留、部分库/未知对象/文件/阅读与哈希证据拒绝、DDL回滚和初始化缺库不重建。
- **Android实际回归：** 另一次19项通过，SQLite 3.32.2，包括分类原子性、并发CAS、损坏保全及合成库完整性检查。全部位于本轮独立合成目录，不是对正式私有数据库的检查。
- **Node相关回归：** 33项通过。`sql.initialize` 的未知结果不自动重放。
- **真实浏览器：** 恢复页1组测试通过，覆盖320/992/1400px、触控尺寸、无横向溢出、诊断展开、键盘、受控剪贴板成功/失败及非法错误文本。未修改主机或设备剪贴板。
- **类型/构建：** Vue/TS检查通过；显式 Vite `build()` 冻结168项资源；Rust release offline/locked重编；Kotlin/R8/assemble通过。保留原编译/R8诊断，不宣称无警告。
- **静态检查限制：** 新鲜LSP路径探针检查9文件，34项辅助规则发现、3项覆盖不确定，未获任何文件的完整clean确认。已证明4处辅助错误对应原稿未改行；新增测试风格提醒不作为运行正确性证据。详见 `diagnostic-disposition.json`。
- **独立审查：** 原生 reviewer `798b47d3-e1b0-495d-8e25-2b9a19bd040c` 在干净上下文下返回 `scoped_OK`。其未代跑测试或批准设备门。此前超时及角色不可用记录不算通过，也未覆盖成成功。

## 设备与安装

新包：`artifacts/Pagewise-1.7.0-bootstrap-fix-release.apk`。

```text
APK SHA-256:
da97fae8c9baff264a656aed1891921b380dd243f8d65f6340c963c527ce6b46
源输入清单 SHA-256（455项）:
7f9747548139d1dc9315eb4a411bf286818118c21a94d57da4a24a7df55ce84e
```

版本仍为1.7.0 / 1007000，包名 `io.pagewise.reader`，87种本地化显示名均为「知页」，arm64-v8a、minSdk24、release非debuggable。签名沿用现有 Android Debug 侧载身份，**不是商店发行签名**。APK签名、CRC、前端→ELF→APK绑定通过；安装后拉回 APK 与上述字节完全一致。

`adb install -r` 前停止旧正式进程并保存旧APK。覆盖前后 UID10097、`/data/user/0/io.pagewise.reader`、首次安装时间 `2026-10-23 21:06:06`、`ceDataInode=59051` 保持。未卸载、清数据或修改debug包。旧APK保留为同版本代码回退点，未执行回退；不把APK备份称为私有数据库备份。

**实机验证：**

- 两次均由系统报告 COLD 的启动后，实际进入原生藏书页，不再显示初始化失败。
- 实际触控切换藏书、正在阅读、全部笔记、阅读统计、设置；分别核对页面顶部标题并截图，采集范围内无公共错误码。
- 设备当时为横屏2480×1860，未强制改变用户屏幕方向。
- 当前正式书库显示 **0本**，未打开书籍正文、导入测试书、编辑设置或检查私有数据库。正常启动会创建所需书库表，导航也可能写UI会话，不能称为零数据库写入。
- 设备上的故障恢复页未通过破坏数据库来强行触发；其交互验收来自上述真实浏览器测试。

## 截图与证据

证据根：`.cache/pw17-bootstrap-fix-20261023/`。

- `01-fixed-release-current.png`：更新后实机藏书页。
- `02-native-page.png`～`06-native-page.png`：五个原生页面；部分截图遮挡潜在私人/未知动态文本。
- `07-second-cold-start.png`：第二次冷启动后实机藏书页。
- `recovery-browser/width-992.png`：浏览器恢复页验证，**不是设备故障截图**。
- `android-red-v1/result.json`、`android-green-v1/result.json`、`android-existing-regression/result.json`。
- `related-green.log`、`recovery-green.log`、`independent-review.md`。
- `artifact-release.json`、`install-before.json`、`install-result.json`、`device-start-result.json`、`device-navigation-result.json`、`acceptance.json`。

已移除本轮六个精确命名的设备合成测试路径，未停止共享ADB、未创建端口转发。JNI恢复原链接结构，链接目标为本轮新编译raw release；旧raw另存 `jni-before.so`，不声称恢复了旧字节。455项冻结输入未漂移，生成源码仅两处对应本次原生修改；未reset、暂存、提交或推送用户改动。

## 未关闭的历史范围

本轮不恢复原1.6书库、不证明原数据此前如何处置，也不以当前空库冒充原书库恢复。旧快速返回CFI、精确恢复位置、标签输入自动化、10本真实书审计及完整S4仍按原记录保留，不重置重试预算。未测物理墨水屏残影/延迟或长期稳定性。
