# 统计／设置 E-ink 呈现重构 · 2026-10-25

**状态：BLOCKED。源码候选已实现；冻结版本获独立源码审查 `scoped_OK`，但原生运行验收未闭合。未打包或部署正式 APK。**

## 已实施

- 统计拆分为概览、趋势和日历／年历，保留筛选、日期、分页与视图上下文；窄屏日期列表替代过密触控网格，密集年度热图作为非交互概览，另有选日入口。
- 设置保留八个实际分类及现有 `section` 入口，宽屏目录＋单组内容、窄屏列表／内容返回；布尔和枚举在同一表单内编辑草稿，仍显式保存。
- 新增专属灰阶、排印、触控和有界弹窗控件，不修改 `NativeUi` 全局默认行为。网页样式限定统计、设置及当天详情作用域。
- 设置关联校准页补充 `documentElement` 尚未就绪时的空值保护；未改校准公式或保存流程。

主要文件：`reader/src-tauri/android/NativeStatsSettingsUi.kt`、`NativeStatsPanel.kt`、`NativeSettingsPanel.kt`、`NativePagesController.kt`，以及 `reader/src/views/{StatsView,SettingsView}.vue`、`reader/src/styles/stats-settings.css`、统计子组件和 `nativeSettingsEditing.ts`。

## 受保护行为

统计聚合口径、至少 60 秒的活跃日、同期比较、设置字段／枚举原值、CAS、恢复、未知结果不重放、导入及扫描所有者不变。13 个核心／依赖文件与任务前基线字节一致；设置 schema 除新增选项展示标签外与基线完全一致。未读取真实书库／阅读记录，未调用真实模型，未改依赖、版本、数据库结构或正式安装。

## 分项验证，不相加计算

| 层面 | 证据与结论 |
|---|---|
| 宿主合同 | 冻结输入 **95/95**，`contracts-final.log` |
| 浏览器 | **8/8**（7 个子场景及父测试），覆盖三视图、八组设置、深链接、焦点返回、320/600/992px、文字压力和深色；`browser-v5/`。文字压力不是 Android 系统字号验证 |
| Vue／TypeScript | `vue-tsc --noEmit` exit 0，`typecheck-final.log` |
| 实际前端构建 | 调用 `vite-isolated.mjs` 导出的 `build()` 成功，输出仅在本任务缓存；`frontend-build-v2.log` |
| 原生编译 | 17 个生产 Kotlin 模块和合成 fixture 编译通过；仅测试 APK，无 INTERNET 权限 |
| 原生运行 | 首个 **320dp／系统字号 1.8／中文**配置：**25 通过、1 失败、1 未执行**；其余 5 个配置未运行。`android32-v6/` |
| 独立审查 | `reviewer` run `b39dd20f-4812-4843-ab39-07944de69d7a`：源码 `scoped_OK`，整体完成门 `REJECTED_WITH_BLOCKERS` |
| 语言服务 | 24 路径中 8 确认 clean、16 inconclusive，另有 123 条辅助静态规则发现；**不称全部诊断通过**。保留 `lens-final.txt` |

浏览器最终回执无页面异常、外部请求为零；日志中仍保留 ResizeObserver 通知警告，不能据此宣称所有控制台事件为零。

## 阻塞与停止边界

**`ISS-SS-NAT-HARNESS-01`：活动 Android 窗口没有焦点／等待焦点超时。**

同一可观测条件在 `android32-v4`、`v5`、`v6` 三次执行中出现，已达到重试上限。本轮停止原生分支，没有追加模拟器执行。最后失败位于第 26 项 `explicitly close retained boolean input`；不能用前 25 项或静态审查替代完整矩阵。现有证据未确立生产数据或状态损坏。

拟议后续范围仅为测试生命周期同步器与合成验收：在 dismiss 回调及 UI 帧稳定后重新取得当前存活窗口，按窗口焦点事件继续，而非等待已关闭窗口；保留原 27 项断言、不放宽几何／触控／未知结果保护，再制定新的有界验收计划。**须由用户对已达重试上限的阻塞分支另作决定，本报告不构成追加执行授权。**

本任务已启动的五个模拟器均有停止回执，最终精确进程探针发现本任务模拟器 **0** 个。未操作 BOOX 正式设备或共享 ADB 生命周期。

## 冻结、审查与格式化差异

证据根目录：`.cache/stats-settings-ui-20261025/`。

- 审查冻结源清单：`a3fc28e19156e959e358f59e13fbb7065dc986e7926d0b05adc702c7ddf02c2e`。
- 主动诊断后发现五个 Kotlin 文件与审查快照存在工具格式化差异。原始审查及失败回执未覆盖、未擦除；当前版本重新编译后，与测试 APK 对应编译产物的 **92/92 类规范化字节码相同**。规范化排除源码调试、栈映射帧、两个调试注解及 NOP；**不是原始类文件逐字节相同，也不是新增运行验收或独立风险接受**。详见 `format-bridge.json`。
- 当前源清单：`e35876d8f7e6f4519480235b4c0c94192dd1569384cc353f355fcac6e5bb726d`，487 个输入；19 个修改、5 个新增，受检写入范围之外没有变化。
- 当前任务差异为 `own-source-current.diff`；审查冻结差异为 `own-source.diff`。`before/` 保留既有脏工作树的精确原字节，只可哈希守卫后反向应用本任务差异，不做 Git reset。这是源码恢复点，**不是数据库备份**。

审查报告中关于 `typography/pdf/tts/goal` 额外深链接别名的表述未被当前实现核实，不作为通过事实；验收只采用实际分类键及已有 `library-display` 映射。审查中的低优先级样式重复和校准子组件旧触控回退声明观察保持未修，见 `independent-review-qualification.json`。

机器状态：`acceptance.json`；重试与授权边界：`retry-ledger-final.json`。完整 TalkBack、真实 WebView 系统字号组合、原生剩余配置及物理 EPD 灰阶／波形／残影均未验收。新源码未进入已安装的 1.8.0 UI-fix 包。
