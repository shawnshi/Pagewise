"""
生成仿生阅读用的中文词表 (研究原型, 不入库产物)。见 docs/research/zh-segmentation-for-word-guide.md §4。

输入:
  dict.txt        jieba 词典 (MIT) https://raw.githubusercontent.com/fxsjy/jieba/master/jieba/dict.txt
  tokenizer.json  DeepSeek-V3/R1 分词器 (R1 仓库为 MIT) https://huggingface.co/deepseek-ai/DeepSeek-R1/resolve/main/tokenizer.json
输出 (out_dir):
  zh-lexicon.txt  按词频降序的词, 一行一个 (分词只用名次, 不需要词频数字)
  zh-merge34.txt  给 Intl.Segmenter 做合并的三、四字常用词 (过渡方案)

选词: jieba 词典里同时是 DeepSeek 词元的多字词 (≈1.8 万, 当作「现代常用」信号)
      + 按 jieba 词频补足到 N 个多字词 + 前 3000 个单字 + 前 K 条成语 (jieba 词性 i, 四字)。
运行: python3 -I build-zh-lexicon.py dict.txt tokenizer.json out_dir [N=60000] [K=5000]
"""
import json, re, sys

def bytes_to_unicode():
    bs = list(range(ord('!'), ord('~') + 1)) + list(range(ord('¡'), ord('¬') + 1)) + list(range(ord('®'), ord('ÿ') + 1))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b); cs.append(256 + n); n += 1
    return {chr(c): b for b, c in zip(bs, cs)}

def main():
    dict_path, tok_path, out_dir = sys.argv[1:4]
    n_multi = int(sys.argv[4]) if len(sys.argv) > 4 else 60000
    n_idiom = int(sys.argv[5]) if len(sys.argv) > 5 else 5000
    han = re.compile(r'^[一-鿿]+$')
    words, idioms = [], []
    for line in open(dict_path, encoding='utf-8'):
        p = line.split()
        if len(p) >= 2 and han.match(p[0]):
            words.append((p[0], int(p[1])))
            if len(p) >= 3 and p[2] == 'i' and len(p[0]) == 4:
                idioms.append((p[0], int(p[1])))
    words.sort(key=lambda x: -x[1]); idioms.sort(key=lambda x: -x[1])
    u2b = bytes_to_unicode()
    ds = set()
    for tok in json.load(open(tok_path, encoding='utf-8'))['model']['vocab']:
        try:
            s = bytes(u2b[c] for c in tok).decode('utf-8')
        except (KeyError, UnicodeDecodeError):
            continue  # 半个汉字的字节片段
        if len(s) >= 2 and han.match(s):
            ds.add(s)
    multi = [w for w in words if len(w[0]) >= 2]
    sel = [w for w in multi if w[0] in ds]
    have = {w for w, _ in sel}
    for w in multi:
        if len(sel) >= n_multi:
            break
        if w[0] not in have:
            sel.append(w); have.add(w[0])
    sel += [w for w in idioms[:n_idiom] if w[0] not in have]
    sel += [w for w in words if len(w[0]) == 1][:3000]
    sel.sort(key=lambda x: -x[1])
    open(f'{out_dir}/zh-lexicon.txt', 'w', encoding='utf-8').write('\n'.join(w for w, _ in sel) + '\n')
    merge = [w for w, _ in words if len(w) in (3, 4) and w in ds]
    open(f'{out_dir}/zh-merge34.txt', 'w', encoding='utf-8').write('\n'.join(merge) + '\n')
    print(f'lexicon {len(sel)} words, merge34 {len(merge)} words')

if __name__ == '__main__':
    main()
