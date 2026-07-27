# Qomanda Print Agent

Agente de impressão **self-host e gratuito** — a alternativa ao PrintNode.
Corre no PC do restaurante e imprime os tickets (cozinha, bar, pagamento, ...)
diretamente nas impressoras térmicas, de rede ou USB, sem serviços cloud pagos.

Este repositório tem **dois agentes**:

- **App Tauri** (`src/`, `src-tauri/`) — interface gráfica, suporte a
  impressoras de rede e USB, **tempo real por WebSocket**. Para Windows 10/11.
  É o agente recomendado.
- **`agent.cjs`** (na raiz) — script minimalista sem GUI, sem dependências,
  com suporte a impressoras de rede e USB. Para PCs mais antigos (Windows 7
  SP1, 8, 8.1) onde a app Tauri/WebView2 não é fiável.

Os dois usam o mesmo modelo de tempo real e o mesmo `config.json` — só muda a
interface.

## Requisitos (agente `agent.cjs`)

- Windows 7 SP1, 8, 8.1, 10 ou 11 (usando o `.exe` autónomo — ver abaixo —
  não é preciso instalar Node.js)
- Impressoras térmicas ESC/POS, **de rede** (Epson TM, e compatíveis)
  acessíveis na porta 9100 ("RAW/JetDirect"), **ou USB/local** instaladas no
  Windows (a impressão USB invoca o spooler do Windows via PowerShell —
  precisa do driver da impressora instalado, tal como para imprimir a
  partir de qualquer outro programa)
- O PC e as impressoras de rede na mesma rede local
- Saída para a Internet na porta 443 — o agente abre uma ligação de saída para
  o servidor de tempo real; não é preciso abrir nada no router

## Instalação (Windows 7/8/8.1 — `.exe` autónomo)

1. No dashboard Qomanda: **Equipa → Impressão** — escolha o fornecedor
   *Agente local* e copie o **token do agente**.
2. Copie `dist-legacy-agent/qomanda-print-agent-win7.exe` (gerar com
   `npm run agent:build:win7`, ver secção seguinte) para o PC do
   restaurante, ex: `C:\qomanda\`.
3. Ao lado do `.exe`, copie `config.example.json` para `config.json` e preencha
   `serverUrl`, `token` (o token copiado no passo 1), `realtimeUrl` /
   `realtimeKey` (o servidor de tempo real e a sua chave pública — **sem eles
   o agente arranca à mesma, mas em modo degradado**, ver "Como funciona"), e
   `printers` — uma entrada por posto (`kitchen`, `bar`, `payment`, ou
   qualquer outro nome de posto usado no dashboard):
   - **Impressora de rede**: `{ "host": "192.168.1.50", "port": 9100 }`
     — o IP imprime-se geralmente com o auto-teste da impressora
     (desligar, manter FEED premido, ligar).
   - **Impressora USB/local**: `{ "kind": "usb", "printerName": "POS-80" }`
     — o nome exato tal como aparece em *Definições → Impressoras* do
     Windows.
4. Corra `qomanda-print-agent-win7.exe` (duplo clique, ou a partir da consola
   para ver os logs).

## Gerar o `.exe` (para quem faz o build)

O `.exe` embute um runtime Node.js 12 — a última versão com suporte oficial
a Windows 7 — para não depender do que estiver instalado no PC do restaurante.

```bash
npm install
npm run agent:build:win7
```

Produz `dist-legacy-agent/qomanda-print-agent-win7.exe`. Distribua esse
ficheiro junto com `config.example.json`.

## Instalação (Windows 10/11 com Node.js já instalado)

Alternativa ao `.exe`, se preferir correr o script diretamente:

```bash
node agent.cjs caminho/para/config.json
```

## Arranque automático (Windows)

Crie um atalho na pasta Arranque (`shell:startup`) com o alvo:

```
C:\qomanda\qomanda-print-agent-win7.exe
```

(ou, a correr via Node.js: `node C:\qomanda\agent.cjs C:\qomanda\config.json`)

Ou registe como serviço com [NSSM](https://nssm.cc/): `nssm install QomandaPrintAgent`.

## Instalação (app Tauri — Windows 10/11)

1. No dashboard Qomanda: **Equipa → Impressão** — escolha o fornecedor
   *Agente local* e copie o **token do agente**.
2. Instale e abra a app. Na **Configuração**, preencha:
   - **Endereço do servidor** e **token do agente**.
   - **Tempo real** — o endereço do servidor Soketi (`wss://...`) e a sua
     chave pública. **Sem eles a app funciona à mesma, mas em modo
     degradado** — ver "Como funciona".
   - **Impressoras** — por posto, de rede (IP + porta 9100) ou USB/local
     (o nome exato tal como aparece em *Definições → Impressoras*). O botão
     *Testar* imprime um talão de teste.
3. Ligue **Iniciar automaticamente com o Windows**.

A barra de estado no topo mostra qual dos modos está ativo: *Tempo real
ligado* (verde) ou *Poll de segurança ativo* (laranja).

## Como funciona

O agente **não faz poll**. Abre uma ligação WebSocket de saída para o servidor
de tempo real e fica à espera; quando há um talão para imprimir, é o servidor
que o avisa. Enquanto essa ligação estiver de pé, o agente **não faz uma única
consulta** ao servidor.

Isto não é uma otimização cosmética. A base de dados suspende-se ao fim de
5 minutos sem atividade e é faturada pelo **tempo acordado**, não pelo número de
consultas — um agente que perguntasse de 3 em 3 segundos (ou mesmo de 60 em 60)
mantinha-a acordada 24 horas por dia. Daí o modelo de "aviso" em vez de
"pergunta repetida".

O PC do restaurante está atrás de um NAT e não é contactável de fora; é por isso
que a ligação parte **do agente para o servidor** e fica aberta. O efeito é o
mesmo — o servidor avisa o PC — sem mexer no router do cliente.

Restante funcionamento:

- O aviso do servidor não traz dados: é só "há trabalho". O agente vai depois
  buscar o talão pela API autenticada.
- **Rede de segurança**: se o WebSocket cair, o agente passa a consultar de 60
  em 60 segundos (configurável, mínimo 15 s) até voltar a ligar-se, para não
  perder nenhum talão durante a avaria. Volta ao silêncio assim que a ligação
  regressa.
- Se o tempo real não estiver configurado, o agente fica permanentemente nessa
  rede de segurança. Imprime bem, mas mantém a base de dados acordada —
  configure-o assim que possível.
- Se o posto *Pagamento* não estiver configurado, os recibos saem na impressora
  do bar (ou, na falta desta, na da cozinha), com um aviso nos logs.
- O `agent.cjs` traz um cliente WebSocket próprio, escrito à mão sobre `net`/
  `tls`, porque o Node 12 embutido no `.exe` para Windows 7 não tem `WebSocket`
  global e o pacote `ws` quebraria a promessa "zero dependências". O
  comportamento visível é o mesmo do agente Tauri.
- Cada ticket chega já pronto em bytes ESC/POS. Para impressoras de rede, o
  agente escreve-os diretamente no socket TCP (porta 9100), sem drivers nem
  rendering. Para impressoras USB/local, envia-os em modo RAW ao spooler do
  Windows (via `winspool.drv`), que os entrega tal-e-qual ao driver — sem
  reformatação do conteúdo do ticket.
- Cada impressão é confirmada ao servidor; as falhas aparecem no KDS e no
  histórico (Dashboard → Equipa → Impressão), com botão de reimpressão.
  Um talão reclamado mas nunca confirmado é reentregue.
- Se o servidor estiver inacessível, o agente tenta de novo com backoff;
  os tickets em fila são impressos assim que a ligação volta.

## Resolução de problemas

| Sintoma | Causa provável |
|---|---|
| `Token inválido` | Token regenerado no dashboard — atualize a configuração |
| `Poll de segurança ATIVO` sempre nos logs | Tempo real mal configurado, ou a firewall do restaurante bloqueia a saída em 443 |
| Talões demoram ~1 min a sair | O mesmo: o tempo real está em baixo e só a rede de segurança funciona |
| Recibos saem na cozinha ou no bar | Falta o posto *Pagamento* na configuração |
| `Timeout ao contactar a impressora` | IP errado, impressora desligada, ou porta 9100 fechada |
| `Não foi possível abrir a impressora "X"` | Nome errado em `printerName` — confirme em *Definições → Impressoras* do Windows (tem de ser exatamente igual) |
| Acentos errados no papel | Impressora sem CP1252 — diga-nos o modelo |
| Nada imprime, sem erros | Fornecedor ainda em "PrintNode" no dashboard |
