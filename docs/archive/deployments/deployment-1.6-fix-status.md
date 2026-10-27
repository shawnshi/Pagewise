# 1.6.0 未通过项修复：当前状态

**状态：BLOCKED_NO_REDEPLOY。应用冻结已修复并验证；阅读器返回补丁仍为未部署草案。设备继续保留原有 1.6.0 两版，不声称已重新部署。**

用户授权修复此前未通过项并重新部署；本轮没有卸载、清数据、读取私人书籍或修改全局冻结策略。

## PW16-DEVICE-01：应用级冻结已解除

此前 `pm enable` 只改变包的临时启用状态，没有清除文石启动器中的冻结标记。实机长按这两个应用图标时，菜单仍显示“解冻”。

分别通过 **文石启动器→目标应用图标→解冻** 处理。操作后两个包均为 `enabled=0`（默认启用），且数据 inode 仍为 release `52086`、debug `52263`。

已验证：release→debug→桌面→release→debug→桌面，共6步，再等待12秒，两包均未回到 `enabled=3`；收尾复查仍为默认启用。验证过程中没有调用 `pm enable`，没有操作其他应用或全局冻结开关。

证据：`.cache/deployment-1.6-fix/official-unfreeze.json`、`official-release-unfreeze.json`、`unfreeze-switch-before-redeploy.json`、`acceptance.json`。

## PW16-BACK-01：补丁草案及已验证部分

确认普通工具栏返回与系统返回共用 `readerBack()`：工具栏可见时会优先隐藏工具栏；离开路由时还存在再次拦截可见工具栏的保护。

最小草案仅作以下变更：

- 区分 `toolbar`／`system` 返回来源；系统 Back 仍保留编辑器、选区、检视、面板及工具栏的关闭优先级。
- 工具栏按钮走已有 pending／owner 单飞入口，保留失败提示和旧宿主隔离。
- 仍先等待 `readerSession.flush()`；成功确认且 owner 有效后隐藏工具栏，再导航，避免路由守卫重复消费同一次导航。
- 没有删除笔记保护或路由守卫，没有改数据库、CFI 格式、计时或依赖。

草案涉及：

```text
reader/src/views/ReaderView.vue
reader/scripts/test-native-reader-back.mjs
reader/scripts/test-reader-back-regression.mjs
```

相对本轮冻结基线的 Diff：`review-input.diff`，SHA-256 `bda8be51462b5abe7283e0901cb9c8acdf5f346908bf14cc9e4a9bbbedc60997`。原有修改保留，454文件输入哈希收尾未漂移。

### 已通过

- 单元合同16/16：来源分流、rapid Back单飞、失败提示、owner清理、PDF笔记确认及reader session等。
- 独立的真实生产 Vue 浏览器定向用例5项：连续3轮可见工具栏返回并确认 Reader DOM移除；系统 Back只隐藏工具栏；pending保存的3次实际按钮点击只有1次保存调用，执行原始 storage.saveProgress 并确认后才离开；保存失败保持Reader和工具栏。
- 生产应用 TypeScript 检查、前端构建退出0。

证据为 `back-unit-green.log`、`toolbar-browser-valid.log`、`toolbar-browser-results.json`、`app-typecheck.json`、`web-build.json`。浏览器实际调用保存方法履约，不等于已独立读回持久化内容对账。日志有 ResizeObserver 通知循环错误，不报告完全无运行时异常。

## 为什么没有重新部署

原有浏览器回归仍有一条关键路径未解除：

**保存失败→重试得到 Promise 确认→URL匹配 `/library`→原生 Back owner 应删除。**

- 生产代码修改前，该断言已失败；改为等待后仍失败。
- 草案应用后，同一 owner 删除等待仍超时。只看到 URL变化，不能证明 Vue 路由提交及 Reader卸载成功。
- 原夹具重试时只 resolve 保存替身 Promise，而新定向用例执行真实原始保存方法。此差异不足以自行认定旧夹具有错，也不能据此删除失败断言。
- 同一 observable 已有3次执行，已停止该分支，保留 `back-browser-red.log`、`back-browser-red-target.log`、`back-green.log`，没有换工具重放。

独立 reviewer `ab90f9ce-8904-41c4-8333-a52ffd8c1390` 及补充复核 `ef3ee6d2-2724-4a68-8f7c-b05bc76c72ed` 未发现固定Diff新增的保存屏障缺陷，但均给出 **BLOCKED**：无法证明旧恢复失败与补丁无关，不能批准部署。审查仅只读，没有重跑测试或设备操作。报告已复制为 `independent-review.md`、`independent-review-supplement.md`。

另一个旧单元宿主缺少硬件桥依赖的问题已补齐测试夹具，16项单元通过；其中动态编译可信本地生产函数的 `new Function` 是测试原有实现模式，工具仍提示安全规则，不能描述为全部静态诊断无告警。

## 下一步与恢复点

需要先补足失败恢复路径的：

1. 保存调用及结算回执；
2. 路由提交或失败回执；
3. 守卫阶段、owner身份及卸载异常。

在该关键验证解除前，不生成新的已验收 APK，不把草案重新部署到设备；也不以删除断言、延长等待、重启或清数据替代修复。

恢复点为 `.cache/deployment-1.6-fix/before/`、`preflight.json` 和原 `artifacts/Pagewise-1.6.0-{release,debug}.apk`。只可在核对当前哈希后逆向本轮差异，不使用 HEAD／reset 覆盖用户已有修改。当前 Reader补丁保留为草案，未回退已验证的应用级解冻设置。
