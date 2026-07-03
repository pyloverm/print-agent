use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrintJob {
    pub id: String,
    pub station: String,
    pub data_base64: String,
}

impl PrintJob {
    pub fn get_data(&self) -> Result<Vec<u8>, anyhow::Error> {
        base64::decode(&self.data_base64)
            .map_err(|e| anyhow::anyhow!("Failed to decode base64 data: {}", e))
    }
}
