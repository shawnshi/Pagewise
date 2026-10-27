# 本地图书推荐：实现与验收记录

> 后续更新（2026-10-25）：原生详情阻塞已通过夹具补全和同组 **14/14** 合成验收解除，见[补充报告](book-recommendations-native-detail-20261025.md)。以下保留原阶段 **13/14／BLOCKED** 的历史结果；正式部署及其余未覆盖边界没有因此获得验收。

## 结论

**整体状态：BLOCKED，不能宣布三端验收完成。** 三个入口已接入源码，Web 流程通过；Android 原生测试最终为 **13/14**，详情页入口尚缺有效运行回执。本轮未打包或安装正式 APK，文石现有安装不包含这些改动。

需求原件：`C:/Users/shich/Downloads/book_recommendation_design_doc.md`。设计取舍见 [设计记录](book-recommendations-design-20261024.md)。

## 已实现的行为

- 正在阅读新增推荐入口：相关、拓展各最多 5 本；保留原有六种阅读状态及管理能力。Native 用“书目／推荐”切换，原状态筛选留在书目模式，不修改原会话标签协议。
- 书籍详情新增第四个“相关与拓展”标签：各路最多 6 本，显示实际数量，首次进入才请求。
- Foliate 阅读器自然到达结构性末页后，提供最多 4 本相关馆藏。首次打开／恢复就在末页不弹；跳转、检查、重排和离开屏障分别处理；一个阅读实例最多提供一次。
- 原版 PDF 分页／连续滚动接入末页几何门控；最后页须已绘制，视口到达底部及横向边界，并有阅读输入。已退役的流式模式没有恢复。
- 书末无合格候选时静默收尾；不自动标记“读完”，不自动打开下一本。弹窗期间暂停阅读计时，已有有效时长保留。
- 卡片支持详情、显式加入想读、不感兴趣及关联不符。想读通过状态专用 CAS，仅更新 `readingStatus`，不伪造进度、时长或 CFI。
- 不感兴趣按候选记录生效；关联不符按来源与候选配对生效。仅本功能负反馈可显式清空，Native 使用独立 `bookRecommendationFeedbackV1` 设置命名空间和整值 CAS。
- AI 理由仅在用户主动选择“发送书目摘要生成 AI 理由”后请求现有服务；校验候选、来源和双锚点。输出标注未核验，失败保留本地理由；取消、超时及过期结果不落入后继页面。

## 与 PRD 技术建议的差异

这是**本地元数据词项向量首版，不是 BGE／语义嵌入实现**。使用稀疏 TF-IDF、分类、主题、作者及显式分卷规则；不把词项得分冒称语义相似度，也不照搬 PRD 的语义余弦区间。

相关与拓展互斥，限制作者重复并保持分类分散；理由指出来源书与具体元数据线索，不编造引用关系。馆藏不足或证据弱时少给，不保底凑到 3 本。没有新增依赖、模型下载、数据库表或持久化向量索引；索引与上下文缓存限于进程内。

处理上限为 10,000 本、每本最多 160 个词项；超限明确失败，不截断后声称完整。推荐只用有限书目信息及应用已有的最近阅读时间／状态／进度，不扫描正文或批注。代理本轮没有读取真实私人书库，也没有调用真实模型。

## 已执行验证

各组分别计数，**不相加成一个“总通过数”**。

| 验证组 | 结果 | 回执 |
|---|---:|---|
| 引擎、反馈、动作、桥接及相关合同 | 45/45 | `.cache/book-recommendations-20261024/core-related-final.log` |
| 真实 IndexedDB／宿主 SQLite 存储 | 2/2 | `storage-first.log` |
| 阅读时钟、会话、返回、简介相关回归 | 29/29 | `reader-introduction-regression-v2.log` |
| 实际 Web 页面与阅读器 | 4 个子场景通过；含父测试 5/5 | `browser-fourth.log` |
| Android API32 真实 Activity／Views | **13/14**；中英文 6 组布局及 6 图通过 | `android32-v4/activity-result.json` |
| TypeScript／Vue 类型检查 | exit 0 | `typecheck-final.log` |
| 实际 Vite `build()` | exit 0，441 模块 | `frontend-build-final.log` |
| Kotlin 与测试 APK | 16 个生产模块编译、DEX 与签名通过 | `fixture-build-v4/build-result.json` |

相对回执路径均位于 `.cache/book-recommendations-20261024/`。

存储测试覆盖字段级竞争、删除不复活、并发只成功一次、旧 `unread` 规范化、重开持久性，以及其他书目信息、文件和 CFI 不变。Web 使用空浏览器库中的自有合成 TXT／PDF，覆盖真实推荐页面、状态保存、真实 Foliate `renderer.atEnd`、PDF 分页末页、一次性弹窗、焦点与窄屏／大字号关闭操作；没有外部请求。

Android 使用无网络权限的测试包 `io.pagewise.recommendations.test`，不是生产 APK。通过项包括六项交互、六项附着窗口布局、以及实际在读推荐入口。仓储与 Host 依赖使用明确标识的编译替身，页面传输使用合成响应；这不构成生产桥接或真实书库端到端验收。

## 未关闭的问题

### REC-NATIVE-DETAIL-01：原生详情入口验收受阻

最后一项测试无法找到详情推荐标签。只读定位表明 `NativePagesController.book()` 必须先完成：

1. `library.book`；
2. `action.libraryBookInfo`，取得 `effectiveReadingStatus` 与 `supported`；
3. 才执行 `renderBook()`。

当前受控传输缺少第二个响应，因此夹具未到达详情渲染。**这不是已证实的生产缺陷，也不能算运行通过。** 已停止该验证分支，没有继续放宽断言或修改生产逻辑。最小后续方案是补齐该合成协议响应，再用单独有界计划验收详情入口、数量和写入期间切换屏障；本报告没有把这个方案记成已执行。

历史结果保留：首轮无结果文件；随后定位私有 `root` 字段假设错误，改用实际 `controller.show()`；再补齐设置读取响应，在读入口转绿。具体回执和条件见 `issue-ledger.json`，没有用后续结果覆盖旧失败。

### 诊断与剩余边界

- 独立干净上下文审查完成：采用校正后的 v2 `scoped_OK`，仅覆盖绑定源码，不替代运行态。初稿中关于 `meta.json`、Foliate 索引算式及泛 Git 回退的错误描述不作为当前依据。见 `independent-review-v2.md`、`independent-review-binding.json`。
- 主动 LSP 探针：16 路径，0 个确认 clean、13 个不确定、2 个过大；3 个辅助 JSON 解析发现位于冻结前后未变的 `rowToMeta`。类型检查与构建通过另列，不称 LSP clean。
- PDF Back 的既有源码提取测试补入新增弹窗的两个默认 ref；没有新增动态执行入口。安全规则仍会提示既有 `new Function` 测试机制，其输入为固定的一方源码与合成桩，不是图书或网络文本。对比见 `regression-harness-static-summary.json`。
- 调整视口／字号时 Vite 输出 ResizeObserver 调度告警，Web 测试的 `pageerror` 与外部请求记录为空。改动前 Reader 的隔离探针也输出该告警，但其按 `pageerror` 计数的断言失配；该辅助探针不计成功测试，保留失败日志。
- PDF 连续滚动仅有几何／状态机与源码检查，本轮真实 PDF 页面用例验收的是分页。物理 EPD、完整 TalkBack／键盘／触控、旋转／IME、真实模型输出及真实馆藏推荐质量未验收。
- 2,243 条合成元数据的单次宿主样本：建索引 1,000.0409 ms，排序 19.2478 ms，采样 RSS 123,027,456 bytes；Node v25.9.0，AMD Ryzen AI 9 H 365。不是峰值内存，也不是文石指标或性能承诺。

## 变更与恢复边界

469 个既有源码输入已冻结；允许修改集合外的既有输入保持原字节。当前差异、哈希和恢复副本见 `own-source.diff`、`source-inputs-after.json`、`before/`、`scope-verification.json`。只允许按本轮差异或精确副本恢复，禁止泛 `git checkout`／reset；代码恢复点不是数据库备份。

本轮四个自有模拟器均已关闭；未停止共享 ADB、未操作文石书库。没有提交、推送、依赖／版本更新或正式包部署。以后若获准打包，必须重新执行前端构建和 Rust 载荷编译，不能复用旧 1.8 UI-fix ELF 冒称包含新功能。

机器回执：`.cache/book-recommendations-20261024/acceptance.json`，当前状态 **BLOCKED**。
