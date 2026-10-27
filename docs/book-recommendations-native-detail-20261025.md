# 图书推荐：原生详情验收补充

## 结论

**REC-NATIVE-DETAIL-01 已在限定源码／合成范围内解决。** 同一组 Android API32 用例由历史 13/14 转为本轮 **14/14**；原生详情入口阻塞解除。没有部署正式 APK、操作文石书库或调用真实模型。

原阶段记录见 [图书推荐实现与验收](book-recommendations-20261024.md)，原 13/14 与 BLOCKED 回执保留，不改写成成功。

## 修复

本轮唯一源码修改：`reader/scripts/fixtures/NativeBookRecommendationsMain.kt`。

在受控传输中补齐既有 `action.libraryBookInfo` 响应：检查 `bookId` 为合成来源书，返回 `ok`、`effectiveReadingStatus` 与 `supported`。其字段来自同一合成书对象，符合真实 `createNativeLibraryActions().libraryBookInfo` 合同。

生产详情页本来就须依次取得 `library.book`、`action.libraryBookInfo` 后才执行 `renderBook()`。旧夹具遗漏第二步，因此未显示标签。**未修改生产控制器、推荐逻辑、存储或验收断言。** `runRecommendationTests()` 原用例主体与本轮修复前逐字节相同。

## 已执行验证

| 验证 | 结果 |
|---|---|
| 原生详情懒加载、实际数量、想读提交期间切换保护 | 通过 |
| 原有整组 Activity／View 用例 | **14/14**，含中英文 6 组布局、6 张截图 |
| 离线原生动作与协议合同 | **27/27** |
| 测试 APK | 16 个生产模块编译、DEX、签名通过；无网络权限 |
| 当前源码与实际执行测试 APK 的输入绑定 | 匹配 |
| 当前任务模拟器 | 全新 API32；上限 155 秒，实际约 75.22 秒；exit 0，进程及 ADB 实例已退出 |
| LSP | 1 路径不确定、0 个确认 clean；不以此代替编译与运行 |

测试包：`io.pagewise.recommendations.test`。它使用合成页面传输和明确的仓储／Host 编译依赖替身；不是完整生产桥接、真实书库或物理 EPD 端到端验收。本轮未重新累计旧 Web、数据库及回归测试计数。

## 续接前漂移

与上轮 482 个源码输入相比，开始时已有 4 个 Kotlin 文件漂移：夹具、`NativeBookRecommendationsPanel.kt`、`NativeManagementHost.kt`、`NativePagesController.kt`。当前字节已先备份，未回退或覆盖。

使用同一缓存编译器比较旧 v4 与当前 v5 的 16 个生产模块，共 79 个类。去除调试信息、栈图帧、两个源调试注解和已核对的 NOP 后，**78 个类一致**。`NativeBookRecommendationsPanel` 不作字节相同声明：其 `explain` 中同一 `find`／可空 `let` 表达式因显式循环体产生临时变量与 DUP/POP 实现差异；已按源码及指令对照自审，匹配条件、更新、异常、取消及归属逻辑未变。

初次严格比较失败日志保留。上述是本轮局部自审与运行证据，不是新增独立批准，也不把旧审查称为当前字节认证。相对续接时的快照，本轮只有夹具文件改变，其余 481 个输入保持原字节。

## 回执与边界

回执根：`.cache/book-recommendations-20261024/detail-followup/`。

- `acceptance.json`、`source-inputs-before.json`／`source-inputs-after.json`、`own-source.diff`
- `android32/activity-result.json`、`android32/process.json`、`android32/images/detail-followup/`
- `offline-contract.log`、`pre-existing-drift-review.json`、`production-bytecode-report.json`
- 测试 APK 输入：上级 `fixture-build-v5/source-inputs.json`、`build-result.json`

当前入口：`.cache/book-recommendations-20261024/latest-status.json`；旧 `acceptance.json` 仍是历史 BLOCKED，不代表当前状态。

未覆盖项仍包括：正式前端＋Rust＋APK 打包安装、真实模型与馆藏质量、文石／物理 EPD、PDF 连续滚动实景及完整无障碍组合。当前结论只关闭本次原生详情夹具与既定合成用例的阻塞。
