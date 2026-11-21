'use strict';

/**
 * Job diário das campanhas de MARKETING: aniversário e retorno (recall).
 *
 * Diferença essencial em relação a confirmação/lembrete: aquelas são
 * Utilidade — comunicação sobre um agendamento que o paciente marcou. Estas
 * são Marketing, e por isso:
 *
 *   - só saem para quem tem **opt-in ativo** (Meta + LGPD);
 *   - qualquer pedido de "SAIR" revoga o consentimento na hora (webhook.js);
 *   - a idempotência é por competência, para não virar spam mensal;
 *   - há um teto diário (`CAMPANHA_MAX_POR_DIA`) — se a regra de recall pegar
 *     a base inteira por engano, o estrago é limitado a algumas dezenas.
 *
 * Roda 1x/dia (`CAMPANHAS_CRON`, padrão 09:00 no fuso da clínica).
 */

const cron = require('node-cron');

const { config } = require('../config');
const pacientesApi = require('../clinicweb/pacientes');
const cliente = require('../whatsapp/client');
const templates = require('../whatsapp/templates');
const datas = require('../lib/datas');
const telefone = require('../lib/telefone');
const log = require('../lib/logger');
const db = require('../db/db');

let tarefa = null;
let rodando = false;

/**
 * Envia uma campanha, com a mesma disciplina do `jobs/disparo.js`:
 * reservar → enviar → gravar.
 *
 * @returns {Promise<'enviado'|'simulado'|'ja_enviado'|'sem_optin'|'invalido'|'falhou'|'erro'>}
 */
async function dispararCampanha({ codPaciente, nome, telefone: partes, tipo, competencia }) {
  const contexto = { codPaciente, tipo, competencia };

  // 1. OPT-IN — a checagem que não pode faltar em mensagem de Marketing.
  if (!db.temOptInAtivo(codPaciente)) {
    log.debug('campanhas: paciente sem opt-in ativo, pulado', contexto);
    return 'sem_optin';
  }

  const resolvido = telefone.paraE164(partes);

  // 2. RESERVA — índice único (codPaciente, tipo, competencia).
  const reserva = db.reservarCampanha({
    codPaciente,
    tipo,
    competencia,
    telefone: resolvido.ok ? resolvido.numero : null,
  });

  if (!reserva) {
    log.debug('campanhas: já registrado nesta competência', contexto);
    return 'ja_enviado';
  }

  if (!resolvido.ok) {
    db.marcarCampanhaFalha(reserva.id, `telefone_${resolvido.motivo}`, { definitivo: true });
    log.warn('campanhas: paciente sem telefone utilizável', { ...contexto, motivo: resolvido.motivo });
    return 'invalido';
  }

  // 3. ENVIO
  try {
    const mensagem = tipo === templates.TIPO_ANIVERSARIO
      ? templates.aniversario({ nome })
      : templates.retorno({ nome });

    const resultado = await cliente.enviarTemplate(resolvido.numero, mensagem, { contexto });

    if (resultado.ok) {
      db.marcarCampanhaEnviada(reserva.id, {
        idMensagemMeta: resultado.idMensagemMeta,
        simulado: resultado.simulado,
        telefone: resolvido.numero,
      });
      return resultado.simulado ? 'simulado' : 'enviado';
    }

    db.marcarCampanhaFalha(reserva.id, resultado.erro, { definitivo: Boolean(resultado.definitivo) });
    return resultado.definitivo ? 'invalido' : 'falhou';
  } catch (erro) {
    db.marcarCampanhaFalha(reserva.id, erro.message);
    log.error('campanhas: erro inesperado no envio', { ...contexto, erro: erro.message });
    return 'erro';
  }
}

/**
 * Campanha de aniversário: quem faz aniversário HOJE, no fuso da clínica.
 *
 * A competência é o `YYYY-MM` do disparo — como o aniversário só cai em um
 * mês do ano, isso equivale a "no máximo um por ano".
 */
async function aniversariantes(agora = datas.agora()) {
  const contagem = { candidatos: 0 };

  let lista;
  try {
    lista = await pacientesApi.aniversariantesDe(agora);
  } catch (erro) {
    // Se `query` for mesmo obrigatório no GET /pacientes (lacuna aberta em
    // docs/03), é aqui que isso aparece — e a campanha precisa do plano B.
    log.error('campanhas: falha ao buscar aniversariantes', {
      alerta: true,
      dica: 'se o erro citar "query", ver a lacuna de GET /pacientes em docs/03',
      erro: erro.message,
    });
    return { ...contagem, pulado: 'erro_api' };
  }

  const competencia = datas.competencia(agora);
  contagem.candidatos = lista.length;

  for (const paciente of lista.slice(0, config.jobs.campanhaMaxPorDia)) {
    if (paciente.ativo === 'N' || paciente.vivo === 0) continue;

    const codPaciente = pacientesApi.codPacienteDe(paciente);
    if (codPaciente === null) continue;

    const status = await dispararCampanha({
      codPaciente,
      nome: paciente.nome,
      telefone: {
        ddi: paciente.ddiCelular,
        ddd: paciente.dddCelular,
        tel: paciente.telCelular,
      },
      tipo: templates.TIPO_ANIVERSARIO,
      competencia,
    });

    contagem[status] = (contagem[status] || 0) + 1;
  }

  return contagem;
}

/**
 * Campanha de retorno (recall) — regra confirmada na Sessão 4.
 *
 * A competência é o `YYYY-MM` do ÚLTIMO AGENDAMENTO, não do disparo: a janela
 * de recall desliza todo dia e atravessa a virada de mês, então usar o mês do
 * disparo deixaria o mesmo paciente receber dois convites seguidos.
 */
async function recall() {
  const contagem = { candidatos: 0 };

  let lista;
  try {
    lista = await pacientesApi.paraRecall();
  } catch (erro) {
    log.error('campanhas: falha ao apurar recall', { alerta: true, erro: erro.message });
    return { ...contagem, pulado: 'erro_api' };
  }

  contagem.candidatos = lista.length;

  if (lista.length > config.jobs.campanhaMaxPorDia) {
    log.warn('campanhas: recall acima do teto diário, sobra fica para amanhã', {
      candidatos: lista.length,
      teto: config.jobs.campanhaMaxPorDia,
    });
  }

  for (const paciente of lista.slice(0, config.jobs.campanhaMaxPorDia)) {
    const status = await dispararCampanha({
      codPaciente: paciente.codPaciente,
      nome: paciente.nome,
      telefone: paciente.telefone,
      tipo: templates.TIPO_RETORNO,
      competencia: datas.competencia(paciente.ultimoAgendamento),
    });

    contagem[status] = (contagem[status] || 0) + 1;
  }

  return contagem;
}

/** Um ciclo diário completo. */
async function ciclo() {
  const inicio = Date.now();

  if (!config.jobs.campanhasAtivas) {
    log.warn('campanhas: DESLIGADAS (CAMPANHAS_ATIVAS=false)');
    return { pulado: 'desligadas' };
  }

  if (!datas.dentroDaJanelaDeEnvio(config.jobs.envioHoraInicio, config.jobs.envioHoraFim, config.jobs.enviarSomenteDiasUteis)) {
    log.info('campanhas: fora da janela de envio, ciclo pulado');
    return { pulado: 'fora_da_janela' };
  }

  db.reconciliarCampanhasPendentes();

  const resultado = {
    aniversario: await aniversariantes(),
    retorno: await recall(),
    duracaoMs: 0,
  };
  resultado.duracaoMs = Date.now() - inicio;

  log.info('campanhas: ciclo concluído', resultado);
  return resultado;
}

async function cicloProtegido() {
  if (rodando) {
    log.warn('campanhas: ciclo anterior ainda rodando, pulando esta execução');
    return;
  }
  rodando = true;
  try {
    await ciclo();
  } catch (erro) {
    log.error('campanhas: erro não tratado no ciclo', { alerta: true, erro: erro.message });
  } finally {
    rodando = false;
  }
}

function iniciar() {
  if (tarefa) return tarefa;

  tarefa = cron.schedule(config.jobs.campanhasCron, cicloProtegido, { timezone: datas.FUSO });

  log.info('campanhas: agendado', {
    cron: config.jobs.campanhasCron,
    recallMeses: config.jobs.recallMeses,
    tetoDiario: config.jobs.campanhaMaxPorDia,
    ativas: config.jobs.campanhasAtivas,
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

module.exports = { ciclo, cicloProtegido, iniciar, parar, aniversariantes, recall, dispararCampanha };
