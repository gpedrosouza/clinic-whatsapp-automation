'use strict';

/**
 * Leitura de pacientes na ClinicWeb (base da campanha de aniversário).
 *
 * Particularidades da API (ver docs/03):
 * - GET /pacientes exige `codEmpresa` e — segundo a documentação — `query`.
 *   Se `query` for mesmo obrigatório, filtrar só por aniversário pode não
 *   funcionar; é uma das lacunas a validar em homologação.
 * - Paginação aqui é `skip`/`limit` (diferente de agendamentos, que usa $page).
 * - `diaAniversario` e `mesAniversario` andam em par (informar um exige o outro).
 * - A listagem NÃO devolve `ddiCelular`; o detalhe (`/pacientes/busca`) devolve.
 * - Não existe campo de opt-in/consentimento de WhatsApp na API — por isso o
 *   opt-in é guardado localmente (docs/02, LGPD).
 */

const { config } = require('../config');
const { requisitar } = require('./auth');
const datas = require('../lib/datas');
const log = require('../lib/logger');

/**
 * Lista/filtra pacientes.
 *
 * @param {object} [opcoes]
 * @param {string} [opcoes.query] nome, CPF, data de nascimento ou idPaciente
 * @param {number} [opcoes.diaAniversario]
 * @param {number} [opcoes.mesAniversario]
 * @param {number} [opcoes.skip]
 * @param {number} [opcoes.limit]
 * @returns {Promise<object[]>}
 */
async function listar(opcoes = {}) {
  const { diaAniversario, mesAniversario } = opcoes;

  if ((diaAniversario && !mesAniversario) || (mesAniversario && !diaAniversario)) {
    const erro = new Error('pacientes.listar: diaAniversario e mesAniversario devem vir juntos.');
    erro.permanente = true;
    throw erro;
  }

  const resposta = await requisitar(
    {
      method: 'GET',
      url: '/pacientes',
      params: {
        codEmpresa: config.clinicweb.codEmpresa,
        query: opcoes.query,
        diaAniversario,
        mesAniversario,
        skip: opcoes.skip,
        limit: opcoes.limit ?? config.clinicweb.pageSize,
      },
    },
    { rotulo: 'GET /pacientes' },
  );

  return resposta?.data ?? [];
}

/**
 * Pacientes que fazem aniversário em uma data.
 * @param {import('luxon').DateTime} dt
 */
async function aniversariantesDe(dt, opcoes = {}) {
  return listar({
    ...opcoes,
    diaAniversario: dt.day,
    mesAniversario: dt.month,
  });
}

/**
 * Detalhe cadastral do paciente na unidade. GET /pacientes/busca
 * É a única rota que devolve `ddiCelular` — usar quando o DDI importar.
 *
 * @param {number|string} idPaciente aceita idUsuario ou idPaciente
 */
async function buscar(idPaciente) {
  const resposta = await requisitar(
    {
      method: 'GET',
      url: '/pacientes/busca',
      params: { idEmpresa: config.clinicweb.codEmpresa, idPaciente },
    },
    { rotulo: 'GET /pacientes/busca' },
  );

  return resposta?.data ?? null;
}

/**
 * Identificador do paciente usado como chave em todo o projeto.
 *
 * A API tem DOIS ids e eles não são intercambiáveis:
 *  - `idPaciente` (= `codPaciente` no agendamento) — o vínculo na clínica;
 *  - `idUsuario`  (= `Paciente.codUsuario`)        — a pessoa no sistema.
 * Padronizamos em `idPaciente`, que é o que o agendamento devolve.
 */
function codPacienteDe(objeto) {
  const cod =
    objeto?.codPaciente ??
    objeto?.idPaciente ??
    objeto?.Paciente?.Pacientes?.[0]?.idPaciente ??
    null;

  return cod === null ? null : Number(cod);
}

/**
 * Pacientes "a reativar" (recall) — REGRA CONFIRMADA COM A CLÍNICA NA
 * SESSÃO 4:
 *
 *   paciente cujo último atendimento caiu na FAIXA MÓVEL de 1 mês que termina
 *   há N meses, e que não voltou nem tem agendamento futuro.
 *
 * A API não sabe responder "quem sumiu" — não existe filtro por data do último
 * agendamento. Então a derivação é em dois passos:
 *
 *   1. varre `GET /agendamentos` na faixa [hoje-N meses-janela, hoje-N meses]
 *      → candidatos (já vêm com telefone embutido, o que evita outra chamada);
 *   2. uma única consulta com `codPacientes=[...]` no intervalo
 *      (hoje-N meses, hoje+horizonte] → quem aparecer aí voltou ou tem
 *      consulta marcada, e sai da lista.
 *
 * A faixa olha só para TRÁS de propósito: assim "faz N meses" é sempre
 * verdade. Uma janela centrada dispararia até 15 dias antes de completar N
 * meses, contrariando a regra do vault (">= N meses").
 *
 * @param {object} [opcoes]
 * @param {number} [opcoes.meses] N (default: RECALL_MESES)
 * @param {number} [opcoes.janelaDias] largura da faixa (default: RECALL_JANELA_DIAS)
 * @param {number} [opcoes.horizonteFuturoDias] até onde procurar agendamento futuro
 * @returns {Promise<Array<{codPaciente: number, nome: string, telefone: object,
 *                          ultimoAgendamento: import('luxon').DateTime}>>}
 */
async function paraRecall(opcoes = {}) {
  const agendamentos = require('./agendamentos');

  const meses = opcoes.meses ?? config.jobs.recallMeses;
  const janelaDias = opcoes.janelaDias ?? config.jobs.recallJanelaDias;
  const horizonte = opcoes.horizonteFuturoDias ?? config.jobs.recallHorizonteFuturoDias;

  const agora = datas.agora();
  const fimDaFaixa = agora.minus({ months: meses });
  const inicioDaFaixa = fimDaFaixa.minus({ days: janelaDias });

  // Passo 1 — quem foi atendido na faixa.
  const naFaixa = await agendamentos.listarTodos({
    startDate: datas.paraDataApi(inicioDaFaixa),
    endDate: datas.paraDataApi(fimDaFaixa),
  });

  /** @type {Map<number, object>} */
  const candidatos = new Map();

  for (const ag of naFaixa) {
    if (ag.ativo === 'N') continue;

    const cod = codPacienteDe(ag);
    if (cod === null) continue;

    const quando = datas.deDataHoraClinicweb(ag);
    if (!quando) continue;

    // Guarda o atendimento MAIS RECENTE dentro da faixa.
    const atual = candidatos.get(cod);
    if (atual && atual.ultimoAgendamento >= quando) continue;

    candidatos.set(cod, {
      codPaciente: cod,
      nome: ag?.Paciente?.nome ?? '',
      telefone: {
        ddi: ag?.Paciente?.ddiCelular,
        ddd: ag?.Paciente?.dddCelular,
        tel: ag?.Paciente?.telCelular,
      },
      ultimoAgendamento: quando,
      procedimento: ag?.GrupoProcedimento?.nome ?? null,
    });
  }

  if (candidatos.size === 0) return [];

  // Passo 2 — quem voltou depois da faixa (ou já tem consulta marcada) sai.
  const voltaram = await pacientesComAgendamentoDesde(
    [...candidatos.keys()],
    datas.paraDataApi(fimDaFaixa.plus({ days: 1 })),
    datas.paraDataApi(agora.plus({ days: horizonte })),
  );

  const elegiveis = [...candidatos.values()].filter((c) => !voltaram.has(c.codPaciente));

  log.info('recall: candidatos apurados', {
    faixa: `${datas.paraDataApi(inicioDaFaixa)}..${datas.paraDataApi(fimDaFaixa)}`,
    meses,
    candidatos: candidatos.size,
    voltaram: voltaram.size,
    elegiveis: elegiveis.length,
  });

  return elegiveis.sort((a, b) => a.codPaciente - b.codPaciente);
}

/**
 * Quais destes pacientes têm agendamento (ativo) no intervalo?
 * Consulta em lotes — a query string tem limite de tamanho.
 *
 * @returns {Promise<Set<number>>}
 */
async function pacientesComAgendamentoDesde(codigos, startDate, endDate, tamanhoLote = 50) {
  const agendamentos = require('./agendamentos');
  const encontrados = new Set();

  for (let i = 0; i < codigos.length; i += tamanhoLote) {
    const lote = codigos.slice(i, i + tamanhoLote);

    const lista = await agendamentos.listarTodos({
      startDate,
      endDate,
      codPacientes: lote,
    });

    for (const ag of lista) {
      if (ag.ativo === 'N') continue;
      const cod = codPacienteDe(ag);
      if (cod !== null) encontrados.add(cod);
    }
  }

  return encontrados;
}

module.exports = {
  listar,
  aniversariantesDe,
  buscar,
  paraRecall,
  pacientesComAgendamentoDesde,
  codPacienteDe,
};
