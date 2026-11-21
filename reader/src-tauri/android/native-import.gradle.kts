// Kept separate from Tauri-generated dependencies; prepare-android-project copies and applies it atomically.
dependencies {
    add("implementation", "io.legere:pdfiumandroid:1.0.35")
    // Java 8 parser avoids adding a Java 11 core-library desugaring dependency for Android 24.
    add("implementation", "org.commonmark:commonmark:0.21.0")
    add("implementation", "org.lsposed.hiddenapibypass:hiddenapibypass:4.3")
    add("implementation", "com.onyx.android.sdk:onyxsdk-device:1.3.7") {
        exclude(mapOf("group" to "com.android.support"))
        exclude(mapOf("group" to "pub.devrel", "module" to "easypermissions"))
    }
    add("implementation", "com.onyx.android.sdk:onyxsdk-pen:1.5.9") {
        exclude(mapOf("group" to "com.android.support"))
        exclude(mapOf("group" to "pub.devrel", "module" to "easypermissions"))
    }
}

extensions.configure<com.android.build.api.dsl.ApplicationExtension>("android") {
    packaging {
        jniLibs.pickFirsts.add("**/libc++_shared.so")
    }
}
