# clinic-whatsapp-automation

> **EN —** Node.js service that connects a clinic's scheduling system (ClinicWeb/Linx API) to the official WhatsApp Business Cloud API. It sends appointment notices, confirmations and reminders, reads the patient's reply and updates the appointment status automatically, and runs consent-based (LGPD) birthday and recall campaigns. In production at a private clinic, it replaced the manual confirmation of **~35 appointments a day** by the front desk. Client data was removed from this public version.

Serviço que integra a agenda de um consultório (API do **ClinicWeb/Linx**) à **API oficial do WhatsApp Business (Meta Cloud API)**. Feito sob demanda para uma clínica particular. Ele substituiu a confirmação manual de **~35 consultas por dia** pela secretária.

Esta é a versão pública do projeto. Os dados do cliente, as credenciais e a documentação interna foram removidos, e os nomes e telefones foram trocados por fictícios.

## O que faz

| Fluxo | Como funciona |
|---|---|
| **Aviso de agendamento** | Um job diário varre os agendamentos dos próximos 2 anos, em blocos de 30 dias, e avisa o paciente de que a consulta foi marcada. Se a consulta for remarcada, ele avisa de novo. |
| **Confirmação** | A API da agenda não tem webhook, então o serviço consulta a agenda a cada 30 min e pede a confirmação com antecedência configurável. |
| **Lembrete de véspera** | Sai num horário fixo na véspera, com preparo e endereço, todos os dias (inclusive domingo, para as consultas de segunda). |
| **Leitura da resposta** | O webhook valida a assinatura da Meta, interpreta "sim", "não" e respostas ambíguas, e atualiza o status na agenda (`PATCH`). Respostas ambíguas vão para revisão humana. |
| **Encaminhamento** | Quando o paciente pede para falar com alguém, a mensagem é redirecionada ao WhatsApp da secretária, com cooldown. |
| **Campanhas (LGPD)** | Aniversário e recall (retorno após 6 meses) só saem para quem deu **opt-in pelo próprio WhatsApp**. Base legal, data e texto ficam registrados como evidência, e `SAIR` revoga na hora. |

## Decisões de engenharia

- **Idempotência:** o envio segue um caminho único (reservar → enviar → gravar). Um índice único `(codAgendamento, tipo)` no SQLite garante que nenhuma mensagem sai duas vezes, mesmo se o serviço reiniciar no meio de um ciclo.
- **Seguro por padrão:** cinco travas vêm ligadas (`WHATSAPP_MODO_SECO`, `CLINICWEB_PERMITIR_ESCRITA=false`, `JOBS_ATIVOS=false`, `CAMPANHAS_ATIVAS=false` e `WHATSAPP_NUMERO_TESTE`). Nada é enviado nem gravado na agenda real sem desligá-las de propósito.
- **Robustez na API externa:** reconcilia envios que ficaram pendentes após um crash, login JWT com renovação automática, retry com backoff exponencial e pausa entre blocos de 30 dias para não tomar `429`.
- **Telefones em E.164:** um normalizador trata cadastros inconsistentes (DDD no campo errado, número colado, fixo vs. celular).
- **Privacidade:** os scripts de descoberta mascaram nome, CPF, e-mail e telefone por padrão.

## Stack

Node.js 22+ · Express 5 · better-sqlite3 · node-cron · Luxon · Axios · `node:test` · ESLint · Docker (deploy no Railway)

## Arquitetura

```
ClinicWeb API ──(polling / cron)──► jobs ──► disparo (idempotente) ──► Meta Cloud API ──► paciente
      ▲                                           │                                         │
      └──────── PATCH status ◄── webhook (assinatura + interpretação) ◄────────────────────┘
                                        │
                                     SQLite (controle de envios, opt-in, respostas)
```

```
src/
├── server.js            Express: /health e /webhook
├── config.js            .env → config tipada, com validação por grupo
├── clinicweb/           auth JWT, agendamentos e pacientes
├── whatsapp/            cliente da Cloud API, templates, render e webhook
├── jobs/                aviso, polling, lembrete, campanhas e disparo
├── db/                  schema e acesso ao SQLite
└── lib/                 datas/fuso, telefone E.164, retry e logger
```

## Rodando localmente

```bash
npm install
cp .env.example .env      # as travas já vêm ligadas
npm test                  # 166 testes, sem credencial
npm run lint
npm start                 # GET http://localhost:3000/health
```

Para exercitar o fluxo de resposta ponta a ponta sem credencial nenhuma, preencha `META_APP_SECRET` e `META_WEBHOOK_VERIFY_TOKEN` com valores fictícios e rode:

```bash
node scripts/simular-webhook.js "sim"       # assina o payload como a Meta faz
node scripts/simular-webhook.js "talvez"    # ambíguo → revisão humana
node scripts/rodar-job.js polling           # um ciclo de job sem esperar o cron
```

## Autor

Guilherme Oliveira · [github.com/gpedrosouza](https://github.com/gpedrosouza)
