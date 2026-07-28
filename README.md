# Qomanda Print Agent

Agente de impressão **self-host e gratuito** — a alternativa ao PrintNode.
Corre no PC do restaurante e imprime os tickets (cozinha, bar, pagamento, ...)
diretamente nas impressoras térmicas, de rede ou USB, sem serviços cloud pagos.

Este repositório tem **dois agentes**:

- **App Tauri** (`src/`, `src-tauri/`) — interface gráfica, suporte a
  impressoras de rede e USB, **tempo real por WebSocket**. Para Windows 10/11.
  É o agente recomendado.
- **`agent.cjs`** (na raiz) — sem dependências, com suporte a impressoras de
  rede e USB e **interface no navegador**. Para PCs mais antigos (Windows 7
  SP1, 8, 8.1) onde a app Tauri/WebView2 não é fiável.

Os dois usam o mesmo modelo de tempo real e o mesmo `config.json`, e os dois
têm formulário de configuração, teste de impressora e registo em direto — só
muda a moldura (janela nativa contra separador do navegador).

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
2. Copie o `.exe` correspondente à arquitetura do PC (gerar com
   `npm run agent:build:win7`, ver secção seguinte) para o PC do restaurante,
   ex: `C:\qomanda\`:
   - **64 bits**: `dist-legacy-agent/qomanda-print-agent-win7-x64.exe`
   - **32 bits**: `dist-legacy-agent/qomanda-print-agent-win7-x86.exe`

   Na dúvida, veja em *Painel de Controlo → Sistema* → "Tipo de sistema". O
   `.exe` de 32 bits também corre em Windows de 64 bits (via WOW64), por isso
   é a escolha segura se não conseguir confirmar.
3. Corra o `.exe` (duplo clique). O agente abre sozinho o navegador na sua
   interface, em `http://127.0.0.1:7654`.
4. Na página: cole o **token**, escolha as impressoras por posto — as
   instaladas no Windows aparecem numa lista — e carregue em **Testar** para
   confirmar que sai papel. **Guardar** aplica tudo de imediato, sem
   reiniciar o agente.

Não é preciso editar `config.json` à mão: a página grava-o. O ficheiro
continua a poder ser preenchido manualmente se preferir (ver
`config.example.json`), nomeadamente para instalações em série.

### A interface

Servida pelo próprio agente, só em `127.0.0.1` — nunca fica exposta à rede do
restaurante, porque a página mostra o token do agente. O endereço leva uma
chave de sessão gerada a cada arranque (`?k=...`), o que impede outra página
aberta no navegador de falar com o agente; é por isso que só funciona pelo
endereço que o agente abre ou escreve na consola.

- Porta ocupada? Defina outra com `"uiPort": 7655` no `config.json`.
- A correr como serviço, para não abrir o navegador: `"openBrowser": false`
  (ou a variável de ambiente `QOMANDA_NO_BROWSER=1`). A interface continua
  acessível pelo endereço.
- A página é escrita em ES5 e usa `XMLHttpRequest`, para funcionar no Internet
  Explorer 11 — o navegador por omissão de um Windows 7 acabado de instalar.
  Não lhe acrescente `fetch`, `const` ou arrow functions sem testar lá.

## Gerar os `.exe` (para quem faz o build)

Cada `.exe` embute um runtime Node.js 12 — a última versão com suporte oficial
a Windows 7 — para não depender do que estiver instalado no PC do restaurante.

```bash
npm install
npm run agent:build:win7          # gera as duas arquiteturas
```

Produz `qomanda-print-agent-win7-x64.exe` (~29 MB) e
`qomanda-print-agent-win7-x86.exe` (~25 MB) em `dist-legacy-agent/`.
Distribua o ficheiro certo junto com `config.example.json`.

As duas arquiteturas usam empacotadores diferentes, e não por gosto: o `pkg`
**não consegue** gerar 32 bits, porque o projeto `pkg-fetch` nunca publicou
binários base `win-x86` — pedir-lhe `node12-win-x86` faz com que tente
compilar o Node a partir do código-fonte, o que exige o Visual Studio e falha
em qualquer máquina normal. O `nexe` publica um base `windows-x86-12.18.2`
pré-compilado, e é esse que gera o 32 bits.

```bash
npm run agent:build:win7:x64      # pkg
npm run agent:build:win7:x86      # nexe
```

## Instalação (Windows 10/11 com Node.js já instalado)

Alternativa ao `.exe`, se preferir correr o script diretamente:

```bash
node agent.cjs caminho/para/config.json
```

## Arranque automático (Windows)

Crie um atalho na pasta Arranque (`shell:startup`) com o alvo:

```
C:\qomanda\qomanda-print-agent-win7-x64.exe
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

A barra de estado no topo diz se os talões estão a chegar: *Tempo real ligado*
(verde) ou *Sem ligação ao tempo real* (vermelho — nada imprime).

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
- **Não há poll nenhum, nem sequer de recurso.** O tempo real é o único caminho
  até à fila. Se o WebSocket cair, o agente reconecta-se com backoff
  exponencial (2 s, 4 s, ... até 60 s) e, enquanto isso durar, **não sai nenhum
  talão**. Não se perde nada: ao voltar a subscrever, o agente recolhe tudo o
  que se acumulou, e um talão reclamado mas nunca confirmado é reentregue pelo
  servidor. Os talões atrasam-se, não desaparecem.
- Com a configuração incompleta (sem token, sem impressora, sem tempo real) o
  agente **arranca à mesma e abre a interface**, mas não liga ao tempo real e
  diz o que falta. Antes terminava com uma mensagem na consola, o que no
  Windows 7 era um piscar de olhos e nada mais.
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

## Aplicação de ambiente de trabalho (Windows)

Além do script `agent.mjs`, este repositório inclui uma app Tauri (bandeja do
sistema + interface de configuração) em `src-tauri/`.

O workflow `.github/workflows/build.yml` compila instaladores `.msi`/`.exe`
para **64-bit (x86_64)** e **32-bit (i686)** a cada tag `v*` (anexados à
release) ou manualmente via "Run workflow". Para compilar localmente:

```bash
rustup target add i686-pc-windows-msvc   # ou x86_64-pc-windows-msvc
bun install
bun run tauri build -- --target i686-pc-windows-msvc
```

Os instaladores ficam em
`src-tauri/target/<target>/release/bundle/{msi,nsis}/`.

## Resolução de problemas

| Sintoma | Causa provável |
|---|---|
| `Token inválido` | Token regenerado no dashboard — atualize a configuração |
| `Tempo real em baixo` sempre nos logs, nada imprime | Tempo real mal configurado, ou a firewall do restaurante bloqueia a saída em 443 |
| Talões saem todos de uma vez, com atraso | A ligação de tempo real esteve em baixo e recuperou — a recolha ao reconectar despejou a fila acumulada |
| Recibos saem na cozinha ou no bar | Falta o posto *Pagamento* na configuração |
| `Timeout ao contactar a impressora` | IP errado, impressora desligada, ou porta 9100 fechada |
| `Não foi possível abrir a impressora "X"` | Nome errado em `printerName` — confirme em *Definições → Impressoras* do Windows (tem de ser exatamente igual) |
| Acentos errados no papel | Impressora sem CP1252 — diga-nos o modelo |
| Nada imprime, sem erros | Fornecedor ainda em "PrintNode" no dashboard |
