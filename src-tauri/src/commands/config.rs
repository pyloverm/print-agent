use serde_json::Value;

#[tauri::command]
pub async fn get_config() -> Value {
    serde_json::json!({
        "serverUrl": "",
        "token": "",
        "pollIntervalMs": 3000,
        "printTimeoutMs": 10000,
        "restaurantName": "",
        "printers": {},
        "autoStart": true,
        "minimizeToTray": true,
        "startOnStartup": true
    })
}

#[tauri::command]
pub async fn save_config(config: Value) -> Result<(), String> {
    Ok(())
}
