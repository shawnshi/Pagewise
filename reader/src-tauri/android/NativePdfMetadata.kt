package io.pagewise.reader

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import io.legere.pdfiumandroid.PdfiumCore
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.math.max
import kotlin.math.roundToInt

/** All PDF metadata and cover work executes in the native file-job worker, not the UI/WebView. */
internal object NativePdfMetadata {
    fun parse(
        context: Context,
        file: File,
        name: String,
        wantCover: Boolean,
        checkpoint: () -> Unit,
    ): NativeBibliography {
        checkpoint()
        if (!file.isFile || file.length() <= 0 || file.length() > 1024L * 1024 * 1024) throw NativeImportFailure("resource_limit")
        val core = PdfiumCore(context.applicationContext)
        val bibliography =
            ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
                core.newDocument(descriptor).use { document ->
                    checkpoint()
                    val meta = document.getDocumentMeta()
                    // CreationDate is not a publication date; retain the existing metadata contract.
                    NativeBibliography(
                        meta.title
                            .orEmpty()
                            .trim()
                            .ifEmpty { name.substringBeforeLast('.', name) },
                        meta.author.orEmpty().trim(),
                    )
                }
            }
        if (!wantCover) return bibliography
        val cover =
            try {
                ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
                    PdfRenderer(descriptor).use { renderer ->
                        if (renderer.pageCount == 0) {
                            null
                        } else {
                            renderer.openPage(0).use { page ->
                                checkpoint()
                                if (page.width <= 0 || page.height <= 0) throw NativeImportFailure("invalid_cover")
                                val scale = 640.0 / max(page.width, page.height)
                                val width = (page.width * scale).roundToInt().coerceIn(1, 640)
                                val height = (page.height * scale).roundToInt().coerceIn(1, 640)
                                val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                                try {
                                    bitmap.eraseColor(Color.WHITE)
                                    page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                                    checkpoint()
                                    jpeg(bitmap)
                                } finally {
                                    bitmap.recycle()
                                }
                            }
                        }
                    }
                }
            } catch (error: Exception) {
                checkpoint()
                null
            }
        return bibliography.copy(cover = cover)
    }

    fun normalizeCover(
        bytes: ByteArray?,
        checkpoint: () -> Unit,
    ): ByteArray? {
        if (bytes == null) return null
        if (bytes.size > 12 * 1024 * 1024) throw NativeImportFailure("resource_limit")
        checkpoint()
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || bounds.outWidth.toLong() * bounds.outHeight > 100_000_000L) return null
        var sample = 1
        while (max(bounds.outWidth, bounds.outHeight) / sample > 1280) sample *= 2
        val decoded =
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        try {
            val scale = minOf(1.0, 640.0 / max(decoded.width, decoded.height))
            val width = (decoded.width * scale).roundToInt().coerceAtLeast(1)
            val height = (decoded.height * scale).roundToInt().coerceAtLeast(1)
            val output = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            try {
                output.eraseColor(Color.WHITE)
                Canvas(output).drawBitmap(decoded, null, android.graphics.Rect(0, 0, width, height), null)
                checkpoint()
                return jpeg(output)
            } finally {
                output.recycle()
            }
        } finally {
            decoded.recycle()
        }
    }

    private fun jpeg(bitmap: Bitmap): ByteArray {
        val out = ByteArrayOutputStream()
        if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 80, out) || out.size() > 1024 * 1024) throw NativeImportFailure("invalid_cover")
        return out.toByteArray()
    }
}
