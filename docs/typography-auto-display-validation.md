# 自动排版与单书显示方案：R2 验证状态

**当前状态：R2 已保留数据安装；9 组合成书的排版、单书记忆和进程重启恢复通过。原生返回键异常，整体验收仍阻塞。**

## 实现范围

- 流式 EPUB、阅读时转换的 TXT / Markdown 自动选择中文、英文或中英混排方案。无可靠主语言的均衡混排仍选择混排，不虚构中文语言声明。
- 解析顺序为自动方案 → 已保存的语言偏好 → 单书偏好。仅打开书籍不创建单书覆盖；应用时只保存实际变化的字段。
- 单书文字、主题、翻页/滚动、分栏及进度显示偏好独立保存；调暗为设备全局设置。草稿取消不生效，恢复后继续编辑不会被误当成“仅删除旧配置”。
- 字体、分页及阅读锚点验证使用同一候选配置；存储拒绝、字体 promise 拒绝或超时不会提交新配置。CFI 重定位使用逻辑字符起点，避免跨栏范围的联合矩形导致位置漂移。
- 固定版式、竖排不套用自动文字优化；PDF 保留原有阅读链路，不在本次自动文字方案验收范围内。

默认值参照原始方案：中文行高 1.70、缩进 2 em、段距 0.15 em；英文行高 1.55、缩进 1.2 em，章首不缩进；混排中文行高 1.75、缩进 0、段距 0.45 em，独立英文采用 0.96 倍字号及默认行高 1.55。未尺量时保留现有 CSS 字号，不将 CSS px 冒充物理 pt。

原始 `Pagewise_中英文阅读排版方案.md` 未修改。实施方案见 [typography-auto-display-plan.md](typography-auto-display-plan.md)。

## 已执行的验证

| 项目 | 结果与范围 |
| --- | --- |
| 类型检查、生产构建 | `vue-tsc -b && vite build` 通过；原生构建再次执行前端构建 |
| 核心回归 | 97 项通过，0 项失败；包含 8 组真实浏览器场景 |
| 既有功能兼容回归 | 134 项通过，0 项失败；涵盖菜单、图标、标签可见性、功能移除、阅读位置及返回等 |
| 独立复核 | PW-TYPO-01、02、03 原问题关闭；无新增已确认 blocking，不等于完整需求或设备效果无条件批准 |
| 版本绑定 | 14 个复核运行时/配置文件哈希匹配；189 个原生构建输入未变 |
| APK 静态验证 | 签名、ARM64 ABI、包身份、权限、禁用备份、原生库与当前前端嵌入关系通过 |
| 真机 | R2 覆盖安装成功，UID 10097 不变；新增 9 本自有合成书，原有 3 本书和 1 条批注及既有显示偏好保留；原生 Back 未通过 |

浏览器验证包括：有/无声明的混排 EPUB、TXT / Markdown 的方案及实际正文样式；单书修改、取消、切书、重载；混排字号/主题修改后英文规则不漂移、跨章一致；显式行高覆盖；恢复后编辑；存储拒绝；字体 promise 拒绝、超时及晚完成；原始 CFI 字符点可见性；真实 foliate 开书退出后的 book 释放计数；英文窄屏界面及尺量换算控件。

测试日志仍出现过 `ResizeObserver loop completed with undelivered notifications`。最新核心日志记录 5 次、兼容回归日志记录 8 次，保留原始记录，来源尚未定性；**不宣称浏览器零运行错误。**

证据：

- `.cache/typography-auto-20261017/acceptance-r2.json`
- `.cache/typography-auto-20261017/tests-r2-supplement.log`
- `.cache/typography-auto-20261017/tests-r2-regression-unique.log`
- `.cache/typography-auto-20261017/reports/independent-review-r2.md`
- `.cache/typography-auto-20261017/review-02/manifest.json`
- `.cache/typography-native-20261018-r2/apk-verification.json`
- `.cache/typography-native-20261018-r2/native-final-status.json`
- `.cache/typography-native-20261018-r2/native-defaults.json`
- `.cache/typography-native-20261018-r2/native-edits.json`
- `.cache/typography-native-20261018-r2/native-restart.json`
- `.cache/typography-native-20261018-r2/native-media.json`
- `.cache/typography-native-20261018-r2/native-back-trace.json`

复核后只补充了测试，无运行时代码修改。补测验证转换正文实际样式及真实 foliate 正常退出释放；不把它推广为全部异步开书失败/中断顺序均已验证。

## APK

[Pagewise-typography-auto-20261018-r2-arm64-debug.apk](../artifacts/android/Pagewise-typography-auto-20261018-r2-arm64-debug.apk)

- 验收专用 ARM64 debug 包，版本 1.15.0，非生产发布包。
- 包名：`io.pagewise.reader.acceptance.v03.debug`，沿用既有独立合成验收身份。
- SHA-256：`5340c799bd58d9c6a02750d5d1c995d9e08d1882961fe03931b7ac90bbbf09d9`。
- 已通过 `adb install -r` 安装到同一验收包，未卸载、未清数据。菜单版本 APK `e775298e…` 恢复点仍保留。

## 剩余验收

1. PW-NATIVE-BACK-01：Android 原生返回键会离开书籍，而不是仅关闭排版草稿。已定位到 Wry 后注册的回调覆盖读取页回调优先级；本轮未改运行时代码，需另开修复及重新打包验证轮次。
2. 其余原生输入、复杂阅读模式组合及未覆盖的模板组合继续保留边界。详见 [真机矩阵记录](typography-native-matrix-20261018.md)。
3. 实物尺量后检查字号、系统文字/显示缩放与墨水屏观感。换算链路测试不是物理精度证明，也不是长期舒适度或耗电结论。
4. mm 页边距、独立标题/脚注字号体系、新字体包供应、跨章复杂混合布局及全部语言/单书模板组合不作已完成声明。
