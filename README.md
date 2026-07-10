# Qomanda Print Agent

Agente de impressão **self-host e gratuito** — a alternativa ao PrintNode.
Corre no PC do restaurante e imprime os tickets de cozinha/bar diretamente
nas impressoras térmicas de rede, sem serviços cloud pagos.

## Requisitos

- Node.js 18 ou superior no PC do restaurante
- Impressoras térmicas ESC/POS **de rede** (Epson TM, e compatíveis) acessíveis
  na porta 9100 (o standard "RAW/JetDirect" de todas as térmicas de restauração)
- O PC e as impressoras na mesma rede local

## Instalação

1. No dashboard Qomanda: **Equipa → Impressão** — escolha o fornecedor
   *Agente local* e copie o **token do agente**.
2. Copie esta pasta (`print-agent/`) para o PC do restaurante.
3. Copie `config.example.json` para `config.json` e preencha:
   - `serverUrl` — o endereço da sua instância Qomanda
   - `token` — o token copiado no passo 1
   - `printers` — o IP de cada impressora por posto (`kitchen`, `bar`).
     O IP imprime-se geralmente com o auto-teste da impressora
     (desligar, manter FEED premido, ligar).
4. Arranque:

```bash
node agent.mjs
```

## Arranque automático (Windows)

Crie um atalho na pasta Arranque (`shell:startup`) com o alvo:

```
node C:\qomanda\print-agent\agent.mjs C:\qomanda\print-agent\config.json
```

Ou registe como serviço com [NSSM](https://nssm.cc/): `nssm install QomandaPrintAgent`.

## Como funciona

- O agente faz poll ao servidor a cada 3 s (configurável).
- Cada ticket chega já pronto em bytes ESC/POS — o agente só os escreve
  no socket TCP da impressora. Sem drivers, sem rendering.
- Cada impressão é confirmada ao servidor; as falhas aparecem no KDS e no
  histórico (Dashboard → Equipa → Impressão), com botão de reimpressão.
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
| `Token inválido` | Token regenerado no dashboard — atualize o `config.json` |
| `Timeout ao contactar a impressora` | IP errado, impressora desligada, ou porta 9100 fechada |
| Acentos errados no papel | Impressora sem CP1252 — diga-nos o modelo |
| Nada imprime, sem erros | Fornecedor ainda em "PrintNode" no dashboard |
