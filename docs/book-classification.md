# 书籍分类

分类在书籍详情页手工编辑，或由用户确认数据范围后调用已配置的 AI；导入、扫描和打开详情不会自动分类。AI 只使用书目元数据和已有分类，不读取正文、目录、笔记或历史标签。简介材料不足、服务失败、取消或无效响应均不保存。

## 标签与属性

- 固定 16 类中选 1 类，核心主题 2–3 个，可选 1 个特色标签；完整分类合计 3–5 个。删除后允许保持不完整。
- AI 只补缺少的类别、主题；所有已有手工/AI 标签及锁保持不变。完整分类不可重新生成。
- 受众、教材、古籍、原作国别和创作年代独立于标签数量。未知不写入；布尔属性的未知和否不同。
- 首次结构化时原旧标签保留为折叠历史，不猜测旧标签角色。`BookMeta.tags` 此后只由结构化分类单向投影。
- 编辑按钮、键盘、右键和指针长按均可打开标签菜单。锁定标签删除需要明确确认，类别可显式解锁。
- 全库合并/删除按主题、特色或历史角色分别执行，先展示影响范围。类别不可通过自由标签管理器修改；自由标签批量添加仅接受全为未分类书籍的选择。

## 一致性和恢复

`saveBookClassification` 使用原书目快照保存；修订号、元数据或首次结构化前的旧标签已变化时拒绝提交，不自动重试。

`LibraryStorage.updateBookClassifications(updates, legacyUpdates = [])` 将两类更新放在同一个 SQLite JSON1 单语句或 Dexie 读写事务内。`legacyUpdates` 为 `{id, expectedTags, tags}`；旧书必须仍未结构化且旧标签匹配。集合内和跨集合的重复 ID、缺失书目或任一冲突导致整批零写入。旧书合并后保持 plain tags，不生成空结构化分类。

SQLite 仅增加可空分类列；Dexie 使用附加数据字段。OKF 和兼容清单保存版本、修订、锁、独立属性和历史标签；含分类的兼容清单为 v3，旧 v2 仍可导入，重复书籍保持跳过策略。不会修改书籍源文件。

恢复点为本任务冻结 baseline；数据库验证使用可销毁的临时库，覆盖迁移、重开和语句/事务失败回滚。没有连接真实书库、设备或服务。

## 定向验证

在 `reader/` 运行：

```sh
node --experimental-strip-types --test --test-concurrency=1 scripts/test-book-classification.mjs scripts/test-book-tagging.mjs scripts/test-book-tag-storage.mjs scripts/test-book-tag-archive.mjs scripts/test-book-tag-filters.mjs scripts/test-book-tag-ui.mjs
node --experimental-strip-types --test scripts/test-book-tags-e2e.mjs
```

测试复用真实存储、归档和页面代码，使用浏览器 IndexedDB、主机临时 SQLite 及本地合成 SSE；不代表物理 Android 或真实模型服务验收。集成命令、退出码和日志见本任务 `.cache/book-tags/tests.json` 与 `results.md`。
