#!/usr/bin/env node
/**
 * Qomanda Print Agent — agente de impressão self-host.
 *
 * Instala-se no PC do restaurante (o mesmo que está na rede das impressoras).
 * Faz poll ao servidor Qomanda, imprime os tickets ESC/POS diretamente nas
 * impressoras térmicas de rede (porta 9100) e reporta o resultado.
 *
 * Zero dependências : apenas Node.js >= 18.
 *
 * Uso:  node agent.mjs [caminho/para/config.json]
 */

import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve } from "node:path";

// ── Config ──────────────────────────────────────────────────────────────
const configPath = resolve(process.argv[2] || "./config.json");
let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (err) {
  console.error(`[qomanda-agent] Impossível ler a configuração em ${configPath}`);
  console.error("Copie config.example.json para config.json e preencha-o.");
  process.exit(1);
}

const SERVER_URL = (config.serverUrl || "").replace(/\/+$/, "");
const TOKEN = config.token || "";
const PRINTERS = config.printers || {};
const POLL_MS = Math.max(1500, config.pollMs || 3000);
const PRINT_TIMEOUT_MS = 10000;

if (!SERVER_URL || !TOKEN) {
  console.error("[qomanda-agent] serverUrl e token são obrigatórios na configuração.");
  process.exit(1);
}
if (!PRINTERS.kitchen && !PRINTERS.bar) {
  console.error("[qomanda-agent] Configure pelo menos uma impressora (kitchen/bar) com host e port.");
  process.exit(1);
}

// ── Impressão TCP 9100 (RAW ESC/POS) ────────────────────────────────────
function printRaw(printer, data) {
  return new Promise((resolvePrint, rejectPrint) => {
    const socket = createConnection({ host: printer.host, port: printer.port || 9100 });
    const timer = setTimeout(() => {
      socket.destroy();
      rejectPrint(new Error(`Timeout ao contactar a impressora ${printer.host}:${printer.port || 9100}`));
    }, PRINT_TIMEOUT_MS);

    socket.on("connect", () => {
      socket.write(data, (err) => {
        clearTimeout(timer);
        if (err) {
          socket.destroy();
          rejectPrint(err);
        } else {
          socket.end();
        }
      });
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolvePrint();
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      rejectPrint(err);
    });
  });
}

// ── API Qomanda ─────────────────────────────────────────────────────────
const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

async function fetchJobs() {
  const res = await fetch(`${SERVER_URL}/api/print-agent/jobs`, { headers });
  if (res.status === 401) {
    throw new Error("Token inválido — verifique a configuração (Dashboard > Equipa > Impressão).");
  }
  if (!res.ok) throw new Error(`Servidor respondeu ${res.status}`);
  const body = await res.json();
  return body.jobs || [];
}

async function reportJob(jobId, ok, error) {
  try {
    await fetch(`${SERVER_URL}/api/print-agent/jobs/${jobId}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ok, error }),
    });
  } catch (err) {
    console.error(`[qomanda-agent] Falha ao reportar o job ${jobId}:`, err.message);
  }
}

// ── Boucle principale ───────────────────────────────────────────────────
let consecutiveErrors = 0;

async function tick() {
  try {
    const jobs = await fetchJobs();
    consecutiveErrors = 0;

    for (const job of jobs) {
      const printer = PRINTERS[job.station];
      if (!printer) {
        console.warn(`[qomanda-agent] Sem impressora configurada para "${job.station}" — job ${job.id} falhado.`);
        await reportJob(job.id, false, `Sem impressora configurada para o posto "${job.station}" no agente.`);
        continue;
      }

      const data = Buffer.from(job.dataBase64, "base64");
      try {
        await printRaw(printer, data);
        console.log(`[qomanda-agent] ✓ Impresso job ${job.id} (${job.station}) em ${printer.host}`);
        await reportJob(job.id, true);
      } catch (err) {
        console.error(`[qomanda-agent] ✗ Falha no job ${job.id} (${job.station}):`, err.message);
        await reportJob(job.id, false, err.message);
      }
    }
  } catch (err) {
    consecutiveErrors++;
    // Backoff progressivo quando o servidor está inacessível (máx ~30 s)
    if (consecutiveErrors === 1 || consecutiveErrors % 10 === 0) {
      console.error(`[qomanda-agent] Erro de ligação ao servidor: ${err.message}`);
    }
  }

  const delay = Math.min(POLL_MS * Math.max(1, consecutiveErrors), 30000);
  setTimeout(tick, delay);
}

console.log(`[qomanda-agent] Qomanda Print Agent iniciado.`);
console.log(`[qomanda-agent] Servidor: ${SERVER_URL}`);
console.log(
  `[qomanda-agent] Impressoras: ${Object.entries(PRINTERS)
    .map(([st, p]) => `${st} → ${p.host}:${p.port || 9100}`)
    .join(" · ")}`
);
tick();
