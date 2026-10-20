# 伴读 / PagewiseCompanion 命名约定

## 统一后的名称

- 中文产品功能名称：**伴读**；英文界面名称：**Companion**。
- 组件与组合函数：`PagewiseCompanion*`、`usePagewiseCompanion`。
- 业务模块目录：`reader/src/services/PagewiseCompanion/`。
- 内存设置入口：`settings.pagewiseCompanion`。
- 类型、函数、常量：`CompanionLevel`、`CompanionItem`、`CompanionError`、`companionOn`、`companionColors`、`COMPANION_MODEL` 等，不再使用旧功能名派生的命名。
- 功能文档：`reader/docs/pagewise-companion.md`。
- 离线手册：`reader/docs/manual/05-伴读.md`。
- 测试入口：在 `reader/` 执行 `npm run test:companion`；覆盖核心功能、边界、兼容、生命周期与命名检查。

界面说明、模块注释、文档链接和测试文件同步更新。历史审计文档只同步名词与路径，不代表重新执行了其中记录的历史验收。

## 必须保留的兼容合同

以下是已发布客户端、缓存及远端服务的技术合同，不是仍在使用的产品名称，不按普通字符串批量替换：

| 合同 | 保留方式 |
|---|---|
| 本地设置及同步序列化 | `compatibility.ts` 的 `LEGACY_COMPANION_SETTINGS_KEY` 保持原键；内存统一使用 `pagewiseCompanion`，读取接受旧键与规范键，所有设置保存入口经 `serializeCompanionSettings()` 输出旧版可读格式。 |
| 旧手册深链 | `companionManualFile()` 将旧文件查询参数映射到新手册，不保留重复手册文件。 |
| IndexedDB 缓存 | `lightread-dianjing` 库名、Schema、缓存键及版本不变，不新建空库或丢弃既有缓存。 |
| 已部署 relay | `/v1/dianjing`、`dianjingPromptVersion`、`x-dj-*` 响应头保持不变；提示词输出协议版本与额度规则不变。 |
| relay 现有环境配置 | `DJ_DEVICE_DAILY_CHARS`、`DJ_IP_DAILY_CHARS` 保持原绑定，避免部署后丢失额度配置。 |

兼容转换不重新授权：合法 `true` / `false`、按书关闭记录、版本选择、密度及体裁偏好保留；畸形授权值不按真值处理；已有严格全局同意时，畸形按书覆盖按显式关闭处理，否则丢弃畸形条目，保留首次同意门禁。不会因名称变化自动开启智能版或扩大授权范围。

## 验证与范围

- `test-companion-compat.mjs` 使用合成设置和实际 Pinia store 验证旧数据读取、实际防抖保存、规范键优先级、畸形授权拒绝，以及设置页两个目录切换动作的即时保存。不连接设备或读取真实书库。
- `test-companion-names.mjs` 检查代码、文档和文件名；旧合同、旧格式合成样例及否定断言按明确范围保留，防止后续误删兼容代码或重新引入旧品牌名。
- 浏览器验证使用新上下文与合成书籍，覆盖伴读卡片、状态栏及 EPUB/PDF 阅读启动；不把浏览器通过外推为文石硬件验收。
- 本次不修改 npm/Cargo 依赖、不修改设备数据、不部署 relay、不重打 APK、不推送 GitHub。已安装的 1.3.0 APK 仍对应此前的部署源码，命名统一变更尚未包含在设备包中。

本机原始快照、改名前补丁、测试日志和重命名映射保存在 `.cache/companion-rename/`，用于恢复本次增量，不覆盖此前未提交的 1.3.0 构建、名称及部署记录修改。
