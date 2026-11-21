'use strict';

/**
 * Job de lembrete de VÉSPERA.
 *
 * Terceira mensagem do ciclo (docs/08): lembra da consulta de AMANHÃ, com
 * preparo e endereço, sem pedir confirmação. Sai num HORÁRIO FIXO na véspera
 * (LEMBRETE_VESPERA_HORA) e, ao contrário da confirmação, roda TODO dia —
 * inclusive domingo, para as consultas de segunda. Idempotência por tipo único
 * `lembrete` (um por agendamento).
 */

const cron = require('node-cron');

const { config } = require('../config');
const agendamentos = require('../clinicweb/agendamentos');
const datas = require('../lib/datas');
const log = require('../lib/logger');
const db = require('../db/db');
const templates = require('../whatsapp/templates');
const { disparar } = require('./disparo');

let tarefa = null;
let rodando = false;

/**
 * É véspera deste agendamento? (a consulta é AMANHÃ, no fuso da clínica)
 * Função pura — o coração testável do job. A HORA de envio é decidida pelo
 * gate do ciclo (LEMBRETE_VESPERA_HORA), não aqui.
 *
 * @param {object} agendamento com `dataHora` resolvida
 * @param {import('luxon').DateTime} [agora]
 */
function ehVespera(agendamento, agora = datas.agora()) {
  const dataHora = agendamento?.dataHora || datas.deDataHoraClinicweb(agendamento);
  if (!dataHora) return false;
  const amanha = agora.setZone(datas.FUSO).plus({ days: 1 }).toFormat('yyyy-MM-dd');
  return dataHora.setZone(datas.FUSO).toFormat('yyyy-MM-dd') === amanha;
}

/** O agendamento ainda merece lembrete? (confirmado merece; cancelado não) */
function elegivelParaLembrete(agendamento) {
  if (!agendamento) return { ok: false, motivo: 'vazio' };
  if (agendamento.ativo === 'N') return { ok: false, motivo: 'agendamento_inativo' };

  // Só lembra quem está EM ABERTO: Aguarda (1), Confirmado (2) ou "Não chegou"
  // (3) — que nesta clínica é o estado padrão de "não confirmado" (qualquer
  // data). Atendido, Em atendimento, Cancelado e motivos administrativos ficam de fora.
  const status = Number(agendamento.status ?? agendamento?.Status?.codAgendamentoStatus);
  const abertos = [
    config.clinicweb.status.aguardando,
    config.clinicweb.status.confirmado,
    config.clinicweb.status.naoChegou,
  ];
  if (!abertos.includes(status)) {
    return { ok: false, motivo: `status_${status}` };
  }

  return { ok: true, motivo: null };
}

/** O lembrete de véspera só precisa enxergar amanhã (+ folga). */
function diasDeBusca() {
  return 2;
}

async function ciclo() {
  const inicio = Date.now();
  // Chaves com o MESMO nome dos status de `disparar()` (ver polling.js).
  const contagem = {
    encontrados: 0,
    devidos: 0,
    enviado: 0,
    simulado: 0,
    ja_enviado: 0,
    invalido: 0,
    falhou: 0,
    erro: 0,
  };

  // O lembrete NÃO segue a trava de dias úteis: sai na véspera (inclusive
  // domingo p/ consulta de segunda), num horário fixo de VESPERA_HORA até ENVIO_HORA_FIM.
  if (!datas.dentroDoHorarioPermitido(config.jobs.lembreteVesperaHora, config.jobs.envioHoraFim)) {
    log.info('lembrete: fora da janela da véspera, ciclo pulado', {
      janela: `${config.jobs.lembreteVesperaHora}-${config.jobs.envioHoraFim}`,
    });
    return { ...contagem, pulado: 'fora_da_janela' };
  }

  db.reconciliarPendentes();

  let lista;
  try {
    lista = await agendamentos.listarProximos(diasDeBusca());
  } catch (erro) {
    log.error('lembrete: falha ao consultar a ClinicWeb', { alerta: true, erro: erro.message });
    return { ...contagem, pulado: 'erro_api' };
  }

  contagem.encontrados = lista.length;
  const agora = datas.agora();

  for (const agendamento of lista) {
    if (!elegivelParaLembrete(agendamento).ok) continue;
    if (!ehVespera(agendamento, agora)) continue;

    contagem.devidos += 1;
    try {
      const mensagem = templates.lembrete(agendamento);
      const { status } = await disparar(agendamento, mensagem);
      contagem[status] = (contagem[status] || 0) + 1;
    } catch (erro) {
      contagem.erro += 1;
      log.error('lembrete: erro ao processar agendamento', {
        codAgendamento: agendamento.codAgendamento,
        erro: erro.message,
      });
    }
  }

  log.info('lembrete: ciclo concluído', { ...contagem, duracaoMs: Date.now() - inicio });
  return contagem;
}

async function cicloProtegido() {
  if (rodando) {
    log.warn('lembrete: ciclo anterior ainda rodando, pulando esta execução');
    return;
  }
  rodando = true;
  try {
    await ciclo();
  } catch (erro) {
    log.error('lembrete: erro não tratado no ciclo', { alerta: true, erro: erro.message });
  } finally {
    rodando = false;
  }
}

function expressaoCron(minutos = config.jobs.lembreteIntervaloMin) {
  if (minutos < 1) return '* * * * *';
  if (minutos < 60) return `*/${minutos} * * * *`;
  const horas = Math.max(1, Math.round(minutos / 60));
  return horas >= 24 ? '0 9 * * *' : `0 */${horas} * * *`;
}

function iniciar() {
  if (tarefa) return tarefa;

  const expressao = expressaoCron();
  tarefa = cron.schedule(expressao, cicloProtegido, { timezone: datas.FUSO });

  log.info('lembrete: agendado', {
    cron: expressao,
    vesperaHora: config.jobs.lembreteVesperaHora,
    ateHora: config.jobs.envioHoraFim,
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

module.exports = {
  ciclo,
  cicloProtegido,
  iniciar,
  parar,
  ehVespera,
  elegivelParaLembrete,
  diasDeBusca,
  expressaoCron,
};
