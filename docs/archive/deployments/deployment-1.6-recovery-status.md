# 1.6.0 保存失败重试离开：归因、修复与重新部署

## 更正：前端产物与部署声明

**撤回本页原先“生产前端构建成功、修复已生效部署”的结论。** R10整改核查确认，当时辅助脚本以`node scripts/vite-isolated.mjs build`运行仅导出函数的模块，未实际调用`build()`；退出0不能证明`dist`被重建，也不能证明APK包含待交付的Reader源码。

浏览器17/17、配套32/32、APK安装字节及数据目录身份、debug三轮触控返回等原始记录保留，但这些不能替代前端资源与源码的绑定证明。旧`acceptance.json`中的部署完成措辞不再作为修复已生效的依据。

本轮已改用真实`await build()`、记录前端资源摘要并核对其嵌入新候选ELF；新包尚未启动验收或部署真实设备。正式包因后续数据库安全事件保持停止。整改状态见[最新报告](r10-repair-20261023.md)。

## 历史部署动作

**两版APK确已覆盖安装，debug三次触控返回有回执；但该APK与修复前端源码的等价性未验证，不再宣称完成了修复部署。release完整实机验收原本也未通过。**

本报告更新此前 `deployment-1.6-fix-status.md` 的“恢复离开未归因／未部署”状态。没有卸载、清数据、迁移数据库或读取私人书籍内容。

## 归因：旧断言检查了错误的 owner 合同

本轮按用户明确要求先补采保存、路由和卸载回执，而非重放此前已停止的空槽等待。

`.cache/deployment-1.6-recovery/diagnostic-trace.json` 记录：

1. 保存首次拒绝，Reader与原owner保留；
2. 显式重试的 Promise 确认；
3. `router.afterEach` 为 `/library` 且 `failure=null`；
4. Reader卸载时原槽变为空，`vue.unmounted` 时 Reader DOM消失；
5. 随后槽内再次出现函数，但不是原 Reader owner。

消费者源码 `LibraryView.vue` 合法调用 `useNativeBack`；`claimNativeBack` 只在空槽登记、只删除自己的处理器。因此，旧测试“全局 `__pagewiseReaderBack` 必须为空”的断言不符合共享槽合同。**保存恢复路径没有被证实失败，错误在验收 oracle。** 此前3次失败记录保留，未改写为通过。

新验收检查：路由确已提交、Reader DOM已移除、旧owner已被替换且调用返回false；允许新页面合法接管。另增首次保存失败→显式重试调用真实存储→读取 `getBook()` 对账 CFI/location 和 progress=0.27→正常离开，并检查只发生两次保存调用。

## 交付代码

包含上一轮尚未部署的最小工具栏返回修复：区分 toolbar／system 来源；工具栏按钮进入同一 pending／owner 入口；仍先等待保存ACK、核验owner，再隐藏chrome并导航，避免同一次返回被重复当成关闭工具栏。系统返回的编辑器／选区／检视／面板优先级保留。

没有改生产保存、存储协议、数据库、CFI格式或依赖。相对已安装原1.6源码共3文件：

```text
reader/src/views/ReaderView.vue
reader/scripts/test-native-reader-back.mjs
reader/scripts/test-reader-back-regression.mjs
Diff SHA-256: 0c936a66a2496d1f46e7e808285879f949d07b7a03b45710214690235faa2f2b
```

## 验证与独立复核

证据根目录：`.cache/deployment-1.6-recovery/`。

- `recovery-green.log`：**17/17**，包括完整浏览器失败恢复、真实保存读回、3轮普通toolbar/system返回，以及单飞、笔记、selection及owner合同。
- `related-tests.log`：**32/32** 配套草稿／面板测试。两组按各自命令报告，不与历史测试相加。
- 应用TypeScript检查、Rust release/debug、两版Gradle构建及签名校验有退出0回执；原“生产前端”命令仅加载模块，其退出0不能作为构建证据，该项结论已撤回。
- 独立 reviewer `bdb908ad-c454-4040-b763-cd41dc3b9325` 为 **scoped_OK**，确认共享槽oracle及恢复回读有效；没有执行测试／设备或独立重算哈希。主执行方复核最终源码未漂移。
- LSP三文件0确认clean：ReaderView 5707行超5000限制，两个脚本为inconclusive。构建／测试通过不等于LSP全绿。

## 已部署修复包

| 构建 | 显示名称 | applicationId |
|---|---|---|
| release | 知页 | `io.pagewise.reader` |
| debug | 知页 1.6.0 测试版 | `io.pagewise.reader.debug` |

均为1.6.0 / 1006000、arm64-v8a；87个语言资源的名称及debuggable标记正确。沿用既有Android Debug侧载证书，不是商店发行证书。

```text
artifacts/Pagewise-1.6.0-recovery-release.apk
SHA-256: 921ec896d509a34c2f922236bddeb7f19d58834aca0d0b4a051b0f3c9a6c1fa8

artifacts/Pagewise-1.6.0-recovery-debug.apk
SHA-256: 9b3974149164954c138f03f5ab3bdaf8a860e05638c14e319d56b661a1d5372a
```

在NoteX3Pro上用 `adb install -r` 覆盖安装，两份已安装base.apk拉回校验均与交付文件相同。UID、dataDir、firstInstallTime及ceDataInode保持；release/debug数据inode仍为52086／52263。原1.6 APK及本轮安装前APK作为恢复点保留，没有降级或删除数据。

## 实机证据与限制

- debug：`debug-physical-results.json` 记录3轮合成书打开后以真实ADB触屏点击返回原生管理页，非DOM替代；随后统计／在读／笔记／藏书切换响应。
- 自动化处理了工具栏自动隐藏及屏幕键盘的时序，前期定位／readiness失败日志保留，不把它们记作成功。
- 两版覆盖安装后，6步应用切换／回桌面及12秒后台等待均未再停用，最终为 `enabled=0`。没有使用 `pm enable` 补救或修改全局冻结设置；两版仍沿用此前官方图标菜单“解冻”的应用级状态。

**release 未完成项：**实际大书库中打开原生详情时出现 `native_action_error`，随后藏书读取也显示该错误，已停止该分支并保留 `release-read-locator-probe.json`、`release-locator-final-state.json`。错误发生在进入 Reader 之前；未将其冒充此次保存恢复失败，也不能宣称原PW-01已修复。

日志同时有从WAL尝试切到TRUNCATE时的锁告警，且日志写明继续使用原模式。**这不是已证明的 `native_action_error` 根因。** 未擅自修改数据库journal配置。release重复返回和原生详情／目录整体验收仍缺证据；浏览器故障注入不等于物理数据库故障演练。

## 收尾

- 仅对已知合成验证书操作；库内其他书籍标题／内容不写入报告。测试用Pagewise筛选已在两版清除，其他筛选未改。
- JNI暂存恢复为阶段前链接；没有创建任务CDP forward，没有关闭共享ADB。
- 最终源码、APK、安装字节及签名容器元数据复核通过。未提交、推送或发布。

下一项独立工作是对 release 原生详情错误做只读归因，保留数据和原生状态；不能以清库、重启或未经验证的journal切换替代修复。
