use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AgentState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentStats {
    pub total_jobs: u64,
    pub successful_jobs: u64,
    pub failed_jobs: u64,
    pub total_errors: u64,
    pub last_sync: Option<DateTime<Utc>>,
    pub last_print: Option<DateTime<Utc>>,
    pub last_error: Option<DateTime<Utc>>,
    pub started_at: Option<DateTime<Utc>>,
    pub state: AgentState,
    pub version: String,
}

impl AgentStats {
    pub fn new(version: String) -> Self {
        Self {
            total_jobs: 0,
            successful_jobs: 0,
            failed_jobs: 0,
            total_errors: 0,
            last_sync: None,
            last_print: None,
            last_error: None,
            started_at: Some(Utc::now()),
            state: AgentState::Stopped,
            version,
        }
    }
}
