"""Generate the synthetic EPUB/TXT corpus required by e2e-ui-v02.mjs; no network or user books."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED, ZIP_STORED
root=Path(__file__).resolve().parents[2]/'.cache/ui-v02-20261017-01/fixtures'
root.mkdir(parents=True,exist_ok=True)
for n in range(1,15):
    (root/f'UI-Library-{n:02}.txt').write_text(f'第一章 合成测试 {n}\n\n'+('这是用于界面回归的合成文本，不含私人书籍。\n\n'*80),encoding='utf-8')
book=root/'UI-Source.epub'
paragraphs=''.join(f'<p id="p{n}">这是用于界面回归的第{n}个合成段落。阅读器应保留这段文字的位置，排版设置不得丢失原文，临时查看不能覆盖阅读进度。'+('黑白界面需要稳定的文字和可恢复的操作。'*8)+'</p>' for n in range(1,61))
files={
'META-INF/container.xml':'<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
'EPUB/package.opf':'<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:pagewise-ui-v02-synthetic</dc:identifier><dc:title>UI-Source</dc:title><dc:creator>合成测试作者</dc:creator><dc:language>zh</dc:language><dc:subject>系统思考</dc:subject><meta property="dcterms:modified">2026-10-17T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
'EPUB/nav.xhtml':'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">第一章 合成原文</a></li></ol></nav></body></html>',
'EPUB/chapter.xhtml':'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh"><head><title>第一章 合成原文</title><style>p { text-indent: 0; } .publisher { text-align:right; } li,blockquote { text-indent:0; }</style></head><body><h1>第一章 合成原文</h1><p class="publisher">出版体例样本</p><p><a epub:type="noteref" href="#note1">查看合成脚注</a></p>'+paragraphs+'<ul><li>列表语义样本</li></ul><blockquote>引用语义样本</blockquote><aside epub:type="footnote" id="note1"><p>本注释仅用于验证原文跳转与返回，不包含真实用户材料。</p></aside></body></html>',
}
with ZipFile(book,'w') as z:
    z.writestr('mimetype','application/epub+zip',compress_type=ZIP_STORED)
    for name,text in files.items():z.writestr(name,text.encode('utf-8'),compress_type=ZIP_DEFLATED)
print({'generatedFiles':15,'syntheticOnly':True,'directory':str(root)})
