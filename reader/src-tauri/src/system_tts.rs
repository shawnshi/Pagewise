//! Native Android TextToSpeech bridge. The WebView has no Web Speech API, so the
//! "system voice" engine speaks through the device TTS engine instead.
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{
    plugin::{mobile::PluginInvokeError, Builder, PluginHandle, TauriPlugin},
    Manager,
};

struct SystemTtsHandle(PluginHandle<tauri::Wry>);

#[derive(Serialize)]
pub struct TtsError {
    code: String,
}

fn error(code: &str) -> TtsError {
    TtsError { code: code.into() }
}

pub fn init() -> TauriPlugin<tauri::Wry> {
    Builder::new("system-tts")
        .setup(|app, api| {
            let handle = api.register_android_plugin("io.pagewise.reader", "SystemTtsPlugin")?;
            app.manage(SystemTtsHandle(handle));
            Ok(())
        })
        .build()
}

async fn call(
    app: tauri::AppHandle,
    command: &'static str,
    args: Value,
) -> Result<Value, TtsError> {
    // speak blocks until the utterance finishes; keep it off the async runtime.
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<SystemTtsHandle>()
            .0
            .run_mobile_plugin(command, args)
            .map_err(|failure| match failure {
                PluginInvokeError::InvokeRejected(response) => TtsError {
                    code: response.code.unwrap_or_else(|| "tts_error".into()),
                },
                _ => error("unavailable"),
            })
    })
    .await
    .map_err(|_| error("unavailable"))?
}

#[tauri::command]
pub async fn system_tts_available(app: tauri::AppHandle) -> Result<Value, TtsError> {
    call(app, "available", json!({})).await
}

#[tauri::command]
pub async fn system_tts_speak(
    app: tauri::AppHandle,
    text: String,
    rate: f64,
    voice: Option<String>,
) -> Result<Value, TtsError> {
    call(
        app,
        "speak",
        json!({ "text": text, "rate": rate, "voice": voice.unwrap_or_default() }),
    )
    .await
}

#[tauri::command]
pub async fn system_tts_stop(app: tauri::AppHandle) -> Result<Value, TtsError> {
    call(app, "stop", json!({})).await
}

#[tauri::command]
pub async fn system_tts_session(
    app: tauri::AppHandle,
    action: String,
    payload: Value,
) -> Result<Value, TtsError> {
    call(
        app,
        "session",
        json!({ "action": action, "payload": payload }),
    )
    .await
}

#[tauri::command]
pub async fn system_tts_status(app: tauri::AppHandle) -> Result<Value, TtsError> {
    call(app, "status", json!({})).await
}

#[tauri::command]
pub async fn system_tts_speak_batch(
    app: tauri::AppHandle,
    texts: Vec<String>,
    rate: f64,
    voice: Option<String>,
) -> Result<Value, TtsError> {
    call(
        app,
        "speakBatch",
        json!({ "texts": texts, "rate": rate, "voice": voice.unwrap_or_default() }),
    )
    .await
}
