'use strict';

/**
 * Job diário de AVISO — "agendamento realizado".
 *
 * Primeira mensagem do ciclo (docs/08): avisa o paciente de que a consulta foi
 * marcada, sem pedir confirmação. Como toda consulta marcada dentro de
 * AVISO_JANELA_DIAS (padrão 730 = 2 anos) precisa ser avisada, este job varre
 * a janela longa UMA vez por dia (AVISO_CRON) — em blocos de 30 dias, para não
 * estourar a paginação da ClinicWeb — e deixa o polling de 30 min só com a
 * confirmação (janela curta).
 *
 * Só avisa quem ainda NÃO chegou ao dia da confirmação (mesma regra de
 * `polling.decidir` com comAviso=true). Idempotência: uma vez por
 * (codAgendamento, 'agendamento_realizado'); remarcação reabre o envio para a
 * nova data. Retroativo: rodar scripts/semear-avisos.js ANTES de ligar
 * AVISO_ATIVO, para o backlog ficar marcado como já avisado.
 */

const cron = require('node-cron');

const { config } = require('../config');
const agendamentos = require('../clinicweb/agendamentos');
const datas = require('../lib/datas');
const log = require('../lib/logger');
const db = require('../db/db');
const templates = require('../whatsapp/templates');
const polling = require('./polling');
const { disparar } = require('./disparo');

let tarefa = null;
let rodando = false;

async function ciclo() {
  const inicio = Date.now();
  // Chaves com o MESMO nome dos status de `disparar()` (ver polling.js).
  const contagem = {
    encontrados: 0,
    enviado: 0,
    simulado: 0,
    ja_enviado: 0,
    invalido: 0,
    falhou: 0,
    erro: 0,
    inelegiveis: {},
    porTipo: {},
  };

  if (!datas.dentroDaJanelaDeEnvio(config.jobs.envioHoraInicio, config.jobs.envioHoraFim, config.jobs.enviarSomenteDiasUteis)) {
    log.info('aviso: fora da janela de envio, ciclo pulado', {
      janela: `${config.jobs.envioHoraInicio}-${config.jobs.envioHoraFim}`,
    });
    return { ...contagem, pulado: 'fora_da_janela' };
  }

  db.reconciliarPendentes();

  let lista;
  try {
    lista = await agendamentos.listarProximosEmBlocos(config.jobs.avisoJanelaDias);
  } catch (erro) {
    log.error('aviso: falha ao consultar a ClinicWeb', { alerta: true, erro: erro.message });
    return { ...contagem, pulado: 'erro_api' };
  }

  contagem.encontrados = lista.length;
  const agora = datas.agora();

  for (const agendamento of lista) {
    const decisao = polling.decidir(agendamento, agora, {
      dataConfirmada: polling.dataConfirmadaDe(agendamento),
      comAviso: true,
    });

    // Confirmação é do polling: aqui só sai o aviso.
    if (!decisao.ok || decisao.tipo !== templates.TIPO_AGENDAMENTO) {
      const motivo = decisao.ok ? 'dia_de_confirmacao' : decisao.motivo;
      contagem.inelegiveis[motivo] = (contagem.inelegiveis[motivo] || 0) + 1;
      continue;
    }

    try {
      contagem.porTipo[decisao.tipo] = (contagem.porTipo[decisao.tipo] || 0) + 1;
      const { status } = await disparar(agendamento, templates.agendamentoRealizado(agendamento));
      contagem[status] = (contagem[status] || 0) + 1;
    } catch (erro) {
      contagem.erro += 1;
      log.error('aviso: erro ao processar agendamento', {
        codAgendamento: agendamento.codAgendamento,
        erro: erro.message,
      });
    }
  }

  log.info('aviso: ciclo concluído', { ...contagem, duracaoMs: Date.now() - inicio });
  return contagem;
}

async function cicloProtegido() {
  if (rodando) {
    log.warn('aviso: ciclo anterior ainda rodando, pulando esta execução');
    return;
  }
  rodando = true;
  try {
    await ciclo();
  } catch (erro) {
    log.error('aviso: erro não tratado no ciclo', { alerta: true, erro: erro.message });
  } finally {
    rodando = false;
  }
}

function iniciar() {
  if (tarefa) return tarefa;

  tarefa = cron.schedule(config.jobs.avisoCron, cicloProtegido, { timezone: datas.FUSO });

  log.info('aviso: agendado', {
    cron: config.jobs.avisoCron,
    janelaDias: config.jobs.avisoJanelaDias,
    fuso: datas.FUSO,
  });

  return tarefa;
}

function parar() {
  if (tarefa) {
    tarefa.stop();
    tarefa = null;
  }
}

module.exports = { ciclo, cicloProtegido, iniciar, parar };
