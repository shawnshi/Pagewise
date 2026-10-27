# Activity 重建后原生宿主失效：待批准方案

**状态：只读方案，未实施生命周期改造。** 当前仅完成阅读检查点接收者修复；不能把它当作此问题或原 PW-01 已修复。

## 已确认事实

- 在任务自有 API 32 环境，原正式 APK 与候选包均出现 `host_closed` 初始化阻塞。
- 已用原正式 APK 单独控制变量：竖屏不变，冷启动基线正常，仅将系统 `font_scale` 从 `0.85` 改为 `1.3`，即可复现。此前的字体＋横屏联合测试不是单独归因依据。
- 冷启动只用于建立这一对照条件，未清理应用数据，也未将重启算作修复。
- 故障后，候选的 3 本合成书、正式包的 1 本合成书仍能只读查询；错误态没有伪装为空书库。
- 当前环境为 Android API 32、WebView 120；原 BOOX WebView 为 146。因此尚未证明它就是原先跨页 `native_action_error` 的根因。

证据目录：`.cache/ui-ux-20261022/api32/`。关键回执：`fontscale-only-before.json`、`fontscale-only-after.json`、`fontscale-data-preserved.json`、`formal-fontscale-data.json`、`activity-recreation-finding.json`。

## 静态原因与范围风险

`NativePagesPlugin.kt` 保存构造时的 `Activity` 和 `host`；命令执行时会对已销毁宿主返回 `host_closed`。实际编译使用的 Tauri 2.11.5 `PluginManager.onActivityCreate` 在首个 Activity 初始化后直接返回，源码也有相关 TODO。应用 Manifest 的 `configChanges` 未包含 `fontScale`，系统字体变化会触发 Activity 重建。

不能只将 `closed` 改回 `false`，或只为这一条错误加重试。旧请求、可见性租约、未决写入和 ActivityResult 启动器可能仍属于旧宿主；错误地复用会突破现有提交结果栅栏。添加一个 Manifest 标志也不能证明所有 Activity 重建场景已经处理。

## 建议批准的专项边界

在**项目 Android 适配层**中设计并实现 Activity／原生页面宿主的安全重新绑定，保持已有原生＋Web 架构、依赖版本、数据库和持久化格式不变。

1. 冻结当前 18 文件版本及必要直接闭包；区分 Activity 生命周期与应用级持久化状态。
2. 只读确认当前 Activity、原生插件、宿主及 ActivityResult 启动器的实际所有者，再选择最小重绑定方案。
3. 新宿主建立新的会话／租约；旧宿主回执不能穿透到新宿主。既有未决写入不得丢弃、自动重放或以默认值覆盖。
4. 先在任务 AVD 验证，再独立只读复审。若需要扩大到 SDK／全局 Rust 缓存补丁、依赖升级或新增恢复管线，停在该选择之前另行说明。

初始排查对象：`NativePagesPlugin.kt`、`MainActivity.kt` 及直接相关生命周期适配；不能借此改写 canonical 设置库、文件夹授权、阅读计时口径或整个 `ReaderView.vue`。

## 验收出口

- 单独字体变化、单独横竖屏、普通后台返回以及 Activity 重建分别验证，不能把联合测试归因于单一变量。
- 重建后目录、统计、藏书、在读及笔记入口均响应；文件选择器仍能返回到当前宿主。
- 书籍／批注身份、CFI 与本机草稿保留；阅读时长不重复累加。
- 设置尚未提交／写入结果未知时维持既有核对和恢复边界。
- 不清数据、不卸载回退、不以重启代替验收；不安装主设备、不推送或发布。

**本专项及后续项目内 SDK 兼容范围已分别获批并实施。** 原范围不自动授权 SDK 扩展，实际追加批准原文已冻结于 `.cache/ui-ux-20261022/lifecycle/approved-sdk-scope.md`。当前 50／50 定向测试、构建、独立复审及 API32 结果见 [实施与定向验证](android-lifecycle-implementation-20261023.md)；整体 S4 仍 BLOCKED，不授予主设备、私人数据或发布权限。
