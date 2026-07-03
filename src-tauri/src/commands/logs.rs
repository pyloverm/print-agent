use serde_json::Value;

#[tauri::command]
pub async fn get_logs() -> Vec<Value> {
    vec![]
}

#[tauri::command]
pub async fn get_log_dates() -> Vec<String> {
    vec![]
}
