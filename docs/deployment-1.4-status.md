# 知页 1.4.0 双版本部署记录

状态：DONE（本次打包、覆盖安装及启动验收）。核验时间：2026-10-20T23:34:18+08:00。

设备：Note X3 Pro，Android API 32。两版 versionName 均为 `1.4.0`，versionCode 均为 `1004000`。

## 安装结果

| 变体 | 显示名称 | 包名 | 安装包 |
|---|---|---|---|
| release | 知页 | `io.pagewise.reader` | `artifacts/Pagewise-1.4.0-release.apk` |
| debug | 知页 1.4.0 测试版 | `io.pagewise.reader.debug` | `artifacts/Pagewise-1.4.0-debug.apk` |

两版沿用既有签名，各自的 UID、首次安装时间、私有数据目录及 inode 标识与升级前一致；未卸载、未清数据，未修改源书籍。正式版关闭 debuggable，测试版开启，私有数据仍相互隔离。

## 内容及验证

- 打包当前主工作区，包含此前未部署的伴读命名、书库筛选位置和 AI 服务/模型选择变更；未打包 `.worktrees/folder-repair` 的隔离诊断代码。
- 前端构建及 Vue/TypeScript 检查通过；Debug/Release 原生库分别构建、封存并与 APK 内库摘要核对；主工作区两版 Kotlin 编译、Release R8、两版 assemble 均通过。
- npm/Cargo 依赖图未改变，仅更新应用根版本；APK ZIP CRC、包名、所有输出语言的显示名称、版本、ABI、debuggable 与签名通过校验。
- 安装后设备 APK SHA-256 与交付包一致；先通过 Debug 的原生/前端 ready 信号，再安装 Release；两版均验证前端 ready，最后以探针关闭状态正常重启。
- 前端文本资产定向凭证模式扫描无命中；这不是完整安全审计。原签名容器元数据未改变。

### 本次实际回归测试

- `variants`：11 项通过，0 失败；见 `.cache/deployment-1.4/regression-variants.log`。
- `ai`：27 项通过，0 失败；见 `.cache/deployment-1.4/regression-ai.log`。
- `companion`：81 项通过，0 失败；见 `.cache/deployment-1.4/regression-companion.log`。
- `library-categories-sort`：19 项通过，0 失败；见 `.cache/deployment-1.4/regression-library-categories-sort.log`。

合计 138 项；各命令退出码均为 0。

## 验收限制

- 书籍无法打开、文件夹扫描出错的根因仍未确认，本次未声明修复。
- 未验收实体 EPD/前光/手写、完整原生快车道、长期后台/合盖恢复或真实 AI 鉴权与付费调用。启动成功不代表这些功能通过。

## 构建中纠正的事项

- 首次直接准备 Android 主工程时未单独运行变体准备，临时 Debug APK 仍标记 1.3.0；元数据闸门拒绝交付，未安装。随后执行 `prepare-android-variants.mjs`，限定核对生成元数据差异、重新封存构建输入和原生库，再构建验证 1.4.0。
- 排序回归首次命令使用了不存在的脚本文件名，未实际执行测试；改为 `test-library-categories-sort.mjs` 后 19 项通过。首次调用错误日志保留，不计作已执行的产品测试。
- 前轮隔离诊断 Kotlin 超时目标未被重试；本次使用已确认与成功 1.3.0 原生基线一致的主工作区及缓存，两版 Kotlin 均实际通过。

## 摘要与恢复点

- release SHA-256：`3209ec4e125558a50c39850e16c353fc6fcd0352c966e158f6f94fef42805d2a`。
- debug SHA-256：`7190800c90905e2226a90740ee190f253f71cfa23b132ccfc0bf574b268b95a9`。
- 两版证书 SHA-256：`9b0f56619d62232588818c64083536bcbb3ae9182593b3610f67ef3c13f472a3`。
- 原安装包、原生库、版本文件备份、Git 原有差异及全部构建/安装回执位于 `.cache/deployment-1.4/`。
- `deployment-acceptance.json`、`scope-validation.json`、`source-inputs.json`、`regression-summary.json` 可回查。原生成 JNI 链接已恢复。
- 旧 Release 不保证可降级；需要回退时用原源码和既有证书制作递增版本码恢复包，并重新验证数据兼容性，不以卸载清数据回退。
- 未提交或推送 GitHub。
