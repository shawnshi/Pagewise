# 书籍简介：获批原生合成验收

> 历史14/16失败记录。`INTRO-NATIVE-LAYOUT-01` 后续已限定修复，同一fixture与边界oracle的16/16验收通过，见[布局修复报告](book-introduction-layout-fix-20261024.md)。原始失败证据保留，未移用为成功；未打包安装生产APK。

## 结论

**BLOCKED：最终 14/16 通过，2 项窄屏大字号布局失败。** 关闭／取消、晚到回复、保存期间离开屏障和结果未知时禁止重放均通过；不能据此宣布整项原生功能验收完成。

本轮只修改测试 fixture，没有修改生产代码、数据库、版本号或 AI 配置，没有调用真实模型、打包／安装生产 APK或操作 BOOX。测试模拟器已提前关闭，共享 ADB 未停止。

## 授权与执行边界

- 用户“批准”仅承接一轮新的 **10 分钟原生合成验收**。
- 先完成宿主编译及测试 APK 打包预检，再启动 fresh userdata 的 `BookIntroductionAccepted32 / emulator-5600`，上限 600 秒；未续期或重启该模拟器。
- 测试包为 `io.pagewise.introduction.test`，具有 `testOnly` 标记、无 INTERNET 权限；不存在正式／debug 知页包或私人书库。
- 生产代码采用本轮开始时的当前字节。发现三份 Kotlin 文件相对上轮最终摘要有排版漂移，逐项确认仅为换行、逗号和等价分支括号，予以保留；没有把旧复审声称为当前字节认证。
- 实际只改变 `reader/scripts/fixtures/NativeBookIntroductionMain.kt`，其余 468 个冻结源码输入字节未变。

## 测试改进

- 等待真实 onShow／onDismiss 消息及 Choreographer 帧完成，不在临时默认按钮回调阶段断言。
- 不再对 DecorView 强制调用 measure/layout。采用实际已附着窗口的 ViewRoot 布局，分别设置 320／992 dp 宽、900 dp 高，并检查 1.0／1.8 倍应用字号。
- 同时检查按钮完整可见范围、窗口边界、至少 48dp 触控目标，以及穿过真实 DecorView 的触摸事件。
- 覆盖中英文界面，使用合成书目和 500 个合成单词的预览。不会把模拟器、Canvas 图或假传输当作 BOOX／真实模型证据。

## 最终结果

共 16 项：10 项行为检查、6 项附着窗口布局／触控检查。

**通过 14 项：**

- 初始预览不写入、确认替换初始禁用。
- 生成请求仅带书籍身份、请求 nonce、本次可选丛书输入。
- 编辑切换可保存状态；已提交保存不能假称取消。
- 关闭取消生成，晚到回复不能重新打开或保存。
- owner 切换拒绝晚到结果。
- source_changed、commit_outcome_unknown、保存传输失败均保留稿件并阻止不安全重放。
- 有／无原简介的实际概览入口及 Controller 保存离开屏障。
- 中英文各 320dp／992dp、1.0 倍字号：生成、替换及关闭触控链通过。

**失败 2 项：`INTRO-NATIVE-LAYOUT-01`**

条件均为 API32、密度 1、320dp 宽、900dp 高窗口、1.8 倍应用字号：

- 中文“确认替换”：相对窗口 y=912，高=54，超出窗口底部 900。
- 英文“Replace”：相同 y=912、高=54，超出窗口底部。
- 同配置中“关闭／Close”只有 26px 可见，而控件高 54px。

这不是旧版“有宽高即通过”的几何推断：新 oracle 同时检查真实窗口边界和完整可见性，截图也显示底部操作被裁切。此证据证明**指定合成配置**失败，不声称已经在 BOOX 上复现。

## 历史尝试与资源收尾

- `accepted-run-v1`：7/16 通过、9 项失败；窗口／触控时序尚未稳定，保留原始回执，不能全归因为生产缺陷。
- 对 fixture 增加帧级等待、触摸来源和诊断后，`accepted-run-v2`：14/16，收敛到上述两个布局失败；未做第三次盲重试。
- 测试 APK 在启动模拟器前已预编译。后续仅因 fixture 时序诊断改进重建测试 APK，没有改生产逻辑。
- 约第 505.8 秒发出精确实例关闭命令；监督进程确认退出码 0、没有残留运行实例，始终未停止共享 ADB。
- 上轮 53/53 核心／存储回归、9/9 Web 与持久化／桥接源码独立复审属于上轮证据，本轮没有重跑或合并计数。

## 最小修复提案（尚未实施）

仅调整 `reader/src-tauri/android/NativeBookIntroductionEditor.kt` 的弹窗布局：为正文预览设置受限滚动区域，将三个操作按钮放入可按宽度／字号重新测量的独立操作区，避免系统按钮区堆叠后越出窗口。保留生成／取消／确认及未知结果屏障，不改服务、存储、提示词或模型配置。

修复需另获授权；先编译预检，再以新的有界模拟器方案复验同一组 16 项及按钮完整可见性。当前仍不满足生产打包／部署门。

## 证据

目录：`.cache/book-introduction-native-20261024-approved/`。

- `preflight.json`、`source-inputs-before.json`、`before/`、`format-drift-review.json`。
- `fixture-build-v1/`、`fixture-build-v2/`：当前源码快照、编译／签名／测试包摘要。
- `accepted-run-v1/`、`accepted-run-v2/`：独立历史回执；后者包含 12 份阶段几何记录与 6 张窗口图。
- 缺陷截图：`accepted-run-v2/images/accepted-run-v2/native-zh-320-1.8.png`、`native-en-320-1.8.png`。
- `manual-stop.json`、`android32/process.json`、`source-inputs-after.json`、`scope-verification.json`、`acceptance.json`。

测试包 SHA256：`e457d4f63df1ddb8ad0b9e976538773e39bd3a37ae9f783b23c3261082e3b972`。这是合成测试 APK，不是知页生产安装包。
