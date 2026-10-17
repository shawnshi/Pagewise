# zh-lexicon.txt：仿生阅读的中文词表

仿生阅读给相邻的中文词换着颜色，需要先知道词和词的边界在哪里。`zh-lexicon.txt` 就是用来切词的词表：约 6.6 万个常用词，按常用程度排序，只有词，没有词频。

- **怎么用**：第一次在中文书里打开仿生阅读时才加载（`src/services/readingModes/zhLexicon.ts`），切分算法在 `zhSegment.ts`。加载完之前，先用浏览器自带的分词加上 `zhMergeWords.ts` 里约 2,600 个三四字词凑合着用。
- **怎么来的**：`node scripts/build-zh-lexicon.mjs` 生成，不要手改。脚本会把 jieba 词典和 DeepSeek-R1 分词器下载到仓库外的缓存目录（默认 `~/.cache/lightread/zh-lexicon`），校验 SHA-256 后再生成，结果可以逐字节复现（`npm run test:zh-segment` 会检查）。
- **选词**：jieba 词典里同时也是 DeepSeek-R1 词元的多字词优先（当作“现代常用”的信号），再按 jieba 词频补足到 6 万个多字词，加上常用四字成语和 3,000 个常用单字。依据和评测见 `docs/research/zh-segmentation-for-word-guide.md`。
- **格式**：`#` 开头是注释；词按常用程度分成 24 档，档与档之间是一行 `-`；档内按字典序排，每行开头一位数字表示与上一行相同的前缀长度。解析见 `zhSegment.ts` 的 `parseZhLexicon`。

## 来源与许可

词表是从下面两个 MIT 许可的数据里挑选、整理出来的。按 MIT 许可的要求，附上原版权声明与许可全文。

### jieba 词典（`jieba/dict.txt`，v0.42.1）

https://github.com/fxsjy/jieba

```
The MIT License (MIT)

Copyright (c) 2013 Sun Junyi

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### DeepSeek-R1 分词器词表（`tokenizer.json`，提交 `56d4cbbb4d29`）

https://huggingface.co/deepseek-ai/DeepSeek-R1 （只用了词表里的纯汉字词元，作为挑词的参考，没有分发分词器本身）

```
MIT License

Copyright (c) 2023 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
