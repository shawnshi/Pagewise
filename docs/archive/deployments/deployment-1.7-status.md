# 1.7.0 打包、安装与设备验证

> **已被1.8.0替代：** release（知页）与debug（知页 1.8.0 测试版）均已覆盖安装并完成限定实机验证，见 [1.8当前部署报告](deployment-1.8-status.md)。下文保留1.7各时间点的历史与失败，不作为当前版本状态。

> **22:33 修复更新：release 1.7.0已覆盖部署首启修复包。** 两次实机冷启动及五个原生空态页面切换通过，独立审查 `scoped_OK`。当前正式书库为0本，不代表原1.6数据已恢复。最新安装包为 `artifacts/Pagewise-1.7.0-bootstrap-fix-release.apk`，详见 [本轮修复与验收](pw17-bootstrap-fix-20261023.md)。下列21:06及更早内容均为历史状态，未将旧失败改写成通过。

> **21:06 后续更新：release 1.7.0（知页）已完成新安装。** 安装前，正式包已不在设备的已安装及保留项列表中；本次未执行卸载或清数据，也不判断旧数据此前如何处置。安装后拉回 APK 与核验包字节一致，保持 `stopped=true / notLaunched=true`。debug 仍为 1.7.0。
>
> 当前“仅安装 release”目标已完成；原有标签输入、精确恢复 CFI 等业务验收并未因此通过。回执为 `.cache/deployment-1.7-20261023/release-direct-install.json`。**下文是此前打包/验证阶段的历史状态**，原始全文快照保留在 `deployment-status-before-direct-release.md`，不将历史失败改写为通过。

## 结论

- 两个 **1.7.0 / 1007000** 安装包已构建、签名及资源绑定核验。
- **debug 已在文石设备 `9D7BC516` 覆盖安装**，系统应用信息页实际显示“知页 1.7.0 测试版”。
- **release 未覆盖安装、未启动**。设备正式版仍是 1.6.0、无 PID；原损坏库尚无已验证的 DB/WAL/SHM 副本，也未收到近期备份路径。不得用此次部署请求代替原数据保全门。
- debug 的启动、主页面、翻页保存返回及 Home 恢复验证通过；标签输入自动化、恢复位置精确核对尚未通过。**不能报告双版本部署或整体验收完成。**

## 安装包

| 变体 | 文件 | 包名 / 显示名 | 设备状态 |
| --- | --- | --- | --- |
| release | `artifacts/Pagewise-1.7.0-release.apk` | `io.pagewise.reader` / 知页 | 已构建核验，未部署 |
| debug | `artifacts/Pagewise-1.7.0-debug.apk` | `io.pagewise.reader.debug` / 知页 1.7.0 测试版 | 已覆盖安装、拉回字节核对 |

```text
release SHA-256:
8e59b87d9bc322fa9a5d92d8523cda5707ce8b9a34f77ae2f824385f4314c526

debug SHA-256:
902e6f286e038ee73a3a8d3f93e0cf8aa9accaad5f8a7da995748da43c23574c

冻结输入清单 SHA-256:
e4fbb44e4bdcf1cbb00c30af13228ee1a835e5b42e08df9ea572eddc51cd7de4
```

两包均为 arm64-v8a、minSdk 24，87 个本地化显示名一致。沿用设备已安装应用对应的 Android Debug 侧载证书（SHA-256 `9b0f5661…f472a3`），**不是商店发行证书**。release 非 debuggable，debug 可调试。

## 改动与构建证据

本轮只修改以下五个版本文件，没有改业务逻辑、数据库格式、包名或升级依赖：

- `reader/package.json`
- `reader/package-lock.json`
- `reader/src-tauri/Cargo.toml`
- `reader/src-tauri/Cargo.lock`
- `reader/src-tauri/tauri.conf.json`

另通过既有 `prepareAndroidVariants()` 更新生成目录的 `app/tauri.properties` 及变体显示名。npm 依赖图、Cargo 锁定依赖保持不变；Cargo.lock 仅本项目版本从 1.6.0 改为 1.7.0。

实际执行：

- 版本及生成回归：修改前后各 **30 通过 / 0 失败**，不合并计数。
- Vue/TypeScript `--noEmit` 通过。
- 显式调用 `vite-isolated.mjs` 的 `build()`，生成并冻结 **168 项前端资源**；没有使用无 CLI 入口的假构建命令。
- Rust debug/release 均以 `--offline --locked` 重建；不复用旧版 ELF。
- debug assemble、release R8/assemble 均退出 0。沿用原环境的编译/R8 警告，不声称“无诊断构建”。
- APK manifest、版本、显示名、ABI、签名、CRC、内嵌 ELF 与当前前端映射核对通过。
- 新鲜 LSP 探测：4 个文件确认 clean；Cargo.lock 超过 5,000 行未获 LSP 覆盖，另由锁图差异核对及真实 Cargo 构建验证。

曾发现首个 debug 包仍带生成配置遗留的 1.6 元数据。该包已移入 `.cache/deployment-1.7-20261023/REJECTED-VERSION-METADATA-debug.apk`，**未安装**。根因是仅运行 native prepare 不会刷新 Gradle 实际读取的 `app/tauri.properties`；修正为显式调用既有版本生成器后重新冻结、重建并核验，当前交付包元数据正确。旧冻结及失败回执保留。

最终 **452 项输入无漂移**。现有大量用户改动未 reset、暂存、提交或推送。

## debug 数据保全与安装

对运行中的 debug 仅做约 0.32 秒进程暂停、私有文件快照及恢复，不取消或重放业务。部署前又取得一次私有恢复点，均留在应用原 UID 内：

```text
files/pagewise-deployment-backups/1.7.0-20261023/
files/pagewise-deployment-backups/1.7.0-20261023-preinstall/
```

包含当时存在的数据库/伴随日志，以及 `shared_prefs`、`app_webview`。这是**崩溃一致性文件快照**，不是事务级在线备份；恢复过程没有演练。没有导出私人书籍内容、批注或凭据到项目/会话。

旧 debug 安装 APK 已拉回作为代码恢复点。正常 `adb install -r` 后：

- UID `10095`、数据目录、首次安装时间及 `ceDataInode=52263` 保持不变。
- 已拉回安装后的 `base.apk`，与交付 debug APK 的 SHA-256 一致。
- 未卸载、清数据、修改文石全局冻结策略或签名。

这些安装元数据不是数据库内容完整性的替代证据；数据检查另列。恢复点留在原应用数据中，卸载或清数据会连同恢复点一起删除。

## 设备验证

环境：ONYX NoteX3Pro、Android API32、arm64，实际 WebView 为 **Google 157.0.8103.5**。没有用模拟器结果代替此次实机结果。

### 已通过

1. **版本/显示名**：原生运行 API 返回 1.7.0；系统应用信息页显示完整 debug 名称。
2. **启动/页面**：书库、在读、全部笔记、统计、设置五页切换；观察到当前 native show ACK 及 Web 根 `aria-hidden/inert`，没有出现采集范围内的公共错误码。未修改用户设置。
3. **合成 EPUB**：新增本轮自有验证书；实际 Native“阅读”触控后，等待 Vue 的 Opening 完成、导航按钮出现及 CFI 就绪，确认 2 项目录、正文文档及 Web 根遮挡解除。
4. **翻页/保存返回**：通过实际页面按钮的 Vue 点击处理器翻页；实际工具栏返回处理器被接受，Reader 卸载。SQLite 读回 CFI 与退出前可见 CFI 完全一致，进度均为 `0.15206681667839544`。该步骤不是物理返回按钮触控。
5. **Home 恢复**：两次 Home、等待 12 秒、重新启动 debug，均恢复；包状态维持默认启用。不能据此保证长期不冻结。
6. **数据检查**：本轮测试前后 7 本既有书籍的 ID 摘要一致，既有批注数仍为 2；debug 数据库只读 `SELECT * FROM pragma_integrity_check` 返回 `ok`。不宣称逐字段审计了所有既有内容。

保留 **1 本本轮合成验证书**（标题 `PW17 Verification Only`）。只打开了该测试书，没有读取或报告用户原书正文、标题和私人批注；测试新增的主题已清空，测试用 legacy 标记保留。正常阅读测试会写入该测试书的进度/时长，不能称为零数据库写入。

### 未通过/尚未闭合

- **`PW17-TAG-INPUT-AUTOMATION-01`**：ADB 向原生标签输入框注入和清除字符时，观察到实际文本不完整；三次已停止。先前一次部分输入曾保存到本轮测试书，后续已清空。未保存草稿已关闭。没有把输入预期不符归一化为成功，也未确定这是应用缺陷还是设备/输入注入路径问题。
- **`PW17-RESUME-CFI-01`**：再次实际触控“继续阅读”后，等待 Vue 就绪，精确 CFI 恢复断言未通过。退出前范围为 `epubcfi(/6/2!/4,/30/1:34,/56/1:34)`，恢复后为 `epubcfi(/6/2!/4,/30/1:40,/56/1:34)`，起始偏移差 6 字符；语义影响与根因未确定，未擅自修改 Reader 代码。失败回执保留，随后正常关闭测试 Reader。

此前旧模拟器的“快速进入即退出”三次失败记录不重置。本轮使用 `loading=false` 后才出现的导航按钮作为就绪条件，验证的是**就绪后的翻页保存路径**，不宣称旧快速加载退出场景已修复。

## 正式版阻塞与下一步

正式版原数据库曾报告损坏及默认删除处理。**原 DB/WAL/SHM 尚无经过核实的物理恢复副本**，近期完整书库备份也未提供。本轮没有打开、检查或恢复该原库；正式包仍为 1.6.0、无 PID，release 1.7.0 只完成打包。

需要用户提供近期正式书库备份路径或可用的原 DB/WAL/SHM 副本，先完成保全/恢复条件核验，再安排 release 覆盖及运行验证。APK 备份不是书库数据备份。debug 私有恢复点也不覆盖正式版数据。

## 证据与收尾

证据根：`.cache/deployment-1.7-20261023/`。主要回执：

- `preflight.json`、`before/`、`source-inputs.json`、`version-own.diff`
- `artifact-debug.json`、`artifact-release.json`、`debug-install.json`
- `debug-private-backup.json`、`preinstall-debug-private-backup.json`
- `navigation.json`、`device-label-check.json`、`reader-test.json`
- `tag-input-blocker.json`、`restore-test.json`、`restore-mismatch-cleanup.json`
- `postcheck.json`、`home-resume-check.json`、`formal-not-deployed.json`
- `cleanup.json`、`acceptance.json`

已移除本任务 `tcp:19268` 转发，没有关闭共享 ADB。JNI 恢复为原链接结构，链接目标是本轮新构建的 1.7 raw release ELF，**不是恢复旧 ELF 字节**；旧 raw ELF 另有命名恢复点。两个 APK 旁的 `.status.json` 标明真实部署/验收状态。

**终态：BLOCKED。已完成双包构建及 debug 部署，但 release 部署和完整设备验收尚未完成。**
