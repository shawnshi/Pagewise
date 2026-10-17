#requires -Version 7.0
[CmdletBinding()]
param([string]$OutputDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) 'artifacts/fixtures'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Synthetic, DRM-free, network-free books only; no personal files are read.
$cases = @(
    @{ File='zh.epub'; Title='知页中文合成样书'; Languages=@('zh-CN'); Expected='zh'; Paragraph='这是用于墨水屏阅读验证的合成文本。请检查中文标点、段落缩进、字体、行距与分页。调整字号后，阅读位置应仍然对应同一段内容。' },
    @{ File='en.epub'; Title='Pagewise English Fixture'; Languages=@('en'); Expected='en'; Paragraph='This is synthetic reading material for testing font metrics, paragraph layout and pagination. After changing typography, the reader should return to the same content rather than a stale page number.' },
    @{ File='und.epub'; Title='知页语言未知合成样书'; Languages=@('und'); Expected='unknown'; Paragraph='Language is explicitly undetermined. 语言未知时不应擅自套用中文或英文预设。' },
    @{ File='mixed.epub'; Title='知页混合语言声明合成样书'; Languages=@('zh-CN','en'); Expected='unknown'; Paragraph='Two languages are declared in metadata. 多语言声明不应在没有单书设置时强行归类。' }
)
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
foreach ($case in $cases) { if (Test-Path -LiteralPath (Join-Path $OutputDirectory $case.File)) { throw "Fixture exists; refusing overwrite: $($case.File)" } }
if (Test-Path -LiteralPath (Join-Path $OutputDirectory 'manifest.json')) { throw 'Fixture manifest exists; refusing overwrite.' }
function Write-ZipText($Archive, [string]$Name, [string]$Text, [bool]$Uncompressed = $false) {
    $level = if ($Uncompressed) { [IO.Compression.CompressionLevel]::NoCompression } else { [IO.Compression.CompressionLevel]::Optimal }
    $entry = $Archive.CreateEntry($Name,$level)
    $entry.LastWriteTime = [DateTimeOffset]::new(2026,1,1,0,0,0,[TimeSpan]::Zero)
    $writer = [IO.StreamWriter]::new($entry.Open(),[Text.UTF8Encoding]::new($false))
    try { $writer.Write($Text) } finally { $writer.Dispose() }
}
$results = @()
foreach ($case in $cases) {
    $path = Join-Path $OutputDirectory $case.File
    $stream = [IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
    try {
        $zip = [IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create,$true)
        try {
            Write-ZipText $zip 'mimetype' 'application/epub+zip' $true
            Write-ZipText $zip 'META-INF/container.xml' '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
            $title = [Security.SecurityElement]::Escape($case.Title)
            $language = ($case.Languages | ForEach-Object { '<dc:language>' + $_ + '</dc:language>' }) -join ''
            $opf = '<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:pagewise:fixture:' + $case.File + '</dc:identifier><dc:title>' + $title + '</dc:title>' + $language + '<dc:creator>Pagewise synthetic fixtures</dc:creator><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>'
            Write-ZipText $zip 'OEBPS/package.opf' $opf
            Write-ZipText $zip 'OEBPS/nav.xhtml' '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="chapter1.xhtml">Chapter 1</a></li><li><a href="chapter2.xhtml">Chapter 2</a></li></ol></nav></body></html>'
            foreach ($chapter in 1..2) {
                $paragraphs = (1..60 | ForEach-Object { '<p id="p' + $_ + '">' + $chapter + '.' + $_ + ' ' + [Security.SecurityElement]::Escape($case.Paragraph) + '</p>' }) -join ''
                $html = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>' + $title + '</title></head><body><h1>Chapter ' + $chapter + '</h1>' + $paragraphs + '</body></html>'
                Write-ZipText $zip ("OEBPS/chapter$chapter.xhtml") $html
            }
        } finally { $zip.Dispose() }
    } finally { $stream.Dispose() }
    $results += [ordered]@{ file=$case.File; sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant(); languages=$case.Languages; expectedLanguageProfile=$case.Expected; synthetic=$true }
}
$manifest = [ordered]@{ schemaVersion=1; warning='Synthetic fixtures only, not proof of real-book compatibility or device acceptance.'; books=$results }
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'manifest.json'),($manifest | ConvertTo-Json -Depth 6) + "`n",[Text.UTF8Encoding]::new($false))
$manifest | ConvertTo-Json -Depth 6
