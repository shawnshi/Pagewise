package io.pagewise.reader

import org.commonmark.internal.util.Html5Entities
import org.commonmark.node.Code
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Heading
import org.commonmark.node.HtmlBlock
import org.commonmark.node.HtmlInline
import org.commonmark.node.Image
import org.commonmark.node.Node
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.Text
import org.commonmark.parser.Parser
import org.xmlpull.v1.XmlPullParser
import org.xmlpull.v1.XmlPullParserFactory
import java.io.ByteArrayInputStream
import java.io.File
import java.io.RandomAccessFile
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction
import java.util.zip.ZipFile

internal class NativeImportFailure(
    val code: String,
) : java.io.IOException(code)

internal data class NativeBibliography(
    val title: String,
    val author: String = "",
    val tags: List<String> = emptyList(),
    val description: String? = null,
    val language: String? = null,
    val publisher: String? = null,
    val publicationDate: String? = null,
    val cover: ByteArray? = null,
)

/** Bounded bibliography parsing only; never expands the whole EPUB or decompresses MOBI body records. */
internal object NativeBookMetadata {
    private const val DC = "http://purl.org/dc/elements/1.1/"
    private const val OPF = "http://www.idpf.org/2007/opf"
    private const val XML = "http://www.w3.org/XML/1998/namespace"
    private const val MAX_XML = 2 * 1024 * 1024
    private const val MAX_COVER = 12 * 1024 * 1024
    private const val MAX_TEXT = 64 * 1024
    private val extensions = mapOf("epub" to "epub", "mobi" to "mobi", "pdf" to "pdf", "txt" to "txt", "md" to "md", "markdown" to "md")

    fun format(name: String): String =
        extensions[name.substringAfterLast('.', "").lowercase()]
            ?: throw NativeImportFailure("unsupported_format")

    fun parse(
        file: File,
        name: String,
        cover: Boolean = true,
        checkpoint: () -> Unit = {},
    ): NativeBibliography {
        checkpoint()
        val format = format(name)
        if (!file.isFile || (file.length() == 0L && format !in setOf("txt", "md"))) throw NativeImportFailure("invalid_book")
        if (file.length() > 1024L * 1024 * 1024) throw NativeImportFailure("resource_limit")
        val fallback = name.substringBeforeLast('.', name)
        return when (format) {
            "epub" -> epub(file, fallback, cover, checkpoint)
            "mobi" -> mobi(file, fallback, cover, checkpoint)
            "txt" -> NativeBibliography(fallback)
            "md" -> NativeBibliography(markdownTitle(file, fallback, checkpoint))
            else -> throw NativeImportFailure("unsupported_format")
        }
    }

    private data class Element(
        val name: String,
        val ns: String,
        val attrs: Map<String, String>,
        val text: StringBuilder = StringBuilder(),
        val children: MutableList<Element> = arrayListOf(),
    ) {
        fun attr(
            name: String,
            ns: String = "",
        ) = attrs["{$ns}$name"] ?: ""

        fun all(): List<Element> = listOf(this) + children.flatMap { it.all() }

        fun value() = text.toString().trim().also { if (it.length > MAX_TEXT) throw NativeImportFailure("resource_limit") }
    }

    private fun xml(
        bytes: ByteArray,
        checkpoint: () -> Unit,
    ): Element {
        val parser = XmlPullParserFactory.newInstance().apply { isNamespaceAware = true }.newPullParser()
        // KXml (including Android's parser) is non-validating and may not expose a writable DOCDECL feature.
        // Reject a parser that enables it, and reject the DOCDECL token before any entity use.
        if (parser.getFeature(XmlPullParser.FEATURE_PROCESS_DOCDECL)) throw NativeImportFailure("unsafe_xml")
        parser.setInput(ByteArrayInputStream(bytes), null)
        val stack = ArrayList<Element>()
        var root: Element? = null
        var nodes = 0
        var textBytes = 0
        while (true) {
            checkpoint()
            when (parser.nextToken()) {
                XmlPullParser.DOCDECL -> {
                    throw NativeImportFailure("unsafe_xml")
                }

                XmlPullParser.START_TAG -> {
                    if (++nodes > 20000 || stack.size >= 32) throw NativeImportFailure("resource_limit")
                    val attrs =
                        (0 until parser.attributeCount).associate {
                            "{${parser.getAttributeNamespace(it) ?: ""}}${parser.getAttributeName(it)}" to
                                parser.getAttributeValue(it)
                        }
                    val node = Element(parser.name, parser.namespace ?: "", attrs)
                    if (stack.isEmpty()) {
                        if (root != null) throw NativeImportFailure("invalid_book")
                        root = node
                    } else {
                        stack.last().children.add(node)
                    }
                    stack.add(node)
                }

                XmlPullParser.TEXT, XmlPullParser.CDSECT, XmlPullParser.ENTITY_REF, XmlPullParser.IGNORABLE_WHITESPACE -> {
                    val text = parser.text ?: throw NativeImportFailure("unsafe_xml")
                    textBytes += text.length
                    if (textBytes > MAX_XML) throw NativeImportFailure("resource_limit")
                    stack.lastOrNull()?.text?.append(text)
                }

                XmlPullParser.END_TAG -> {
                    if (stack.isEmpty()) throw NativeImportFailure("invalid_book")
                    val node = stack.removeAt(stack.lastIndex)
                    stack.lastOrNull()?.text?.append(node.text)
                }

                XmlPullParser.END_DOCUMENT -> {
                    return root ?: throw NativeImportFailure("invalid_book")
                }
            }
        }
    }

    private fun readEntry(
        zip: ZipFile,
        name: String,
        limit: Int,
        checkpoint: () -> Unit,
    ): ByteArray {
        val entry = zip.getEntry(name) ?: throw NativeImportFailure("invalid_book")
        if (entry.isDirectory || entry.size > limit) throw NativeImportFailure("resource_limit")
        return zip.getInputStream(entry).use { input ->
            val out = java.io.ByteArrayOutputStream()
            val buffer = ByteArray(65536)
            while (true) {
                checkpoint()
                val count = input.read(buffer)
                if (count < 0) break
                if (out.size() + count > limit) throw NativeImportFailure("resource_limit")
                out.write(buffer, 0, count)
            }
            out.toByteArray()
        }
    }

    private fun resolve(
        base: String,
        reference: String,
    ): String {
        val uri = URI(base).resolve(reference).normalize()
        val path = uri.path ?: throw NativeImportFailure("invalid_book")
        if (uri.isAbsolute || uri.rawAuthority != null || uri.rawQuery != null || path.startsWith('/') ||
            path.split('/').any { it == ".." || it == "." } ||
            path.any { it == '\\' || it < ' ' }
        ) {
            throw NativeImportFailure("invalid_book")
        }
        return path
    }

    private fun epub(
        file: File,
        fallback: String,
        wantCover: Boolean,
        checkpoint: () -> Unit,
    ): NativeBibliography =
        ZipFile(file).use { zip ->
            val names = mutableSetOf<String>()
            val entries = zip.entries()
            while (entries.hasMoreElements()) {
                checkpoint()
                val name = entries.nextElement().name
                if (!names.add(name) || names.size > 20000) throw NativeImportFailure("invalid_book")
            }
            val container = xml(readEntry(zip, "META-INF/container.xml", 256 * 1024, checkpoint), checkpoint)
            val rootfile =
                container.all().firstOrNull { it.name == "rootfile" && it.attr("media-type") == "application/oebps-package+xml" }
                    ?: container.all().firstOrNull { it.name == "rootfile" } ?: throw NativeImportFailure("invalid_book")
            val opfPath = resolve("", rootfile.attr("full-path"))
            val opf = xml(readEntry(zip, opfPath, MAX_XML, checkpoint), checkpoint)
            if (opf.name != "package" || opf.ns != OPF) throw NativeImportFailure("invalid_book")
            val metadata = opf.children.firstOrNull { it.name == "metadata" && it.ns == OPF } ?: throw NativeImportFailure("invalid_book")
            val dc = metadata.children.filter { it.ns == DC }
            val refinements = metadata.children.filter { it.name == "meta" && it.ns == OPF }

            fun props(
                node: Element,
                property: String,
            ) = refinements.filter {
                it.attr("refines") == "#${node.attr("id")}" &&
                    it.attr("property") == property
            }

            fun value(node: Element?): String {
                if (node == null) return ""
                val values = linkedMapOf<String, String>()
                val baseLang = metadata.attr("lang", XML).ifEmpty { opf.attr("lang", XML).ifEmpty { "und" } }
                values[node.attr("lang", XML).ifEmpty { baseLang }] = node.value()
                if (node.attr("alt-rep", OPF).isNotEmpty()) values[node.attr("alt-rep-lang", OPF)] = node.attr("alt-rep", OPF)
                for (alt in props(node, "alternate-script")) values.putIfAbsent(alt.attr("lang", XML), alt.value())
                return values.values.filter { it.isNotEmpty() }.joinToString(", ")
            }
            val titles = dc.filter { it.name == "title" }
            val title =
                value(
                    titles.firstOrNull {
                        props(it, "title-type").any { p ->
                            p.value() == "main"
                        }
                    } ?: titles.firstOrNull(),
                ).ifEmpty { fallback }
            val authors =
                dc
                    .filter { it.name == "creator" || it.name == "contributor" }
                    .filter { node ->
                        val roles = props(node, "role").map { it.value() }.ifEmpty { listOf(node.attr("role", OPF)) }
                        roles.any {
                            it == "aut" || (it.isEmpty() && node.name == "creator") ||
                                (it !in setOf("art", "clr", "edt", "ill", "nrt", "trl", "pbl") && node.name == "creator")
                        }
                    }.map { value(it) }
                    .filter { it.isNotEmpty() }
            val dates = dc.filter { it.name == "date" }
            var image: ByteArray? = null
            if (wantCover) {
                val items =
                    opf.children
                        .firstOrNull { it.name == "manifest" }
                        ?.children
                        .orEmpty()
                        .filter { it.name == "item" }
                val legacy = refinements.firstOrNull { it.attr("name") == "cover" }?.attr("content")
                val cover =
                    items.firstOrNull { it.attr("properties").split(Regex("\\s+")).contains("cover-image") }
                        ?: items.firstOrNull { it.attr("id") == legacy && !legacy.isNullOrEmpty() }
                if (cover != null) {
                    try {
                        image = readEntry(zip, resolve(opfPath, cover.attr("href")), MAX_COVER, checkpoint)
                    } catch (
                        error: Exception,
                    ) {
                        checkpoint() // Optional cover errors do not discard valid bibliography.
                    }
                }
            }
            NativeBibliography(
                title,
                authors.joinToString(", "),
                dc
                    .filter { it.name == "subject" }
                    .map { value(it) }
                    .filter { it.isNotEmpty() }
                    .distinct(),
                dc.firstOrNull { it.name == "description" }?.value()?.ifEmpty { null },
                dc
                    .filter { it.name == "language" }
                    .map { it.value() }
                    .filter { it.isNotEmpty() }
                    .joinToString(", ")
                    .ifEmpty { null },
                value(dc.firstOrNull { it.name == "publisher" }).ifEmpty { null },
                (dates.firstOrNull { it.attr("event", OPF) == "publication" } ?: dates.firstOrNull())?.value()?.ifEmpty { null },
                image,
            )
        }

    // HTML entity decoding is shared with the pinned CommonMark parser; unlike Html.fromHtml it retains description markup.
    private fun entities(text: String): String =
        Regex("&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]+);").replace(text) { Html5Entities.entityToString(it.value) }

    private fun mobi(
        file: File,
        fallback: String,
        wantCover: Boolean,
        checkpoint: () -> Unit,
    ): NativeBibliography =
        RandomAccessFile(file, "r").use { input ->
            fun bytes(
                start: Long,
                size: Int,
            ): ByteArray {
                checkpoint()
                if (start < 0 || size < 0 || size > MAX_COVER || start > input.length() - size) throw NativeImportFailure("invalid_book")
                input.seek(start)
                return ByteArray(size).also { input.readFully(it) }
            }
            if (input.length() < 78 || bytes(60, 8).toString(Charsets.US_ASCII) != "BOOKMOBI") throw NativeImportFailure("invalid_book")
            input.seek(76)
            val count = input.readUnsignedShort()
            if (count !in 1..20000 || 78L + count * 8 > input.length()) throw NativeImportFailure("invalid_book")
            val offsets = LongArray(count + 1)
            repeat(count) {
                input.seek(78L + it * 8)
                offsets[it] = input.readInt().toLong() and 0xffffffffL
            }
            offsets[count] = input.length()
            if (offsets[0] < 78L + count * 8 ||
                offsets.asList().zipWithNext().any { it.first >= it.second }
            ) {
                throw NativeImportFailure("invalid_book")
            }

            fun record(index: Int) =
                if (index in
                    0 until count
                ) {
                    bytes(offsets[index], (offsets[index + 1] - offsets[index]).toInt())
                } else {
                    throw NativeImportFailure("invalid_book")
                }

            fun uint(
                data: ByteArray,
                offset: Int,
            ): Long {
                if (offset < 0 || offset + 4 > data.size) throw NativeImportFailure("invalid_book")
                return ByteBuffer.wrap(data, offset, 4).int.toLong() and 0xffffffffL
            }

            data class Header(
                val data: ByteArray,
                val fields: Map<Int, List<ByteArray>>,
                val charset: Charset,
            )

            fun header(index: Int): Header {
                val data = record(index)
                if (data.size < 132 ||
                    data.copyOfRange(16, 20).toString(Charsets.US_ASCII) != "MOBI"
                ) {
                    throw NativeImportFailure("invalid_book")
                }
                val compression = ByteBuffer.wrap(data, 0, 2).short.toInt() and 0xffff
                if (compression !in setOf(1, 2, 17480)) throw NativeImportFailure("invalid_book")
                if ((ByteBuffer.wrap(data, 12, 2).short.toInt() and 0xffff) != 0) throw NativeImportFailure("encrypted_book")
                val charset =
                    when (uint(data, 28)) {
                        65001L -> Charsets.UTF_8
                        1252L -> Charset.forName("windows-1252")
                        else -> throw NativeImportFailure("invalid_book")
                    }
                val fields = linkedMapOf<Int, MutableList<ByteArray>>()
                if ((uint(data, 128) and 64L) != 0L) {
                    val start = uint(data, 20).toInt() + 16
                    if (start < 16 || start + 12 > data.size ||
                        data.copyOfRange(start, start + 4).toString(Charsets.US_ASCII) != "EXTH"
                    ) {
                        throw NativeImportFailure("invalid_book")
                    }
                    val length = uint(data, start + 4).toInt()
                    val records = uint(data, start + 8).toInt()
                    if (length < 12 || start + length > data.size || records !in 0..10000) throw NativeImportFailure("invalid_book")
                    var position = start + 12
                    repeat(records) {
                        if (position + 8 > start + length) throw NativeImportFailure("invalid_book")
                        val type = uint(data, position).toInt()
                        val size = uint(data, position + 4).toInt()
                        if (size < 8 || position.toLong() + size > start + length) throw NativeImportFailure("invalid_book")
                        fields.getOrPut(type) { arrayListOf() }.add(data.copyOfRange(position + 8, position + size))
                        position += size
                    }
                }
                return Header(data, fields, charset)
            }
            val first = header(0)
            var chosen = first
            val boundary = first.fields[121]?.firstOrNull()?.let { if (it.size == 4) uint(it, 0) else null }
            if (uint(first.data, 36) < 8 && boundary != null && boundary < count) {
                // Match Foliate's combo-book preference while retaining the original shared resource base.
                try {
                    chosen = header(boundary.toInt())
                } catch (error: NativeImportFailure) {
                    checkpoint()
                }
            }

            fun strings(type: Int): List<String> =
                chosen.fields[type].orEmpty().map {
                    entities(it.toString(chosen.charset)).trim().also { s ->
                        if (s.length >
                            MAX_TEXT
                        ) {
                            throw NativeImportFailure("resource_limit")
                        }
                    }
                }
            val titleOffset = uint(chosen.data, 84).toInt()
            val titleLength = uint(chosen.data, 88).toInt()
            if (titleOffset < 0 || titleLength < 0 ||
                titleOffset.toLong() + titleLength > chosen.data.size
            ) {
                throw NativeImportFailure("invalid_book")
            }
            val title =
                strings(503).firstOrNull()?.ifEmpty { null }
                    ?: entities(
                        chosen.data.copyOfRange(titleOffset, titleOffset + titleLength).toString(chosen.charset),
                    ).ifEmpty { fallback }
            var image: ByteArray? = null
            if (wantCover) {
                val relative =
                    listOf(201, 202)
                        .mapNotNull {
                            chosen.fields[it]?.firstOrNull()?.let { b ->
                                if (b.size ==
                                    4
                                ) {
                                    uint(b, 0)
                                } else {
                                    null
                                }
                            }
                        }.firstOrNull { it < 0xffffffffL }
                if (relative != null && relative < 0xffffffffL) {
                    try {
                        image = record((uint(first.data, 108) + relative).toInt())
                    } catch (error: Exception) {
                        checkpoint()
                    }
                }
            }
            // EXTH languages take precedence; the common LCID fallback covers the supported reader locales.
            val locale = chosen.data[95].toInt() and 0xff
            val region = (chosen.data[94].toInt() and 0xff) shr 2
            val fallbackLanguage = nativeMobiLocales[locale]?.let { it.getOrNull(region) ?: it.firstOrNull() }
            NativeBibliography(
                title.trim(),
                strings(100).filter { it.isNotEmpty() }.joinToString(", "),
                strings(105).filter { it.isNotEmpty() }.distinct(),
                strings(103).firstOrNull()?.ifEmpty {
                    null
                },
                strings(524).joinToString(", ").ifEmpty {
                    fallbackLanguage
                },
                strings(101).firstOrNull()?.ifEmpty { null },
                strings(106).firstOrNull()?.ifEmpty { null },
                image,
            )
        }

    private fun markdownTitle(
        file: File,
        fallback: String,
        checkpoint: () -> Unit,
    ): String {
        var charset = Charsets.UTF_8
        try {
            Charsets.UTF_8
                .newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .let { decoder ->
                    java.io.InputStreamReader(file.inputStream(), decoder).use { reader ->
                        val buffer = CharArray(32768)
                        while (true) {
                            checkpoint()
                            if (reader.read(buffer) < 0) break
                        }
                    }
                }
        } catch (_: CharacterCodingException) {
            charset = Charset.forName("GB18030")
        }
        val prefix =
            file
                .reader(charset)
                .use { reader ->
                    val buffer = CharArray(128 * 1024 + 1)
                    var length = 0
                    while (length <
                        buffer.size
                    ) {
                        checkpoint()
                        val n = reader.read(buffer, length, buffer.size - length)
                        if (n < 0) break
                        length += n
                    }
                    String(buffer, 0, length)
                }.removePrefix("\uFEFF")
        var node =
            Parser
                .builder()
                .build()
                .parse(prefix)
                .firstChild
        while (node is HtmlBlock && node.literal.trim().startsWith("<!--") && node.literal.trim().endsWith("-->")) node = node.next

        fun text(root: Node): String {
            val out = StringBuilder()

            fun walk(value: Node) {
                when (value) {
                    is Image -> {
                        return
                    }

                    is Text -> {
                        out.append(value.literal)
                    }

                    is Code -> {
                        out.append(value.literal)
                    }

                    is SoftLineBreak, is HardLineBreak -> {
                        out.append('\n')
                    }

                    is HtmlInline -> {
                        Unit
                    }

                    else -> {
                        var child = value.firstChild
                        while (child != null) {
                            walk(child)
                            child = child.next
                        }
                    }
                }
            }
            walk(root)
            return out.toString().trim()
        }
        val title =
            when (node) {
                is Heading -> {
                    if (node.level <= 2) text(node) else fallback
                }

                is HtmlBlock -> {
                    Regex(
                        "^\\s*<h[12](?:\\s[^>]*)?>(.*?)</h[12]>",
                        setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL),
                    ).find(node.literal)?.groupValues?.get(1)?.let {
                        entities(it.replace(Regex("<[^>]+>"), ""))
                    }
                        ?: fallback
                }

                else -> {
                    fallback
                }
            }
        if (title.length > MAX_TEXT) throw NativeImportFailure("resource_limit")
        return title.ifEmpty { fallback }
    }
}
