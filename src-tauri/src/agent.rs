use crate::config::AgentConfig;
use crate::printer::print_raw;
use crate::state::{AgentStatus, AppState};
use base64::Engine;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    id: String,
    station: String,
    data_base64: String,
}

#[derive(Deserialize)]
struct JobsResponse {
    #[serde(default)]
    jobs: Vec<Job>,
}

fn log(app: &AppHandle, level: &str, message: String) {
    let state = app.state::<AppState>();
    let entry = state.push_log(level, message);
    let _ = app.emit("agent-log", entry);
}

fn set_status(app: &AppHandle, status: AgentStatus) {
    let state = app.state::<AppState>();
    *state.status.lock().unwrap() = status.clone();
    let _ = app.emit("agent-status", status);
}

async fn fetch_jobs(client: &reqwest::Client, server_url: &str, token: &str) -> Result<Vec<Job>, String> {
    let res = client
        .get(format!("{server_url}/api/print-agent/jobs"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Erro de ligação ao servidor: {e}"))?;

    if res.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(
            "Token inválido — verifique a configuração (Dashboard > Equipa > Impressão).".into(),
        );
    }
    if !res.status().is_success() {
        return Err(format!("Servidor respondeu {}", res.status()));
    }

    let body: JobsResponse = res
        .json()
        .await
        .map_err(|e| format!("Resposta inválida do servidor: {e}"))?;
    Ok(body.jobs)
}

async fn report_job(client: &reqwest::Client, server_url: &str, token: &str, job_id: &str, ok: bool, error: Option<&str>) {
    let _ = client
        .post(format!("{server_url}/api/print-agent/jobs/{job_id}"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "ok": ok, "error": error }))
        .send()
        .await;
}

pub fn spawn(app: AppHandle, config: AgentConfig) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::new();
        let server_url = config.server_url.trim_end_matches('/').to_string();
        let mut consecutive_errors: u32 = 0;

        set_status(
            &app,
            AgentStatus {
                running: true,
                ..Default::default()
            },
        );
        log(&app, "info", "Qomanda Print Agent iniciado.".into());

        loop {
            match fetch_jobs(&client, &server_url, &config.token).await {
                Ok(jobs) => {
                    consecutive_errors = 0;
                    for job in jobs {
                        let printer = match job.station.as_str() {
                            "kitchen" => config.printers.kitchen.clone(),
                            "bar" => config.printers.bar.clone(),
                            "payment" => config.printers.payment.clone(),
                            _ => None,
                        };
                        let Some(printer) = printer else {
                            let msg = format!(
                                "Sem impressora configurada para o posto \"{}\" — job {} falhado.",
                                job.station, job.id
                            );
                            log(&app, "warn", msg.clone());
                            report_job(&client, &server_url, &config.token, &job.id, false, Some(&msg)).await;
                            continue;
                        };

                        let data = match base64::engine::general_purpose::STANDARD.decode(&job.data_base64) {
                            Ok(d) => d,
                            Err(e) => {
                                log(&app, "error", format!("Job {} com dados inválidos: {e}", job.id));
                                report_job(&client, &server_url, &config.token, &job.id, false, Some("Dados do ticket inválidos")).await;
                                continue;
                            }
                        };

                        match print_raw(&printer, &data).await {
                            Ok(()) => {
                                log(
                                    &app,
                                    "success",
                                    format!("Impresso job {} ({}) em {}", job.id, job.station, printer.host),
                                );
                                report_job(&client, &server_url, &config.token, &job.id, true, None).await;
                            }
                            Err(err) => {
                                log(&app, "error", format!("Falha no job {} ({}): {err}", job.id, job.station));
                                report_job(&client, &server_url, &config.token, &job.id, false, Some(&err)).await;
                            }
                        }
                    }

                    set_status(
                        &app,
                        AgentStatus {
                            running: true,
                            last_poll_ok: Some(true),
                            last_error: None,
                            last_poll_at: Some(chrono::Local::now().to_rfc3339()),
                        },
                    );
                }
                Err(err) => {
                    consecutive_errors += 1;
                    if consecutive_errors == 1 || consecutive_errors % 10 == 0 {
                        log(&app, "error", format!("Erro de ligação ao servidor: {err}"));
                    }
                    set_status(
                        &app,
                        AgentStatus {
                            running: true,
                            last_poll_ok: Some(false),
                            last_error: Some(err),
                            last_poll_at: Some(chrono::Local::now().to_rfc3339()),
                        },
                    );
                }
            }

            let delay_ms = (config.poll_ms * consecutive_errors.max(1) as u64).min(30_000);
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        }
    })
}
