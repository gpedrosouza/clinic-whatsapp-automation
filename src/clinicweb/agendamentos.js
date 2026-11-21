'use strict';

/**
 * Leitura de agendamentos na ClinicWeb.
 *
 * FASE 1 = só leitura. O PATCH de status (confirmar/cancelar) entra na Fase 2,
 * junto com a idempotência — não queremos escrever em agenda real durante a
 * fase de descoberta.
 *
 * Particularidades da API (ver docs/03):
 * - `codEmpresa` e `startDate` são OBRIGATÓRIOS no GET /agendamentos.
 * - Paginação e ordenação usam prefixo `$`: $page, $pageSize, $sort.
 * - Datas de filtro no formato YYYY-MM-DD.
 */

const { config } = require('../config');
const { requisitar } = require('./auth');
const datas = require('../lib/datas');
const log = require('../lib/logger');

/**
 * A documentação mostra arrays como `codPacientes=[12]`, e não no formato
 * `codPacientes[]=12` que o axios usa por padrão. Serializamos igual ao
 * exemplo oficial. (Lacuna marcada em docs/03 para confirmar em homologação.)
 */
function serializarParams(params) {
  const partes = [];
  for (const [chave, valor] of Object.entries(params)) {
    if (valor === undefined || valor === null || valor === '') continue;
    const bruto = Array.isArray(valor) ? JSON.stringify(valor) : String(valor);
    partes.push(`${encodeURIComponent(chave)}=${encodeURIComponent(bruto)}`);
  }
  return partes.join('&');
}

/**
 * Lista agendamentos de uma janela de datas (uma página).
 *
 * @param {object} opcoes
 * @param {string} opcoes.startDate YYYY-MM-DD (obrigatório)
 * @param {string} [opcoes.endDate] YYYY-MM-DD
 * @param {number[]} [opcoes.status] filtra por códigos de status
 * @param {number[]} [opcoes.codPacientes]
 * @param {number} [opcoes.page] 1-based
 * @param {number} [opcoes.pageSize]
 * @returns {Promise<object[]>} lista crua de agendamentos (campo `data` da resposta)
 */
async function listar(opcoes) {
  if (!opcoes || !opcoes.startDate) {
    const erro = new Error('agendamentos.listar: startDate (YYYY-MM-DD) é obrigatório.');
    erro.permanente = true;
    throw erro;
  }

  const params = {
    codEmpresa: config.clinicweb.codEmpresa,
    startDate: opcoes.startDate,
    endDate: opcoes.endDate,
    status: opcoes.status,
    codPacientes: opcoes.codPacientes,
    codProfissionais: opcoes.codProfissionais,
    trazerFiliais: config.clinicweb.trazerFiliais ? true : undefined,
    $page: opcoes.page ?? 1,
    $pageSize: opcoes.pageSize ?? config.clinicweb.pageSize,
  };

  const resposta = await requisitar(
    {
      method: 'GET',
      url: '/agendamentos',
      params,
      paramsSerializer: serializarParams,
    },
    { rotulo: 'GET /agendamentos' },
  );

  return resposta?.data ?? [];
}

/**
 * Lista todas as páginas da janela. Para com segurança em `maxPaginas`
 * para não entrar em laço infinito se a API ignorar a paginação.
 *
 * @returns {Promise<object[]>}
 */
async function listarTodos(opcoes, maxPaginas = 20) {
  const pageSize = opcoes.pageSize ?? config.clinicweb.pageSize;
  const todos = [];

  for (let page = 1; page <= maxPaginas; page += 1) {
    const pagina = await listar({ ...opcoes, page, pageSize });
    todos.push(...pagina);
    if (pagina.length < pageSize) break;
  }

  return todos;
}

/**
 * Agendamentos da janela de polling (próximos N dias), já com a data/hora
 * resolvida no fuso da clínica.
 *
 * @param {number} [dias] default: POLLING_JANELA_DIAS
 * @returns {Promise<Array<object & {dataHora: import('luxon').DateTime|null}>>}
 */
async function listarProximos(dias = config.jobs.pollingJanelaDias) {
  const { startDate, endDate } = datas.janelaDias(0, dias);
  const lista = await listarTodos({ startDate, endDate });

  return lista.map((ag) => ({ ...ag, dataHora: datas.deDataHoraClinicweb(ag) }));
}

/** Detalhe de um agendamento. GET /agendamentos/{id}?codEmpresa= */
/**
 * Agendamentos de uma janela LONGA (ex.: 730 dias), consultada em blocos de
 * `blocoDias` para que nenhuma busca bata no teto de paginação de
 * `listarTodos` (maxPaginas × pageSize). Duplicados das bordas dos blocos são
 * removidos por codAgendamento. Se um bloco vier exatamente no teto, pode ter
 * sido truncado: registra alerta para reduzir `blocoDias`.
 *
 * @param {number} dias tamanho total da janela, a partir de hoje
 * @param {number} [blocoDias=30]
 * @param {number} [maxPaginas=20]
 * @param {number} [pausaMs] espera entre blocos (CLINICWEB_PAUSA_BLOCOS_MS)
 */
async function listarProximosEmBlocos(dias, blocoDias = 30, maxPaginas = 20, pausaMs = config.clinicweb.pausaEntreBlocosMs) {
  const pageSize = config.clinicweb.pageSize;
  const vistos = new Map();

  for (let inicio = 0; inicio < dias; inicio += blocoDias) {
    // Pausa entre blocos: 25 consultas seguidas já devolveram 429 (limite de
    // requisições) em produção. Espaçar evita competir com o polling.
    if (inicio > 0 && pausaMs > 0) await new Promise((r) => setTimeout(r, pausaMs));
    const fim = Math.min(inicio + blocoDias, dias);
    const { startDate, endDate } = datas.janelaDias(inicio, fim);
    const bloco = await module.exports.listarTodos({ startDate, endDate }, maxPaginas);
    if (bloco.length >= maxPaginas * pageSize) {
      log.error('agendamentos: bloco atingiu o teto de paginação, pode estar truncado', {
        alerta: true, startDate, endDate, total: bloco.length,
      });
    }
    for (const ag of bloco) vistos.set(ag.codAgendamento, ag);
  }

  return [...vistos.values()].map((ag) => ({ ...ag, dataHora: datas.deDataHoraClinicweb(ag) }));
}

async function obter(idAgendamento) {
  const resposta = await requisitar(
    {
      method: 'GET',
      url: `/agendamentos/${idAgendamento}`,
      params: { codEmpresa: config.clinicweb.codEmpresa },
    },
    { rotulo: 'GET /agendamentos/{id}' },
  );

  return resposta?.data ?? null;
}

/**
 * Altera o status do agendamento. É o fechamento do ciclo: o paciente
 * respondeu "SIM" no WhatsApp e a agenda da clínica reflete isso.
 *
 * PATCH /agendamentos/{id} — atenção às particularidades (docs/03):
 *  - o body usa `idEmpresa` (e não `codEmpresa`, como o resto da API);
 *  - o status vai aninhado em `agendamento.idStatus`;
 *  - `motivoCancelamento` recusa caractere especial e HTML (400), por isso
 *    o texto é higienizado aqui.
 *
 * Protegido por `CLINICWEB_PERMITIR_ESCRITA`: enquanto for false, nada é
 * escrito na agenda real — só registrado no log. Ligar de propósito.
 *
 * @param {number} idAgendamento
 * @param {number} idStatus
 * @param {{motivo?: string, complemento?: string}} [opcoes]
 * @returns {Promise<{ok: boolean, bloqueado?: boolean, resposta?: any}>}
 */
async function atualizarStatus(idAgendamento, idStatus, opcoes = {}) {
  const corpo = {
    idEmpresa: Number(config.clinicweb.codEmpresa),
    agendamento: { idStatus },
  };

  if (opcoes.motivo) corpo.motivoCancelamento = higienizarMotivo(opcoes.motivo);
  if (opcoes.complemento) corpo.complementoCancelamento = higienizarMotivo(opcoes.complemento);

  if (!config.clinicweb.permitirEscrita) {
    log.warn('clinicweb: escrita BLOQUEADA (CLINICWEB_PERMITIR_ESCRITA=false)', {
      idAgendamento,
      idStatus,
      seriaEnviado: corpo,
    });
    return { ok: false, bloqueado: true };
  }

  const resposta = await requisitar(
    { method: 'PATCH', url: `/agendamentos/${idAgendamento}`, data: corpo },
    { rotulo: 'PATCH /agendamentos/{id}' },
  );

  log.info('clinicweb: status atualizado', { idAgendamento, idStatus });
  return { ok: true, resposta };
}

/** A API recusa motivo com caractere especial ou HTML. */
function higienizarMotivo(texto) {
  return String(texto)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^\p{L}\p{N} .,:-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Lista os status disponíveis. GET /agendamento-status */
async function listarStatus() {
  const resposta = await requisitar(
    { method: 'GET', url: '/agendamento-status' },
    { rotulo: 'GET /agendamento-status' },
  );

  return resposta?.data ?? [];
}

module.exports = {
  listar,
  listarTodos,
  listarProximos,
  listarProximosEmBlocos,
  obter,
  listarStatus,
  atualizarStatus,
  higienizarMotivo,
  serializarParams,
};
