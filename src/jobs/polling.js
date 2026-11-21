'use strict';

/**
 * Job de polling — pedido de confirmação (o aviso de agendamento realizado
 * é do job diário `aviso.js`, que varre uma janela longa uma vez por dia).
 *
 * A API da ClinicWeb não tem webhook (docs/03), então a única forma de saber
 * de um agendamento novo é perguntar de tempos em tempos. A cada ciclo:
 *
 *   1. reconcilia envios que ficaram pendentes de um crash anterior;
 *   2. busca os agendamentos dos próximos N dias (janela no fuso da clínica);
 *   3. decide, por agendamento, entre AVISO de agendamento realizado (ainda
 *      longe) e PEDIDO de confirmação (dentro da janela CONFIRMACAO_HORAS);
 *   4. dispara — sempre passando por `disparo.js`, que checa o banco antes.
 *
 * O ciclo NUNCA lança: uma falha em um agendamento não pode derrubar os outros
 * nem matar o cron.
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
 * O agendamento foi remarcado DEPOIS de já termos enviado a confirmação?
 * O ClinicWeb reaproveita o codAgendamento ao remarcar (muda só a data) e pode
 * manter o status em "confirmado". Comparamos (precisão de minuto) a data atual
 * com a data para a qual pedimos confirmação. Sem registro anterior, não há como
 * afirmar que foi remarcação nossa — então não reconfirma.
 */
function remarcadoAposConfirmacao(dataHora, dataConfirmada) {
  if (!dataConfirmada) return false;
  const ateMinuto = (v) => (v ? String(v).slice(0, 16) : null);
  return ateMinuto(dataHora.toISO()) !== ateMinuto(dataConfirmada);
}

/**
 * Qual mensagem este agendamento deve receber AGORA?
 * Função pura — é a regra de negócio testável do job.
 *
 * - Faltam mais de CONFIRMACAO_HORAS: aviso de agendamento realizado
 *   (informativo, a secretária marcou) — não pede ação.
 * - Dentro da janela de confirmação: pedido de confirmação, salvo se já
 *   confirmado.
 * A idempotência (uma vez por tipo) fica no banco, via disparo.js — por isso
 * a confirmação não tem limite inferior de janela: assim que o agendamento
 * entra em CONFIRMACAO_HORAS ela sai, cobrindo também marcações de última hora.
 *
 * @param {object} agendamento com `dataHora` resolvida
 * @param {import('luxon').DateTime} [agora]
 * @param {{dataConfirmada?: string|null, comAviso?: boolean}} [opcoes]
 *   dataConfirmada: data para a qual já pedimos confirmação;
 *   comAviso: decidir também o AVISO (só o job diário de aviso passa true —
 *   o polling de 30 min cuida apenas da confirmação).
 * @returns {{ok: boolean, tipo?: string, motivo?: string|null}}
 */
function decidir(agendamento, agora = datas.agora(), opcoes = {}) {
  if (!agendamento) return { ok: false, motivo: 'vazio' };
  if (agendamento.ativo === 'N') return { ok: false, motivo: 'agendamento_inativo' };

  const dataHora = agendamento.dataHora || datas.deDataHoraClinicweb(agendamento);
  if (!dataHora) return { ok: false, motivo: 'data_invalida' };

  const restante = datas.horasAte(dataHora, agora);
  if (restante <= 0) return { ok: false, motivo: 'ja_passou' };

  const status = Number(agendamento.status ?? agendamento?.Status?.codAgendamentoStatus);

  // Já confirmado: nada a fazer (nem aviso, nem novo pedido) — EXCETO se foi
  // remarcado depois da confirmação. Aí a confirmação antiga não vale para a
  // nova data e ele segue o fluxo normal abaixo para reconfirmar.
  const remarcado = remarcadoAposConfirmacao(dataHora, opcoes.dataConfirmada);
  if (status === config.clinicweb.status.confirmado && !remarcado) {
    return { ok: false, motivo: 'ja_confirmado' };
  }
  // Recebem mensagem os agendamentos EM ABERTO: Aguarda atendimento (1) e
  // "Não chegou" (3) — que nesta clínica é o estado PADRÃO de "não confirmado"
  // (qualquer data, não só o dia), não uma falta —, além de um confirmado (2)
  // que foi remarcado. Atendido, Em atendimento, Triagem, Cancelado e motivos
  // administrativos ficam de fora.
  if (status !== config.clinicweb.status.aguardando
      && status !== config.clinicweb.status.confirmado
      && status !== config.clinicweb.status.naoChegou) {
    return { ok: false, motivo: `status_${status}` };
  }

  // Dia em que a confirmação deve sair: ANTECEDENCIA dias antes da consulta,
  // antecipado para a sexta se cair no fim de semana (consulta de segunda →
  // confirma na sexta, nunca no sábado/domingo).
  const diaConfirmacao = datas.recuarParaDiaUtil(
    dataHora.startOf('day').minus({ days: config.jobs.confirmacaoAntecedenciaDias }),
  );
  if (agora.startOf('day') < diaConfirmacao) {
    // Ainda não chegou o dia de confirmar. Quem manda o aviso "agendamento
    // realizado" é o job diário (jobs/aviso.js), que chama com comAviso=true.
    if (opcoes.comAviso === true) {
      return { ok: true, tipo: templates.TIPO_AGENDAMENTO, motivo: null };
    }
    return { ok: false, motivo: 'aguardando_dia_confirmacao' };
  }
  // Chegou (ou passou) o dia de confirmar.
  return { ok: true, tipo: templates.TIPO_CONFIRMACAO, motivo: null };
}

/**
 * Data para a qual já pedimos confirmação — só importa quando o status está
 * "confirmado" (para detectar remarcação depois da confirmação).
 */
function dataConfirmadaDe(agendamento) {
  const statusAtual = Number(agendamento.status ?? agendamento?.Status?.codAgendamentoStatus);
  if (statusAtual === config.clinicweb.status.confirmado) {
    const reg = db.buscarPorAgendamento(agendamento.codAgendamento, templates.TIPO_CONFIRMACAO);
    return reg ? reg.dataAgendamento : null;
  }
  return null;
}

/**
 * Roda um ciclo completo. Pode ser chamado à mão (script de teste).
 * @returns {Promise<object>} contadores do ciclo
 */
async function ciclo() {
  const inicio = Date.now();
  // As chaves abaixo têm o MESMO nome dos status devolvidos por `disparar()`,
  // senão o contador incrementado não é o que aparece no log.
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
    log.info('polling: fora da janela de envio, ciclo pulado', {
      janela: `${config.jobs.envioHoraInicio}-${config.jobs.envioHoraFim}`,
    });
    return { ...contagem, pulado: 'fora_da_janela' };
  }

  db.reconciliarPendentes();

  let lista;
  try {
    lista = await agendamentos.listarProximos(config.jobs.pollingJanelaDias);
  } catch (erro) {
    log.error('polling: falha ao consultar a ClinicWeb', { alerta: true, erro: erro.message });
    return { ...contagem, pulado: 'erro_api' };
  }

  contagem.encontrados = lista.length;
  const agora = datas.agora();

  for (const agendamento of lista) {
    // Remarcação após confirmação: o decisor precisa saber para qual data já
    // pedimos confirmação (só relevante quando o status está "confirmado").
    const decisao = decidir(agendamento, agora, { dataConfirmada: dataConfirmadaDe(agendamento) });

    if (!decisao.ok) {
      contagem.inelegiveis[decisao.motivo] = (contagem.inelegiveis[decisao.motivo] || 0) + 1;
      continue;
    }

    try {
      const mensagem = templates.confirmacao(agendamento);
      contagem.porTipo[decisao.tipo] = (contagem.porTipo[decisao.tipo] || 0) + 1;
      const { status } = await disparar(agendamento, mensagem);
      contagem[status] = (contagem[status] || 0) + 1;
    } catch (erro) {
      contagem.erro += 1;
      log.error('polling: erro ao processar agendamento', {
        codAgendamento: agendamento.codAgendamento,
        erro: erro.message,
      });
    }
  }

  log.info('polling: ciclo concluído', { ...contagem, duracaoMs: Date.now() - inicio });
  return contagem;
}

/** Evita ciclos sobrepostos se um deles demorar mais que o intervalo. */
async function cicloProtegido() {
  if (rodando) {
    log.warn('polling: ciclo anterior ainda rodando, pulando esta execução');
    return;
  }
  rodando = true;
  try {
    await ciclo();
  } catch (erro) {
    log.error('polling: erro não tratado no ciclo', { alerta: true, erro: erro.message });
  } finally {
    rodando = false;
  }
}

/** Converte o intervalo em minutos numa expressão cron válida. */
function expressaoCron(minutos = config.jobs.pollingIntervaloMin) {
  if (minutos < 1) return '* * * * *';
  if (minutos < 60) return `*/${minutos} * * * *`;
  const horas = Math.max(1, Math.round(minutos / 60));
  return horas >= 24 ? '0 8 * * *' : `0 */${horas} * * *`;
}

function iniciar() {
  if (tarefa) return tarefa;

  const expressao = expressaoCron();
  tarefa = cron.schedule(expressao, cicloProtegido, { timezone: datas.FUSO });

  log.info('polling: agendado', {
    cron: expressao,
    intervaloMin: config.jobs.pollingIntervaloMin,
    janelaDias: config.jobs.pollingJanelaDias,
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

module.exports = { ciclo, cicloProtegido, iniciar, parar, decidir, dataConfirmadaDe, expressaoCron };
