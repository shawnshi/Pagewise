# 书籍简介：原生弹窗布局修复

## 结论

**DONE：本轮限定的 UI 修复与同组原生合成验收完成，16/16 通过。** `INTRO-NATIVE-LAYOUT-01` 在指定验收范围内关闭。

320dp 宽、900dp 高、1.8 倍应用字号下，中英文“生成／确认替换／关闭”均完整可见，触控链通过；生成、取消、晚到回复和保存屏障未回归。未调用真实模型，未打包／安装生产 APK，未操作 BOOX 书库。

## 最小变更

生产代码仅改 `reader/src-tauri/android/NativeBookIntroductionEditor.kt`：

- 用弹窗自有按钮及现有 `NativeActionFlow` 组织操作区，复用 `NativeUi.button` 的灰阶样式及 48dp 目标，不再依赖系统按钮面板对多行按钮的最小高度估算。
- 先测量完整操作区，再把剩余高度分配给可滚动正文；每次测量均重新计算，不截断按钮来凑高度。
- 私有 AlertDialog 子类保留 `getButton()` 与标准按钮 ID，原显示、返回、dismiss、生成、取消、确认保存及未知结果屏障代码保持逐字节不变。
- 不改提示词、模型／设置、桥接协议、存储／CAS、schema、版本、依赖、书籍 ID、CFI 或统计。

验证 fixture 未改，继续使用上轮同一份 `reader/scripts/fixtures/NativeBookIntroductionMain.kt` 和完整边界／触控 oracle。469 个冻结源码输入中仅上述一个生产文件变化，其他 468 个不变。

## 验证

- 当前源码预编译及测试 APK 打包在启动模拟器前完成，15 个真实生产模块、2 个 fixture 编译通过。Host／Dispatcher 闭包仍使用明确的编译专用仓储依赖 stub，不冒充完整生产 APK 构建。
- fresh userdata：`BookIntroductionLayout32 / emulator-5602`，API32，测试包 `io.pagewise.introduction.test`，无 INTERNET 权限、无生产包／私人数据库。
- **同组 16/16：**10 项行为检查，加中英文各 320dp@1.0、992dp@1.0、320dp@1.8 的 6 项实际附着窗口／触控检查。
- 保留 12 份阶段几何记录、6 张窗口图；没有强制 DecorView measure/layout，没有放宽此前失败的完整可见边界或 48dp 断言。
- 1.8 倍字号、320dp×900dp、密度 1：中文“确认替换”从旧 y=912／高54（越界）变为 y=774／高48；“关闭”从仅26px可见变为 y=828／完整48px。英文对应操作区也完整可见，真实触控流通过。
- 生成／保存／取消等业务方法、显示生命周期回调、API33 返回辅助代码分别与冻结前副本逐字节一致；该静态检查不替代上述运行结果。
- LSP 1 路径超时／inconclusive，0 路径确认 clean；不把“0诊断”写成语言服务器通过。真实 Kotlin 编译及 API32 运行结果另列。
- 模拟器约第141.7秒发出精确实例关闭命令，监督进程确认退出码0、无残留实例；未延长600秒上限，未停止共享ADB。

前轮 53/53 核心／存储回归、9/9 Web 和持久化／桥接独立复审属于各自历史记录，本轮未重新执行或合并计数。本轮为 L2 局部 UI 修复自审，不宣称新增独立批准。

## 限制

本轮证明的是 API32 合成 Activity 内的真实生产 Views／窗口与受控传输，不是生产知页 APK、真实模型、BOOX 墨水屏或完整系统集成验收。API33 返回运行路径、IME 弹出、同实例旋转／字号切换、完整键盘／TalkBack、实际面板刷新均未新增验收。

生成与保存业务逻辑未改不等于生产设备已经生效。若后续授权打包，此功能已改变前端，必须真实 Vite 与 Rust 重编，不能复用旧 UI-fix 的 Web／ELF 载荷。

## 证据与恢复

目录：`.cache/book-introduction-layout-fix-20261024/`。

- `preflight.json`、`source-inputs-before.json`、`before/`：当前授权与冻结恢复点。
- `fixture-build-v1/source-snapshot/`、`source-inputs.json`、`build-result.json`：编译输入及测试包绑定。
- `fixed-run-v1/activity-result.json`、`images/fixed-run-v1/`：16项、几何及截图。
- `behavior-preservation.json`、`manual-stop.json`、`android32/process.json`、`lsp-final.txt`。
- `own-source.diff`、`source-inputs-after.json`、`scope-verification.json`、`issue-INTRO-NATIVE-LAYOUT-01.json`、`acceptance.json`。

恢复仅针对本轮一个生产文件的差异，先核对当前字节，再使用 `before/` 或反向应用 `own-source.diff`；不 reset 脏工作树，也不是设备数据库回退方案。前轮14/16失败回执保留在 `.cache/book-introduction-native-20261024-approved/`，不重写为成功。
