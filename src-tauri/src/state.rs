use crate::config::AgentConfig;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;
use tauri::async_runtime::JoinHandle;

const MAX_LOGS: usize = 200;

#[derive(Serialize, Clone, Debug)]
pub struct LogEntry {
    pub ts: String,
    pub level: String,
    pub message: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub running: bool,
    pub last_poll_ok: Option<bool>,
    pub last_error: Option<String>,
    pub last_poll_at: Option<String>,
}

pub struct AppState {
    pub config: Mutex<AgentConfig>,
    pub handle: Mutex<Option<JoinHandle<()>>>,
    pub status: Mutex<AgentStatus>,
    pub logs: Mutex<VecDeque<LogEntry>>,
}

impl AppState {
    pub fn new(config: AgentConfig) -> Self {
        Self {
            config: Mutex::new(config),
            handle: Mutex::new(None),
            status: Mutex::new(AgentStatus::default()),
            logs: Mutex::new(VecDeque::with_capacity(MAX_LOGS)),
        }
    }

    pub fn push_log(&self, level: &str, message: String) -> LogEntry {
        let entry = LogEntry {
            ts: chrono::Local::now().to_rfc3339(),
            level: level.to_string(),
            message,
        };
        let mut logs = self.logs.lock().unwrap();
        if logs.len() >= MAX_LOGS {
            logs.pop_front();
        }
        logs.push_back(entry.clone());
        entry
    }
}
