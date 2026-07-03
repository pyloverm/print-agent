use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    pub server_url: String,
    pub token: String,
    pub poll_interval_ms: u64,
    pub print_timeout_ms: u64,
    pub restaurant_name: String,
    pub printers: HashMap<String, PrinterConfig>,
    pub auto_start: bool,
    pub minimize_to_tray: bool,
    pub start_on_startup: bool,
}

impl AppConfig {
    pub fn new() -> Self {
        Self {
            server_url: String::new(),
            token: String::new(),
            poll_interval_ms: 3000,
            print_timeout_ms: 10000,
            restaurant_name: String::new(),
            printers: HashMap::new(),
            auto_start: true,
            minimize_to_tray: true,
            start_on_startup: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrinterConfig {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub station: String,
    pub enabled: bool,
}

impl Default for PrinterConfig {
    fn default() -> Self {
        Self {
            name: String::new(),
            host: String::new(),
            port: 9100,
            station: String::new(),
            enabled: true,
        }
    }
}
