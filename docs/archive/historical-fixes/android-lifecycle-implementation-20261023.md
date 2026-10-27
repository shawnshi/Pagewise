# Android 生命周期兼容补丁：实施与定向验证

## 结论

**项目内 SDK 补丁已实现，独立复审 scoped_OK；原 `PW-S4-ACTIVITY-01` 的字体重建路径定向通过。整体 S0–S4 仍为 BLOCKED，不具备发布批准。**

用户已批准追加的 Tauri 2.11.5 项目内兼容范围。批准时的原文冻结于 `.cache/ui-ux-20261022/lifecycle/approved-sdk-scope.md`，SHA-256 为 `06c87053f1caa1971021d11376f1a37b486093669991d6e12501ca5a5db41166`。未安装主设备、未读取私人书库、未推送、发布或提交 Git。

## 实施边界

- 保留原生管理页＋Web 阅读器。没有依赖升级、数据库迁移、书籍／批注身份或 CFI 格式变更。
- SDK 模块源文件复制到项目生成目录；上游 28 个文件逐一校验 SHA-256，版本或源码不匹配则停止。没有修改全局 Cargo 中的 SDK 源码。
- 保留原有 SDK/JNI 入口及三参 picker 方法；新增失败通知重载供目录插件使用。保留上游版权／许可标记。
- Activity 更换时，用公开 Activity 构造器重建插件实例并保留配置；按 Activity 身份暂存弱引用 WebView，兼容 WebView 早于 owner 切换到达。
- 三类 ActivityResult 使用独立槽、每次唯一 key、owner／ticket 身份校验和显式 unregister。同类占用拒绝新请求，不覆盖旧槽。
- 旧窗口选择请求明确结束，不移交新窗口。SDK 不取消或重放已接受业务；跨 Activity 的 SDK 回执改为 `activity_changed_outcome_unknown`，旧 channel 不向新 epoch 发送。
- `NativeStateClient` 收到该新错误码时保留原 mutation envelope 并直接抛出，等待显式 receipt 核对，不进入自动重试循环；原有其他错误码逻辑不变。
- picker 启动失败先通知、后拒绝。目录插件只在 `pendingPicker === invoke` 时释放 admission，旧失败不能清除后续新请求；不伪造 Android 取消结果。

规范变更共 11 个文件，见 `lifecycle/implementation-final-input.json`；原有大量未提交修改均保留。相对本专项 446 文件冻结基线，授权写集之外无漂移。两个仓库 HEAD 未改变。

```text
Diff SHA-256: 5676a6529d416d09737666c56c2789e8144a35959780e83cd9cd72bb58a7eb09
```

## 验证

证据根目录：`.cache/ui-ux-20261022/lifecycle/`。

- **定向自动化 50/50**：`final-affected-tests.log`。包含真实 Kotlin fence 的 11 分支、真实目录函数抽取＋生产失败 helper 的 JVM 宿主用例，以及真实 NativeStateClient 用例；不是完整 Android instrumentation。
- **两项红转绿**：`review-fixes-red.log`、`review-fixes-green-final.log`。分别验证 picker admission 泄漏和新 SDK 错误导致 pending 丢失／重放风险。首次沿用旧未知码的方案会触发原有三次重试，最终改为新码专用分支，保留其他码行为。
- **完整前端／Android 构建退出 0**：`android-build-final.log`。第一次 SDK 构建曾复用旧路径的增量产物并缺少常量；确认源输入完整后，为项目内 SDK 使用独立 `native-lifecycle-modules/` 输出目录，定向 SDK／FS 编译及后续完整构建通过。失败日志未删除。
- **独立复审 scoped_OK**：`independent-review-final.md`，run `0632ab93-d6a2-4e77-af7f-031f681c0c11`。初轮超时，恢复后确认 picker 清理 P1；修复后另起干净 reviewer 完成复审。审查者没有重跑测试、设备或独立重算哈希，主执行方已复核最终 11 文件未漂移。
- **LSP**：8 文件中 2 个确认 clean、5 个 inconclusive，另有 1 项辅助规则发现。`prepare-android-project.mjs:62` 的未包裹 JSON.parse 在冻结基线中已存在；不称 LSP 全通过。

### API 32 原生实测

仅在任务自有 `PagewiseAudit32Google`、无账号／私人资料的合成环境执行。API 32、WebView 120.0.6099.193，不等同 BOOX 的 WebView 146。

- 最终包字体 `0.85→1.3` 后，Activity 本地实例身份确实变化；阅读器恢复，原生书库、详情、目录、统计继续响应。3 本合成书保留；在读及全部笔记入口亦通过定向路径。
- 真实 SDK dialog chooser 占用共享槽时，目录选择返回 `activity_result_busy`。取消原 chooser 后，再次目录选择实际打开 Android `PickActivity` 并正常取消，存储目录仍为 null，未改变文件夹所有权。
- chooser 打开期间改字号、取消返回后，新 chooser 可再次打开／取消。没有实测旧窗口“成功 URI”迟到投递；重复／晚到隔离的证据来自实际 Kotlin fence 用例。
- 英文 TXT 在字体重建后保留相同阅读起点。可见范围 CFI 的末端随排版改变，**不报告整段 CFI 字节相同**。普通 Home／返回时，同一视口的完整 CFI 相同。
- 横屏／竖屏基础书库路径可用，不等于完整横屏视觉或无障碍验收。
- 初始 Opening 截图不算正文或原生面板通过证据；最终取已加载的 `lifecycle-final-font13-library-proved`、`lifecycle-final-detail-proved`、`lifecycle-final-toc-proved`、`lifecycle-final-font13-stats-proved`。CFI 与实例证据见 `final-reader-*`。

原生结果汇总见 `native-acceptance.json`。没有重跑历史 R4 的 133／7 集合，也不与本轮 50 相加。

## 候选与恢复点

```text
.cache/ui-ux-20261022/Pagewise-1.5.0-lifecycle-reviewed-debug.apk
SHA-256: 9e5c4e2d6fac1cb0526b46e40b2257bd749367db623fa6fbb275950b186dd68d
applicationId: io.pagewise.reader.debug
version: 1.5.0 / 1005000
```

这是 debug 验证包，不是 release。签名验证退出 0，证书为既有 Android Debug。`candidate-final.json` 绑定最终源码；旧候选、初轮 Diff 和失败回执均保留。

恢复点为 `lifecycle/before/`、`before-generated/` 及原阶段恢复点。若需撤销，仅在核对当前哈希后逆向该 11 文件差异并重新生成；不能用 HEAD、reset 或全目录覆盖替代。未执行实际回退、卸载或清数据。

Guest 字体、旋转已还原，任务 CDP forward 和远端探针已移除；核验 AVD 名后优雅停止，任务 QEMU 进程为 0。未关闭共享 ADB。见 `cleanup.json`、`process-exit.json`。

## 仍未闭合

- 原 BOOX 跨页 PW-01 `native_action_error` 仍未复现／定位，不能宣称与本缺陷同因或已修复。
- 既有草稿／批注身份、设置提交及未知结果保护没有被移除；但最新包的未决设置写入、已接受长期任务和原生清理失败尚未做完整故障注入。
- IntentSender／权限真实 UI、旧成功 URI 跨重建、进程死亡恢复未完成设备验收。
- 首次推荐配置选择、完整 TalkBack、实体墨水屏残影／闪烁／手写延迟、复杂 TXT 及正式包验收仍未闭合。

后续仅在现有授权内继续可独立完成的项目任务。主设备安装、私人样本诊断、发布或外部写入仍需对应授权。
