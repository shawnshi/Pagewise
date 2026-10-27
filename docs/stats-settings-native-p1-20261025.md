# 统计／设置原生 P1 验收 · 2026-10-25

**P1 限定通过：27/27。完整原生矩阵仍未完成；未部署正式版。**

## 本次授权与范围

用户在知悉同一焦点条件已有 3 次记录后，明确确认追加**仅 1 次 P1**。旧记录不清零；本次为第 4 次、人工明确批准的单次追加执行，没有自动重试，也未启动 P2。

配置：新建 API 32 AVD，中文，320dp 宽、目标显示 320×1000、系统字号 1.8、浅色。实际回执确认宽度 **320dp**、字号 **1.8**。

目标仅为 `io.pagewise.statsfixture` 合成测试 APK；无 INTERNET 权限。运行真实生产 Native View 模块，但依赖受控 RPC 与编译专用接口桩；这不是完整生产 APK、真实书库／存储或模型验证。

## 结果

- 原 **27 项用例及断言正文未改**，本次 **27 通过、0 失败、0 未执行**。
- 日期明细经触控打开、分页复用同一窗口并保留焦点。
- 大字号目标表单页脚完整可达；待提交时禁止 Back／重复保存；未知结果保留输入并可就地核对。
- 枚举／布尔草稿与 canonical 值分离，未保存不提交，CAS payload 类型保持不变。
- 原先阻塞的 `explicitly close retained boolean input` 与末项窄屏 Back 返回目录均通过。
- 生成 6 张附着窗口／View 的 Canvas 渲染图。人工查看目标弹窗与通用设置图，按钮和文字未发现截断；不将这些图称为物理 EPD 截图或整机波形验收。

单次模拟器执行耗时 **68.253 秒**，低于活动阶段 150 秒上限。进程 exit 0，`runningAtExit=false`；最终精确身份探针确认本任务模拟器 **0** 个。未操作 BOOX、正式包或共享 ADB 生命周期。

## 源码绑定与预检

490 个输入在本次运行期间保持不变，未修改生产代码或测试源码。测试 APK 编译包含 17 个生产 Kotlin 模块及两个测试 fixture 文件。

预检曾发现 `NativeStatsSettingsMain.kt` 在上轮冻结后出现工具格式化漂移。原 27 项正文保持一致；当前 APK 对应编译产物与上轮通过 SDK 编译的候选相比，**101/101 类规范化字节码相同**，通过后才启动本次模拟器。规范化排除调试信息、栈映射帧、两个调试注解及 NOP；不宣称原始类文件或 APK 逐字节相同。旧冻结和失败记录保留。

测试 APK SHA-256：`b9637ec0a989ecce9549f06c04d53ba14be1b5700cf2e735d25c9b59ba08e11c`。

证据根目录：`.cache/stats-settings-native-p1-20261025-approved/`。

- `preflight.json`、`native-execution-token.json`：本次明确授权、历史计数和单次额度。
- `fixture-build/build-result.json`、`format-bytecode.json`：编译及格式化等价证据。
- `android32-p1/activity-result.json`、`instrument.log`：实际 27/27 回执。
- `android32-p1/process.json`：执行期限及进程清理。
- `android32-p1/{overview,calendar,day,goal,settings,boolean}.png`：6 张附着 View 渲染图。
- `acceptance.json`：本次限定状态及剩余未执行范围。

## 尚未完成

英文 320dp／1.8、中文 600dp／1.3、992dp／1.0 浅色与深色、992×600 横屏共 **5 个配置未执行**。本次通过只关闭 P1 配置下的焦点同步阻塞，不能覆盖剩余矩阵。

完整无障碍、未列入原用例的 IME 组合、真实 WebView／馆藏／模型、生产构建部署和物理 EPD 灰阶／波形／残影仍未验收。其余阶段按 `docs/stats-settings-native-acceptance-plan-20261025.md` 另行授权；本次单配置授权不连带扩展。
