'use strict';

/**
 * Servidor HTTP do serviço de integração.
 *
 *  - GET  /health   healthcheck do PaaS (não exige credencial)
 *  - GET  /webhook  desafio de verificação da Meta
 *  - POST /webhook  respostas do paciente (assinatura obrigatória)
 *
 * Os jobs (polling e lembrete) sobem junto quando JOBS_ATIVOS=true.
 */

const express = require('express');

const { config } = require('./config');
const datas = require('./lib/datas');
const log = require('./lib/logger');
const auth = require('./clinicweb/auth');
const db = require('./db/db');
const webhook = require('./whatsapp/webhook');
const polling = require('./jobs/polling');
const lembrete = require('./jobs/lembrete');
const aviso = require('./jobs/aviso');
const campanhas = require('./jobs/campanhas');
const pacote = require('../package.json');

const app = express();

/**
 * O corpo BRUTO precisa ser guardado antes do parse: a assinatura da Meta é
 * calculada sobre os bytes originais, e reserializar o JSON muda o resultado.
 */
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      req.corpoBruto = buf;
    },
  }),
);

/**
 * GET /health — nunca devolve valor de credencial, só se ela está configurada.
 */
app.get('/health', (_req, res) => {
  let banco = null;
  try {
    banco = db.resumo();
  } catch (erro) {
    banco = { erro: erro.message };
  }

  const autenticacao = auth.estado();

  res.json({
    status: autenticacao.falhasConsecutivas > 0 ? 'degradado' : 'ok',
    versao: pacote.version,
    ambiente: {
      node_env: config.app.node_env,
      clinicweb: config.clinicweb.ambiente,
    },
    fuso: datas.FUSO,
    agora: datas.agora().toISO(),
    uptimeSegundos: Math.round(process.uptime()),
    configurado: {
      clinicweb: Boolean(
        config.clinicweb.usuario && config.clinicweb.senha && config.clinicweb.codEmpresa,
      ),
      meta: Boolean(config.meta.phoneNumberId && config.meta.token),
      webhook: Boolean(config.meta.webhookVerifyToken && config.meta.appSecret),
      modoSeco: config.whatsapp.modoSeco,
      escritaClinicweb: config.clinicweb.permitirEscrita,
      jobsAtivos: config.jobs.ativos,
      campanhasAtivas: config.jobs.campanhasAtivas,
    },
    autenticacao: {
      autenticado: autenticacao.autenticado,
      ultimoLoginEm: autenticacao.ultimoLoginEm,
      falhasConsecutivas: autenticacao.falhasConsecutivas,
    },
    banco,
  });
});

/** GET /webhook — desafio de verificação da Meta. */
app.get('/webhook', (req, res) => {
  const { ok, challenge } = webhook.verificarDesafio(req.query);
  if (!ok) return res.sendStatus(403);
  return res.status(200).send(challenge);
});

/**
 * POST /webhook — respostas do paciente.
 *
 * Processa antes de responder: a Meta reenvia quando não recebe 200, e a
 * deduplicação por `id` da mensagem já protege contra o processamento duplo.
 * Perder um evento é pior do que processá-lo duas vezes (e o banco impede o
 * segundo PATCH).
 */
app.post('/webhook', async (req, res) => {
  const assinatura = req.get('x-hub-signature-256');

  if (!webhook.assinaturaValida(req.corpoBruto ?? Buffer.from(''), assinatura)) {
    log.warn('webhook: assinatura inválida — requisição descartada', {
      alerta: true,
      temAssinatura: Boolean(assinatura),
      ip: req.ip,
    });
    return res.sendStatus(401);
  }

  try {
    const { processadas } = await webhook.processar(req.body);
    if (processadas > 0) log.info('webhook: payload processado', { processadas });
  } catch (erro) {
    // 200 mesmo assim: reentrega não conserta bug nosso, só gera ruído.
    log.error('webhook: erro ao processar payload', { alerta: true, erro: erro.message });
  }

  return res.sendStatus(200);
});

app.use((_req, res) => {
  res.status(404).json({ error: 'rota não encontrada' });
});

function iniciarJobs() {
  if (!config.jobs.ativos) {
    log.warn('jobs: DESLIGADOS (JOBS_ATIVOS=false) — nada será disparado sozinho');
    return;
  }
  if (!config.clinicweb.permitirEscrita) {
    log.warn(
      'jobs: LIGADOS, mas CLINICWEB_PERMITIR_ESCRITA=false — confirmações e ' +
        'cancelamentos NÃO serão gravados no ClinicWeb. Ligue a escrita em produção.',
      { alerta: true },
    );
  }
  if (!config.whatsapp.secretariaWhatsapp) {
    log.warn(
      'jobs: LIGADOS, mas SECRETARIA_WHATSAPP vazio \u2014 o redirecionamento a ' +
        'secretaria (catch-all, cancelamento e remarcacao) NAO sera enviado. ' +
        'Configure SECRETARIA_WHATSAPP.',
      { alerta: true },
    );
  }
  polling.iniciar();
  lembrete.iniciar();
  if (config.jobs.avisoAtivo) {
    aviso.iniciar();
  } else {
    log.info('aviso: DESLIGADO (AVISO_ATIVO=false) — rode scripts/semear-avisos.js antes de ligar');
  }
  campanhas.iniciar();
}

if (require.main === module) {
  db.conectar();

  app.listen(config.app.porta, () => {
    log.info('servidor no ar', {
      porta: config.app.porta,
      ambienteClinicweb: config.clinicweb.ambiente,
      fuso: datas.FUSO,
      modoSeco: config.whatsapp.modoSeco,
      escritaClinicweb: config.clinicweb.permitirEscrita,
    });
    iniciarJobs();
  });
}

module.exports = app;
module.exports.iniciarJobs = iniciarJobs;
