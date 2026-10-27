# 知页 1.6.0：打包、签名、实机安装与测试

## 当前结论

**两版 APK 已打包、签名并安装；版本／名称／签名／安装字节核对通过。实机测试有未闭合项，整体为 BLOCKED_RUNTIME_VALIDATION，不报告全量验收通过。**

目标：ONYX NoteX3Pro，Android 12 / API 32，arm64-v8a。安装前两包均未安装，因此是新安装，不是有数据的覆盖升级。没有卸载、清数据、读取私人书籍或修改全局字体／冻结设置。

## APK

| 构建 | 显示名称 | applicationId | debuggable |
|---|---|---|---|
| release | 知页 | `io.pagewise.reader` | false |
| debug | 知页 1.6.0 测试版 | `io.pagewise.reader.debug` | true |

版本均为 `1.6.0` / `1006000`。两个 UID／数据目录独立，可并存；87 个语言资源的名称分别核对通过。两份已安装 base.apk 均拉回校验，与对应交付 APK 字节相同。

```text
artifacts/Pagewise-1.6.0-release.apk
SHA-256: 5762efed1b42811cc44635fe83b8f35902dcff17161bf1f3f27f38d420aa6212

artifacts/Pagewise-1.6.0-debug.apk
SHA-256: 2beb7b0e54fa0c9e043bca52ead2bcfbdc7ac0168e493c7877ca936da22fcceb
```

签名沿用既有 **Android Debug 侧载证书**，证书 SHA-256 `9b0f56619d62232588818c64083536bcbb3ae9182593b3610f67ef3c13f472a3`。release 是非调试、经过 R8 的 release 构建，但不是使用商店发行证书签名。未新建或替换密钥，未读取凭据值，签名容器元数据未变化。

## 变更及构建证据

只更改五个版本位置文件：`reader/package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`Cargo.lock`、`tauri.conf.json`。显示名称规则原已符合请求，没有改产品逻辑或依赖图；Tauri 2.11.5 生命周期补丁代码不变。

证据根目录：`.cache/deployment-1.6/`。

- `preflight.json`、`before/`：454 文件及生成配置恢复点；原有未提交修改保留。
- `own-version.diff`：相对本轮冻结基线的五文件差异；npm／Cargo 依赖图校验不变。
- `regression.log`：版本变体、原子准备及 SDK 生命周期定向测试 **35/35**。
- 首次完整 CLI release 构建触及 165 秒上限，已保留 `cli-release.log/.json`，不将其报告为 CLI 成功。日志确认前端及优化 Rust 构建完成；随后检查无活动 Gradle daemon，改用已存在的分阶段方式完成 Kotlin、R8、assemble，跳过重复 Rust 任务。
- `gradle-release-kotlin/r8/assemble.json`、`rust-debug.json`、`gradle-debug-assemble.json`：对应阶段均退出 0。两个 profile 的 ELF 分别冻结，APK 内原生库与各自冻结库 SHA-256 相同，未混包。
- `artifact-*.json`、`signing-*.log`、`badging-*.log`：签名、CRC、ABI、最低 API 24、版本、名称和 debuggable 核对。
- `installed-*.json`、`install-acceptance.json`：安装回执及实际安装包 SHA-256。

## 实机测试

仅创建并导入本轮合成 EPUB《知页 1.6 验证书》，两章，无私人材料。

### 已通过

- 两版冷启动及原生藏书页；初始均为 0 本。
- 通过 Android 系统选择器导入后，各显示 1 本验证书。ADB 推送的文件最初未被 Downloads provider 索引；只对该文件发送媒体扫描广播后出现，没有修改 picker 代码或扫描私人目录。
- 两版书籍详情目录快照均显示“验证第一章／验证第二章”；目录→统计→藏书及 debug 在读／全部笔记入口有对应快照。
- release 正文已实际渲染，截图 `release-synthetic-reader.png`；阅读器目录能跳到第二章。
- debug Rust 运行时 `plugin:app|version` 返回 **1.6.0**；正文有有效 CFI。
- debug 首次 DOM 返回管理页成功；统计出现 1 min／1 本记录，再次打开的 CFI 与此前相同。此项是 DOM 点击验证，不替代物理触控。

### 未通过／未证实

**PW16-BACK-01 — 阅读器退出验证未闭合。**

- release 的多次触控自动化未回到管理页，已停止重复尝试，不以重启掩盖。
- debug 只读观察发现：工具栏隐藏时 Back 的 DOM y 为负值，UIAutomator 仍可能给出旧坐标，因此不能仅凭触控失败断言返回处理器损坏。
- 但 debug 在首次 DOM 返回成功、重新打开后，第二次 DOM 返回也发生 9 秒 `back_timeout`，路由仍为 `/read/...`。证据 `debug-dom-back.json`、`debug-drained-before-cold.json`、`debug-final-ui-state.json`、`debug-back-button-metadata.json`。未修改阅读器代码，未完成二次冷重启续读测试。
- 因此，阅读器返回、读后返回统计及完整导航回归不能记为通过；是否为导航守卫、待决保存或自动化时序问题仍待归因。

**PW16-DEVICE-01 — 应用停用状态复现。**

- 安装后两个包均出现 `enabled=3`、`suspended=false`，Activity 无法解析；仅对这两个包执行 enable 后可启动。
- 切到 debug 后，release 又变为 `enabled=3` 且进程不在。已再次启用两包并将 release 置前；未更改全局冻结策略，也没有操作其他应用。
- 现象符合设备冻结行为，但没有核验具体设置或操作者，不能断言原因已定位。未来后台是否再次被停用仍未解决。

日志只对测试进程扫描已知崩溃／bridge 错误词；未发现匹配不等于完整无异常。未做实体残影／手写延迟、TalkBack、复杂书库、私人数据、未知写入故障注入或全量发布验收。此前 S4 的剩余问题不因 1.6.0 安装而关闭。

## 收尾与恢复

- 保留两版应用，各一份合成验证书，以及 `/sdcard/Download/Pagewise16Verification/Pagewise-1.6.0-Verification.epub`，便于人工复核。
- 自有 debug CDP forward `tcp:19236` 已移除；JNI 暂存文件恢复为暂存前链接。没有关闭共享 ADB，没有重置设备设置。
- 签名容器及冻结源码未漂移。未提交、推送或发布。
- 如撤回源码版本修改，应只逆向 `own-version.diff` 并保护原有修改；未执行 APK 降级、卸载或数据回退。没有声称可无损自动降级。

后续最小工作是只读归因 `PW16-BACK-01`，明确是否需要已授权范围外的阅读器补丁；设备停用问题应从这两个应用的冻结设置核验，不以关闭全局策略替代。
