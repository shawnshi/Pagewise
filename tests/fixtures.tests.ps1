#requires -Version 7.0
# Verify only this task's synthetic fixtures, never user-provided books.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$directory = Join-Path (Split-Path $PSScriptRoot -Parent) 'artifacts/fixtures'
$manifest = Get-Content -LiteralPath (Join-Path $directory 'manifest.json') -Raw | ConvertFrom-Json
$expected = [ordered]@{ 'zh.epub'=@('zh-CN'); 'en.epub'=@('en'); 'und.epub'=@('und'); 'mixed.epub'=@('zh-CN','en') }
if ($manifest.books.Count -ne 4) { throw 'Expected exactly four synthetic books.' }
function Read-ZipText($Zip, [string]$Name) {
    $entry = $Zip.GetEntry($Name)
    if ($null -eq $entry) { throw "Missing ZIP entry: $Name" }
    $reader = [IO.StreamReader]::new($entry.Open(),[Text.UTF8Encoding]::new($false),$false)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}
foreach ($book in $manifest.books) {
    if (-not $expected.Contains($book.file) -or -not $book.synthetic) { throw 'Fixture identity mismatch.' }
    $path = Join-Path $directory $book.file
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $book.sha256) { throw "Fixture hash mismatch: $($book.file)" }
    $zip = [IO.Compression.ZipFile]::OpenRead($path)
    try {
        if ($zip.Entries.Count -ne 6 -or $zip.Entries[0].FullName -ne 'mimetype') { throw 'EPUB container ordering/entry count invalid.' }
        if ($zip.Entries[0].Length -ne $zip.Entries[0].CompressedLength) { throw 'EPUB mimetype must not be compressed.' }
        if ((Read-ZipText $zip 'mimetype') -cne 'application/epub+zip') { throw 'EPUB mimetype bytes/BOM invalid.' }
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName -match '\.\.|^[/\\]|:') { throw 'Unexpected nonlocal ZIP entry.' }
            if ($entry.FullName -eq 'mimetype') { continue }
            $text = Read-ZipText $zip $entry.FullName
            if ($text -match '(?i)<!DOCTYPE|<script\b') { throw 'Synthetic fixtures must have no DTD or script.' }
            $document = [Xml.XmlDocument]::new(); $document.XmlResolver = $null
            $document.LoadXml($text)
        }
        $opf = [Xml.XmlDocument]::new(); $opf.XmlResolver = $null
        $opf.LoadXml((Read-ZipText $zip 'OEBPS/package.opf'))
        $ns = [Xml.XmlNamespaceManager]::new($opf.NameTable)
        $ns.AddNamespace('dc','http://purl.org/dc/elements/1.1/')
        $ns.AddNamespace('opf','http://www.idpf.org/2007/opf')
        $languages = @($opf.SelectNodes('//dc:language',$ns) | ForEach-Object { $_.InnerText })
        if (($languages -join ',') -cne ($expected[$book.file] -join ',')) { throw 'Actual EPUB language metadata mismatch.' }
        if ($opf.SelectNodes('//opf:spine/opf:itemref',$ns).Count -ne 2) { throw 'Expected two reading-order chapters.' }
        foreach ($chapter in 1..2) {
            $text = Read-ZipText $zip "OEBPS/chapter$chapter.xhtml"
            if ([regex]::Matches($text,'<p id="p\d+">').Count -ne 60) { throw 'Expected 60 anchored paragraphs per chapter.' }
        }
        Write-Output "PASS $($book.file): hash, uncompressed mimetype, XML, language, spine and paragraph anchors"
    } finally { $zip.Dispose() }
}
Write-Output 'RESULT syntheticBooks=4 passed=4; this does not validate rendering or the target device.'
exit 0
