# Qomanda Print Agent

Agente de impressão **self-host e gratuito** — a alternativa ao PrintNode.
Corre no PC do restaurante e imprime os talões de cozinha/bar e os recibos de
cliente diretamente nas impressoras térmicas de rede, sem serviços cloud pagos.

## Requisitos

- **Node.js 22 ou superior** no PC do restaurante.
  A versão 22 é obrigatória: o agente usa o `WebSocket` nativo do Node, e é isso
  que lhe permite continuar sem **nenhuma** dependência npm para instalar.
- Impressoras térmicas ESC/POS **de rede** (Epson TM, e compatíveis) acessíveis
  na porta 9100 (o standard "RAW/JetDirect" de todas as térmicas de restauração)
- O PC e as impressoras na mesma rede local
- Saída para a Internet na porta 443 — o agente abre uma ligação de saída para o
  servidor de tempo real; não é preciso abrir nada no router

## Instalação

1. No dashboard Qomanda: **Equipa → Impressão** — escolha o fornecedor
   *Agente local* e copie o **token do agente**.
2. Copie esta pasta (`print-agent/`) para o PC do restaurante.
3. Copie `config.example.json` para `config.json` e preencha:
   - `serverUrl` — o endereço da sua instância Qomanda
   - `token` — o token copiado no passo 1
   - `realtimeUrl` / `realtimeKey` — o servidor de tempo real e a sua chave
     pública. **Sem eles o agente arranca à mesma, mas em modo degradado** —
     ver "Como funciona".
   - `printers` — o IP de cada impressora por posto. O IP imprime-se geralmente
     com o auto-teste da impressora (desligar, manter FEED premido, ligar).
4. Arranque:

```bash
node agent.mjs
```

### Postos de impressão

| Posto | O que imprime |
|---|---|
| `kitchen` | Talões de cozinha e anulações do posto de cozinha |
| `bar` | Talões de bar e anulações do posto de bar |
| `payment` | Recibo do cliente e documento fiscal (Vendus / Fact) |

Configure pelo menos um. Se não definir `payment`, os recibos saem na impressora
do bar (ou, na falta desta, na da cozinha) e o agente avisa nos logs — funciona,
mas o normal é o recibo sair no balcão, por isso vale a pena configurá-lo.

## Arranque automático (Windows)

Crie um atalho na pasta Arranque (`shell:startup`) com o alvo:

```
node C:\qomanda\print-agent\agent.mjs C:\qomanda\print-agent\config.json
```

Ou registe como serviço com [NSSM](https://nssm.cc/): `nssm install QomandaPrintAgent`.

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
  buscar o talão pela API autenticada. Cada impressão é confirmada ao servidor;
  as falhas aparecem no KDS e no histórico (Dashboard → Equipa → Impressão), com
  botão de reimpressão. Um talão reclamado mas nunca confirmado é reentregue.
- Cada talão chega já pronto em bytes ESC/POS — o agente só os escreve no socket
  TCP da impressora. Sem drivers, sem rendering.
- **Rede de segurança**: se o WebSocket cair, o agente passa a consultar de 60 em
  60 segundos até voltar a ligar-se, para não perder nenhum talão durante a
  avaria. Volta ao silêncio assim que a ligação regressa.
- Se `realtimeUrl`/`realtimeKey` não estiverem configurados, o agente fica
  permanentemente nessa rede de segurança. Imprime bem, mas mantém a base de
  dados acordada — configure o tempo real assim que possível.

## Resolução de problemas

| Sintoma | Causa provável |
|---|---|
| `Node.js 22 ou superior é obrigatório` | Node antigo — instale a versão LTS em [nodejs.org](https://nodejs.org) |
| `Token inválido` | Token regenerado no dashboard — atualize o `config.json` |
| `Timeout ao contactar a impressora` | IP errado, impressora desligada, ou porta 9100 fechada |
| `Poll de segurança ATIVO` sempre nos logs | `realtimeUrl`/`realtimeKey` errados, ou a firewall do restaurante bloqueia a saída em 443 |
| Talões demoram ~1 min a sair | O mesmo: o tempo real está em baixo e só a rede de segurança funciona |
| Recibos saem na cozinha | Falta o posto `payment` em `printers` — ver "Postos de impressão" |
| Acentos errados no papel | Impressora sem CP1252 — diga-nos o modelo |
| Nada imprime, sem erros | Fornecedor ainda em "PrintNode" no dashboard |
