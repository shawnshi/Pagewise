package io.pagewise.reader

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.os.Looper
import android.view.ContextThemeWrapper
import android.view.View
import android.widget.ImageView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.math.abs
import kotlin.math.sqrt

private class StrokeCanvas(
    bitmap: Bitmap,
) : Canvas(bitmap) {
    val widths = mutableListOf<Float>()

    @Suppress("DEPRECATION")
    override fun drawPath(
        path: Path,
        paint: Paint,
    ) {
        if (paint.style == Paint.Style.STROKE) {
            val matrix = Matrix()
            getMatrix(matrix)
            val values = FloatArray(9)
            matrix.getValues(values)
            val scale = sqrt(values[Matrix.MSCALE_X] * values[Matrix.MSCALE_X] + values[Matrix.MSKEW_Y] * values[Matrix.MSKEW_Y])
            widths.add(paint.strokeWidth * scale)
        }
        super.drawPath(path, paint)
    }
}

fun main(args: Array<String>) {
    val base = File(args.single()).canonicalFile
    check(base.path.startsWith("/data/local/tmp/pagewise-eink-s1-"))
    check(!base.exists() && base.mkdirs())
    if (Looper.myLooper() == null) Looper.prepareMainLooper()
    // app_process does not receive the BIND_APPLICATION font map used by normal Android apps.
    android.graphics.Typeface::class.java.getMethod("loadPreinstalledSystemFontMap").invoke(null)
    val activityThread = Class.forName("android.app.ActivityThread")
    val thread = activityThread.getMethod("systemMain").invoke(null)
    val system = activityThread.getMethod("getSystemContext").invoke(thread) as Context
    val cases = JSONArray()
    var failures = 0
    for (dpi in listOf(160, 300, 480)) {
        val configuration = android.content.res.Configuration(system.resources.configuration)
        configuration.densityDpi = dpi
        val context = ContextThemeWrapper(system.createConfigurationContext(configuration), android.R.style.Theme_Material_Light)
        val density = context.resources.displayMetrics.density
        check(abs(density - dpi / 160f) < 0.001f)

        fun checkView(
            name: String,
            view: View,
            widthDp: Int,
            heightDp: Int,
            expectedDp: Float,
        ) {
            val w = NativeUi.dp(context, widthDp)
            val h = NativeUi.dp(context, heightDp)
            view.measure(
                View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY),
            )
            view.layout(0, 0, w, h)
            val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            bitmap.density = Bitmap.DENSITY_NONE
            bitmap.eraseColor(Color.WHITE)
            val canvas = StrokeCanvas(bitmap)
            view.draw(canvas)
            val expected = expectedDp * density
            val passed = canvas.widths.isNotEmpty() && canvas.widths.all { abs(it - expected) < 0.05f }
            if (!passed) failures++
            val value =
                JSONObject()
                    .put("name", name)
                    .put("dpi", dpi)
                    .put("density", density)
                    .put("sizeDp", JSONArray().put(widthDp).put(heightDp))
                    .put("expectedStrokePx", expected)
                    .put("actualStrokePx", JSONArray(canvas.widths))
                    .put("passed", passed)
            if (view is ImageView) value.put("scaleType", view.scaleType.name).put("imageMatrixIdentity", view.imageMatrix.isIdentity)
            cases.put(value)
            File(base, "$name-$dpi.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
        for (selected in listOf(false, true)) {
            val item =
                NativeUi.navigationItem(context, "Synthetic navigation", "library", selected, Color.BLACK, Color.WHITE) {
                } as android.widget.LinearLayout
            val image = item.getChildAt(1) as ImageView
            item.removeView(image)
            checkView("navigation-$selected", image, 28, 28, if (selected) 2f else 1.5f)
            checkView("navigation-rectangular-$selected", image, 40, 28, if (selected) 2f else 1.5f)
        }
        val icon = NativeUi.iconButton(context, "Synthetic icon", "library", Color.BLACK, Color.WHITE) {}
        checkView("icon-button", icon, 48, 48, 1.5f)
        checkView("icon-button-large", icon, 64, 48, 1.5f)
    }
    println(
        JSONObject()
            .put(
                "passed",
                failures == 0,
            ).put("failures", failures)
            .put("cases", cases)
            .put("runtime", "actual Android Views and Bitmap Canvas; not physical e-ink panel"),
    )
    check(failures == 0) { "$failures parent-transform stroke cases failed" }
}
