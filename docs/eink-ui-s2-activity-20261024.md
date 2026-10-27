# S2 真实测试 Activity 验收

## 结论

**本轮 S2 合成 Android 展示验收完成（scoped DONE），源码独立复审 `scoped_OK`。没有部署生产包。**

用户批准的新计划使用全新专用模拟器、真实测试 Activity、合成书目和20分钟上限。自有实例运行 **679.6秒** 后正常关闭；未停止共享 ADB，未操作实体设备、升级 SDK 或放宽权限。

本结论不等于生产 APK、Web 桥／数据库端到端或物理墨水屏验收。A 仍指向 S5 的 Native-first 首页与阅读时延迟加载既有 Web 阅读器；S3–S6 尚未实施。

## 实际修复链

| 执行 | 结果 | 处理 |
|---|---|---|
| `activity-current-v1` | 26/28 | 得到合法 Activity 回执；嵌套窗口选择器遇到延迟移除的已关闭窗口，大字号标题检查失败 |
| `activity-current-v2` | 27/28 | 选择唯一 `isShowing` 窗口，保留原断言；确认标题第二行省略7字符，保存失败图片及布局测量 |
| `activity-current-v3` | 28/28 | 修复标题及窄屏正文挤压，保留并加强几何断言；生成6张渲染图 |

三轮分别保存，不合并计数，也不把先前失败改写成通过。此前 `app_process` 的三次 setup 失败保留为历史，本轮没有重放该运行器。

### 关闭的问题

- **S2-RUN-HEADER-01**：藏书标题不再强制最多两行。320dp、1.8倍字体由 ellipsis `[0,7]` 改为三行 `[0,0,0]`；其他页面原限制保留。
- **S2-RUN-ROW-01**：截图发现操作按钮将正文挤成单字窄列。书目行现在按实际测量宽度及字体，把操作区移到下一行；封面和正文仍横排，宽屏恢复右侧操作区。大字号下藏书正文列宽336px、在读263px，均大于测试作者词宽188px。
- **S2-RUN-DIALOG-01**：测试只选择唯一仍显示的对话框，不把延迟移除的旧对象误当活跃窗口；旧 epoch 不改变 session／请求数的断言保留。

生产修复仅涉及 `reader/src-tauri/android/NativePagesController.kt` 的展示；另修改合成 fixture 的窗口选择及诊断。未改 schema、书籍／批注 ID、CFI、未知提交、selection-token、12／24页容量或设置提交屏障。既有 S2 实现授权覆盖这些精确 owner；本次批准没有授权生产安装。

## 验证证据

- **真实 Android Activity：28/28。** API32，测试包 `io.pagewise.einks2.test`，实际 UID10149；不是以 `app_process/systemMain` 冒充正常应用初始化。
- **六个渲染配置。** 藏书／在读分别覆盖320dp、992dp、320dp＋1.8倍字体。生产 Controller、Panel、UI 工厂在真实 Activity 生命周期中执行，手动 measure/layout 后用 Bitmap Canvas 渲染；transport 使用合成回执，没有访问生产 Web 桥、私有书库或真实书目。
- **相关回归34/34。** 包含 DTO、生产提取 Kotlin、准入／旧回执／未知写入及静态守卫断言；不把这些全部称为 Android 触控测试。
- **构建与安装身份。** 12个真实生产 Kotlin 文件加 fixture，compileSdk36；测试 APK 为 min24／target36、debuggable、testOnly，签名验证通过。拉回已安装 APK，与本轮候选字节一致；全新 AVD 未安装 `io.pagewise.reader` 或独立 debug 包。
- **类型检查。** 本轮未改 TypeScript；前轮真正 `tsconfig.app.json` 的通过回执仍适用于未变的 DTO 源码，空 solution 配置的 no-op 不计入证据。
- **独立复审。** 干净上下文 reviewer 返回 `scoped_OK`／`OK with notes`，确认三个问题关闭，允许本轮合成展示门转为 scoped DONE，未批准发布。
- **LSP限制。** 最后2个 Kotlin 路径均 inconclusive，60项辅助发现；没有 confirmed clean。实际编译及运行通过不替代 LSP 覆盖声明。

主代理逐张查看6个 PNG，未见本轮定义的标题截断和单字正文窄列；独立 reviewer 检查源码及回执，未逐张目视图片。320dp／1.8倍字体下内容仍可能超过一屏，沿用滚动回退；没有实现自适应单屏容量，也不承诺所有操作同时在一屏可见。

## 预览

- [藏书：320dp／1.8倍字体](../.cache/eink-ui-s2-20261024/android-activity-current-v3/images/activity-current-v3/library-320-1.8.png)
- [在读：320dp／1.8倍字体](../.cache/eink-ui-s2-20261024/android-activity-current-v3/images/activity-current-v3/reading-320-1.8.png)
- [藏书：992dp](../.cache/eink-ui-s2-20261024/android-activity-current-v3/images/activity-current-v3/library-992-1.0.png)

以上为真实 Android Views 的合成 Bitmap Canvas 图，不是生产应用截图或物理文石屏摄影。

## 冻结与恢复

本轮目录：`.cache/eink-ui-s2-activity-20261024/`。

- `preflight.json`、`scope-supplement-ui-fix.json`：新运行计划及既有 S2 展示修复边界。
- `source-drift.json`、`source-drift.diff`、`reviewed-source/`、`current-source/`：预检发现3个 Kotlin 格式差异，恢复旧冻结文本并逐项比较，没有覆盖当前文件。
- `source-inputs-before.json`、`source-inputs-review.json`：460输入；语义修改仅 Controller／fixture，无关源码保留。
- `before/`、`before-runtime-ui-fix/`、`runtime-source.diff`：可恢复原稿及本轮差异。
- `related-final.log`、`installed-test-identity.json`、`synthetic-apk-signature.log`、`synthetic-apk-badging.log`：执行及包身份回执。
- `android32/process.json`、`emulator-stop-receipt.json`：专用实例关闭及20分钟上限证据。
- `independent-review.md`、`acceptance.json`：当前 scoped 结论。

三轮完整运行材料位于 `.cache/eink-ui-s2-20261024/android-activity-current-v1/`、`v2/`、`v3/` 对应目录。上一轮 BLOCK 的 `acceptance.json` 与审查原件保持不变，由本轮结论更新当前状态，不擦除失败历史。

## 未覆盖

同一 View 的窄宽→回宽、管理隐藏操作区仅完成源码复核；完整触控、TalkBack／键盘焦点、全部大字号分页未验。生产 APK、Web／数据库端到端、实体设备、EPD 波形／灰阶／残影、启动和内存未验。

原1.6数据恢复、旧 CFI／标签输入问题、真实十本审计0/10及历史完整S4仍按原记录保留。本轮没有构建或覆盖新的生产 APK；设备上次已验证的 bootstrap-fix release 不变。
