// Kept separate from Tauri-generated dependencies; prepare-android-project copies and applies it atomically.
dependencies {
    add("implementation", "io.legere:pdfiumandroid:1.0.35")
    // Java 8 parser avoids adding a Java 11 core-library desugaring dependency for Android 24.
    add("implementation", "org.commonmark:commonmark:0.21.0")
}
