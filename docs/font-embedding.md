# 内置阅读字体与首版默认

日期：2026-10-18。本文记录软件侧方案；按本轮授权不构建 APK、不做 Note X3 Pro 实机校准。

## 默认与可选组合

| 位置／选项 | 字体与实际字重 |
|---|---|
| 中文默认正文 | 思源宋体 SC 完整可变字体，400；段内拉丁字母优先 Literata 400 |
| 中文偏淡对照 | 思源宋体 500；拉丁字母仍用 400，避免同时改变两种文字的浓淡 |
| 文学式标题 | 思源宋体／Literata 600 |
| 知识类组合 | 宋体正文＋思源黑体标题：主标题 700，次级标题 500 |
| 英文正文 | Literata 400，独立 Italic 文件；700／Bold Italic 使用真实可变字重 |
| 界面 | 思源黑体完整可变字体，常规 400／选中 500；既有其他字重由真实变体轴提供 |
| 可选中文风格 | 霞鹜文楷屏幕版原生 Regular；不合成粗体，强调回退到真实宋体粗字重 |
| 英文备选 | Source Serif 4 Text，保留默认 `opsz=20`，关闭自动光学尺寸以免大字号切到 Display |

首版默认保留 400。500 和文楷是对照选项，不代表已在墨水屏上获得更好的长读结论。

## 版本、格式与来源

资源在 `reader/public/fonts/`；原始地址、文件 SHA-256、许可证 SHA-256、字体内部版本、字重／光学尺寸轴和缺字样例均见 `manifest.json`。

- Source Han Serif SC VF 2.003；Source Han Sans SC VF 2.005。
- Literata 3.103，正体与斜体两个可变文件。
- LXGW WenKai Screen 1.522，静态 Regular。
- Source Serif 4 4.005，正体与斜体两个可变文件。

7 个 WOFF2 合计 47,129,812 字节（约 44.95 MiB），不使用在线字体服务。思源字体直接保留上游完整 WOFF2，其余仅转换容器，不裁剪字形，不更改内部字体名称。5 份上游 OFL 许可证随资源分发。`.gitattributes` 禁止 Git 转换字体与许可证行尾，以保持收据与分发字节一致；上游许可证原有尾空格原样保留，清单与 CSS 使用 LF。

官方原件：

- https://github.com/adobe-fonts/source-han-serif
- https://github.com/adobe-fonts/source-han-sans
- https://github.com/googlefonts/literata
- https://github.com/lxgw/LxgwWenKai-Screen
- https://github.com/adobe-fonts/source-serif

## 混排、地区字形与保护边界

- 拉丁别名通过 `unicode-range` 明确分配，避免思源自带拉丁字形截获 Literata；中文引号、破折号、省略号保留在中文字体。
- 完整思源字体包含 ZHS／ZHT／ZHH 的 `locl` 替换。使用原书语言标记选择地区字形；浏览器对相同文字的 `zh-CN`、`zh-TW`、`zh-HK` 样张产生不同渲染。未标明地区时采用产品的 SC 默认，不伪造原书地区元数据。
- 文楷作为 SC 风格选项，不保证台湾／香港专属字形。
- 真实斜体、粗体、粗斜体保留；代码、MathML／常见数学类、ruby、音标及显式保护字形运行不参与普通正文 span 的字体归一化。特殊设计无法可靠识别时应使用原书模式。
- 固定版式与竖排继续由原书布局处理。本轮不改写 EPUB 正文、原书文件或真实书库。
- 缺字顺序为正文主字体、内置文楷补充、系统扩展字库。完整思源编码约 4.4 万码位，仍不是全部 Unicode；例如 `𠀀` 不在内置字体覆盖内。Windows 样例使用 SimSun-ExtB 回退，不能据此保证 Android 也有相同覆盖。未逐本扫描约 4000 本 EPUB。

## 验证与复现

```sh
cd reader
npm run build
node --test scripts/test-bundled-fonts.mjs
node --experimental-strip-types --test scripts/test-pdf-open-lifecycle.mjs
npm run test:typography-auto
```

字体专项检查生产资源与 SHA-256、8 种字体设置、4 个界面宽度、3 种地区字形、真实平台字体命中、Italic／Bold Italic、400／500 墨色变化及拉丁 400 保持、原书恢复、受保护运行、HTTP 404、错误返回 HTML 和坏字体数据。手机主工具栏标签至少 13px、章节按钮标签至少 12px，行高留足字形空间；检查裁切、对比度和 48px 触控区域。

字体打包工具 `reader/scripts/prepare-bundled-fonts.py` 只读取任务缓存，不自动联网。工具依赖 `fonttools==4.63.0`、`brotli==1.2.0`；输入及许可证哈希漂移会拒绝打包，已匹配资源只校验不重复转封装。应用正常构建不依赖 Python 或这些开发工具。

当前完整整合测试回执、浏览器样张与已修复问题见 `docs/mainline-integration-20261018.md` 及本地 `artifacts/mainline-integration-20261018/`。实机阶段另测正常刷新／文字增强、400 对 500、宋体对文楷、Literata 对 Source Serif 4，并保持其它参数不变后连续阅读。
