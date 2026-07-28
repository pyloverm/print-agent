#!/usr/bin/env node
/**
 * Qomanda Print Agent — agente de impressão self-host.
 *
 * Instala-se no PC do restaurante (o mesmo que está na rede das impressoras).
 * Imprime os tickets ESC/POS diretamente nas impressoras térmicas de rede
 * (porta 9100) e reporta o resultado.
 *
 * MODELO DE FUNCIONAMENTO — porquê WebSocket e não polling:
 *
 * O PC do restaurante está atrás de um NAT (muitas vezes CGNAT): o servidor
 * NÃO o consegue contactar de fora. A solução é o agente abrir UMA ligação de
 * SAÍDA e mantê-la aberta — o NAT deixa sempre sair. O servidor empurra
 * "há trabalho" por esse túnel. Funcionalmente é "o servidor liga ao PC",
 * sem tocar no router do cliente.
 *
 * Porque isto importa (custo): a base de dados Neon suspende-se ao fim de
 * 5 minutos sem consultas, e é o TEMPO ACORDADO que é faturado, não o número
 * de consultas. O agente antigo consultava de 3 em 3 segundos e mantinha a
 * base acordada 24/7. Passar para 60 s NÃO resolveria nada — 60 s < 5 min.
 * Por isso: enquanto o WebSocket está ligado, ZERO consultas. O poll de
 * segurança só corre quando o WebSocket caiu — ou seja, quando já há avaria.
 *
 * Zero dependências : apenas Node.js >= 22 (WebSocket nativo global).
 *
 * Uso:  node agent.mjs [caminho/para/config.json]
 */

import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

// ── Requisito de versão ─────────────────────────────────────────────────
// O WebSocket global só existe a partir do Node 22. Falhar aqui, com uma
// mensagem clara, é melhor do que um "WebSocket is not defined" opaco.
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (NODE_MAJOR < 22) {
  console.error(
    `[qomanda-agent] Node.js 22 ou superior é obrigatório (detetado ${process.versions.node}).`
  );
  console.error("[qomanda-agent] Instale a versão LTS mais recente em https://nodejs.org e volte a tentar.");
  process.exit(1);
}

// ── Config ──────────────────────────────────────────────────────────────
const configPath = resolve(process.argv[2] || "./config.json");
let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch {
  console.error(`[qomanda-agent] Impossível ler a configuração em ${configPath}`);
  console.error("Copie config.example.json para config.json e preencha-o.");
  process.exit(1);
}

const SERVER_URL = (config.serverUrl || "https://new.qomanda.eu").replace(/\/+$/, "");
const TOKEN = config.token || "";
const PRINTERS = config.printers || {};
const REALTIME_URL = (config.realtimeUrl || "https://realtime.qomanda.eu").replace(/\/+$/, "");
const REALTIME_KEY = config.realtimeKey || "a0g4w5Gk3ujFL9wurqHyCdEOmf5fQdLsFLHtHw139pBmZFojPrXQSIWx9Zd6BtxAl2fywhXq379ZG0hSF7jw";
// Rede de segurança, só usada quando o WebSocket está em baixo.
const FALLBACK_POLL_MS = Math.max(15000, config.fallbackPollMs || 60000);
const PRINT_TIMEOUT_MS = 10000;

if (!SERVER_URL || !TOKEN) {
  console.error("[qomanda-agent] serverUrl e token são obrigatórios na configuração.");
  process.exit(1);
}
if (!PRINTERS.kitchen && !PRINTERS.bar && !PRINTERS.payment) {
  console.error("[qomanda-agent] Configure pelo menos uma impressora (kitchen/bar/payment) com host e port.");
  process.exit(1);
}

const REALTIME_ENABLED = Boolean(REALTIME_URL && REALTIME_KEY);

/**
 * Canal de despertar. DEVE ser idêntico ao cálculo de
 * src/lib/print-agent-channel.ts no servidor — se divergir, o agente escuta um
 * canal onde ninguém publica e cai silenciosamente no poll de segurança.
 */
const CHANNEL = `print-agent-${createHash("sha256").update(TOKEN).digest("hex").slice(0, 32)}`;

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

// ── Escolha da impressora por posto ─────────────────────────────────────
// Os postos do servidor são "kitchen", "bar" e "payment" (o recibo do cliente
// / documento fiscal Vendus ou Fact) — ver PrintStation em src/lib/printing.ts.
//
// O recibo sai quase sempre no balcão, e muitas casas só têm uma térmica aí.
// Por isso, se "payment" não estiver configurado, usamos a do bar e, em último
// caso, a da cozinha — com um aviso, porque um recibo de cliente a sair na
// cozinha é uma configuração a corrigir, não um funcionamento normal. Falhar
// era a alternativa, mas deixaria o cliente à espera de um talão que nunca sai.
const warnedFallback = new Set();

function resolvePrinter(station) {
  const direct = PRINTERS[station];
  if (direct) return direct;

  if (station === "payment") {
    const fallback = PRINTERS.bar || PRINTERS.kitchen;
    if (fallback) {
      if (!warnedFallback.has(station)) {
        warnedFallback.add(station);
        console.warn(
          `[qomanda-agent] Sem impressora "payment" configurada — os recibos vão sair em ${fallback.host}.`
        );
        console.warn('[qomanda-agent] Acrescente "payment" a "printers" no config.json para os separar.');
      }
      return fallback;
    }
  }
  return null;
}

// ── Recolha e impressão ─────────────────────────────────────────────────
// Um único drain de cada vez: vários eventos seguidos (3 tickets num pedido)
// não devem lançar 3 recolhas concorrentes sobre a mesma fila.
let draining = false;
let drainAgain = false;

async function drainJobs(reason) {
  if (draining) {
    drainAgain = true;
    return;
  }
  draining = true;
  try {
    const jobs = await fetchJobs();
    if (jobs.length > 0) {
      console.log(`[qomanda-agent] ${jobs.length} job(s) recebido(s) (${reason}).`);
    }

    for (const job of jobs) {
      const printer = resolvePrinter(job.station);
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
    console.error(`[qomanda-agent] Erro ao recolher jobs: ${err.message}`);
  } finally {
    draining = false;
    if (drainAgain) {
      drainAgain = false;
      drainJobs("evento durante recolha anterior");
    }
  }
}

// ── Poll de segurança (só enquanto o WebSocket estiver em baixo) ─────────
let fallbackTimer = null;

function startFallbackPolling(why) {
  if (fallbackTimer) return;
  console.warn(`[qomanda-agent] Poll de segurança ATIVO (${why}) — a cada ${FALLBACK_POLL_MS / 1000}s.`);
  fallbackTimer = setInterval(() => drainJobs("poll de segurança"), FALLBACK_POLL_MS);
}

function stopFallbackPolling() {
  if (!fallbackTimer) return;
  clearInterval(fallbackTimer);
  fallbackTimer = null;
  console.log("[qomanda-agent] Poll de segurança DESATIVADO (tempo real ligado).");
}

// ── WebSocket (protocolo Pusher, servido pelo Soketi) ───────────────────
// Implementado à mão para manter a promessa "zero dependências": o protocolo
// resume-se a um handshake, uma subscrição e responder aos pings.
let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;

function connectRealtime() {
  if (!REALTIME_ENABLED) return;

  const url = `${REALTIME_URL}/app/${REALTIME_KEY}?protocol=7&client=qomanda-agent&version=1.0.0`;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    scheduleReconnect(`falha ao abrir o WebSocket: ${err.message}`);
    return;
  }

  ws.addEventListener("open", () => {
    reconnectAttempts = 0;
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    } catch {
      return;
    }

    switch (msg.event) {
      case "pusher:connection_established":
        // Canal público: nenhuma autorização necessária — o segredo é o
        // próprio nome do canal, derivado do token (ver print-agent-channel.ts).
        ws.send(JSON.stringify({ event: "pusher:subscribe", data: { channel: CHANNEL } }));
        break;

      case "pusher_internal:subscription_succeeded":
        console.log("[qomanda-agent] Tempo real ligado — à espera de trabalhos.");
        stopFallbackPolling();
        // Apanhar o que possa ter sido enfileirado enquanto estávamos offline.
        drainJobs("ligação estabelecida");
        break;

      case "pusher:ping":
        ws.send(JSON.stringify({ event: "pusher:pong", data: {} }));
        break;

      case "pusher:error":
        console.error(`[qomanda-agent] Erro do servidor de tempo real: ${JSON.stringify(msg.data)}`);
        break;

      case "job-queued":
        drainJobs("aviso do servidor");
        break;
    }
  });

  ws.addEventListener("close", () => scheduleReconnect("ligação fechada"));
  ws.addEventListener("error", () => {
    // O evento "close" segue-se sempre — a reconexão é tratada lá, para não
    // agendar duas vezes.
  });
}

function scheduleReconnect(why) {
  ws = null;
  // Sem tempo real, a fila só é vista pelo poll: ativá-lo é o que evita
  // perder um ticket de cozinha durante a avaria.
  startFallbackPolling(why);

  if (reconnectTimer) return;
  reconnectAttempts++;
  // Backoff exponencial travado a 60 s.
  const delay = Math.min(2000 * 2 ** Math.min(reconnectAttempts - 1, 5), 60000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectRealtime();
  }, delay);
}

// ── Arranque ────────────────────────────────────────────────────────────
console.log("[qomanda-agent] Qomanda Print Agent iniciado.");
console.log(`[qomanda-agent] Servidor: ${SERVER_URL}`);
console.log(
  `[qomanda-agent] Impressoras: ${Object.entries(PRINTERS)
    .map(([st, p]) => `${st} → ${p.host}:${p.port || 9100}`)
    .join(" · ")}`
);

if (REALTIME_ENABLED) {
  console.log(`[qomanda-agent] Tempo real: ${REALTIME_URL}`);
  connectRealtime();
} else {
  console.warn("[qomanda-agent] ATENÇÃO: realtimeUrl/realtimeKey não configurados.");
  console.warn("[qomanda-agent] O agente vai funcionar apenas por poll, o que mantém a base de dados");
  console.warn("[qomanda-agent] permanentemente acordada. Configure o tempo real assim que possível.");
  startFallbackPolling("tempo real não configurado");
}

// Recolha inicial: pode haver trabalho em fila desde a última paragem.
drainJobs("arranque");
