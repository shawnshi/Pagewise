# 知页独立入口与离线边界提案（历史方案）

> 本文的“仅 EPUB、移除全部网络、另建独立入口”范围已被后续需求替代；不作为当前实施合同。当前复用并精简现有 Android 入口，保留五类格式与普通 AI/翻译/Edge 网络能力，见 [实施方案](implementation-plan.md)。历史问题中涉及文件安全、保存及真机验证的风险仍需按实际代码核验。

当时状态：已完成两路只读源码复核，**尚未实现离线运行入口，尚未构建知页 APK**。先完成原版设备准入再实施完整适配，不以缺少实机验证为理由扩大全局环境改动。

## 固定来源及最小复用面

- 实际源码固定为 LightRead `v1.15.0` / `9027e9a09ef19c1c37cc828c9fd42b21119e1ac9`，独立仓库 `reader/`，分支 `pagewise/epub-first`。原 AGPL-3.0-or-later 许可及第三方许可保留。准入基线准备时未修改上游运行代码，也未执行发布脚本；后续名称、说明与图标变更见 [品牌适配](branding.md)，不代表离线入口已实现。
- 两个只读子代理最初检查的是缓存提交 `cd53268`；这是设计线索，不冒充对固定 tag 所有文件差异的完整审计。实施时应逐个读取固定 tag 的对应正文。
- 新建独立 `src/pagewise` 入口，复用 Foliate 的打开、CFI 定位、选区及标注接口，不导入上游 `App.vue` 启动链和整页状态。
- 候选接缝：`src/services/foliateBook.ts` 的 `makeFoliateBook(file)`；`src/views/ReaderView.vue` 的 `relocate/load/create-overlay/draw-annotation` 事件；`renderer.setStyles`；`src/storage/dexie.ts` 的本地 CRUD。候选接缝仍须在固定 tag 和目标 WebView 上验证。
- 直接控制正文排版，取消对 NeoReader 外部界面操作及“保存确认”的依赖。语言未知、多语言声明不擅自归类；全局默认/语言预设/单书手动设置分层，单书设置优先。历史字号 34/32 不是已校准的 CSS 数值。
- 先仅支持本地无 DRM EPUB；PDF 仍由现有阅读器处理，不承诺迁移 NeoReader 进度或批注。

## 承重问题与实现前门槛

| ID | 已知问题/证据接缝 | 最小处理方向 | 验收 |
|---|---|---|---|
| PW-01 | 上游 App 启动更新、统计、同步/互传；net.ts 不是唯一网络入口 | 独立启动入口，停用相关生命周期 | 未产生远端连接；不得将异常伪装为无数据 |
| PW-02 | default capabilities 任意 HTTP，lib.rs 注册网络、更新、opener 等命令 | 白名单原生命令，不注册非必要插件/命令 | 恶意 EPUB/外链不能转交浏览器或原生网络 |
| PW-03 | Android 补丁添加安装权限；原版 APK 实含 INTERNET / REQUEST_INSTALL_PACKAGES | Manifest 合并删除标记，移除更新桥及安装流程 | 最终 APK 与合并清单均不含权限；重复补丁幂等 |
| PW-04 | csp:null；仅黑白 CSS 无法定义墨水屏硬件刷新 | 验证后的 CSP、禁书内脚本与外部导航；先靠系统应用优化 | blob/章节/本地图片正常，网络和 intent/新窗均拒绝 |
| PW-05 | Android 导出可沿 WebView download 路径误报成功 | 受限源令牌 + 原生 SAF 流式写出；成功/取消/错误独立 | 真实文件、取消、失败及恢复均核验 |
| PW-06 | 阅读位置防抖和退出清理可能丢最后一次定位 | 立即保留最新 CFI，退出前明确持久化，不只固定页码 | 调整字号/重开/休眠后仍指向同一内容 |
| PW-07 | 普通 content:// 不是桌面文件路径 | 使用系统文档选择及 ContentResolver 拷入应用私有目录 | Android 选择器导入可用，取消不生成假书籍 |
| PW-08 | 首版无需 AI/PDF/云同步，但上游依赖图较大 | 切独立入口、按实际依赖裁剪，避免为品牌先重写引擎 | 构建入口无联网模块，包体和内存有真实测量 |

静态权限撤销不替代外跳/运行时验证，CSP 字符串存在不代表 Foliate 资源加载正常。原生文石刷新/手写 SDK 暂不接入；后续确有需求再建立独立能力门。

## 构建环境差异

上游 CI 使用 JDK17、Android API36 和 NDK26.3.11579264；本机为 JDK21、现有 SDK 平台/NDK30，且没有已安装的 Rust Android target。CI 精确组合缺失不单独证明绝对无法构建，但不能宣称已有可复现 Android 构建环境。本轮未自动安装/升级全局 SDK、NDK、JDK、Rust target 或依赖。

设备准入后，根据实际固件/WebView 和构建需求选择任务隔离的依赖/SDK 方案；若确需全局环境变动，先界定目标与副作用。不要复制上游发布密钥/Cloudflare 说明或运行发布工作流。
