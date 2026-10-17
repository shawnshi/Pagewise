fn main() {
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("android") {
    panic!("Pagewise supports Android only");
  }
  tauri_build::build()
}
