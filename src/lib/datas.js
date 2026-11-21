'use strict';

/**
 * Helpers de data/hora com fuso EXPLÍCITO (America/Sao_Paulo).
 *
 * Regra do projeto: nenhum cálculo de janela ("48h antes") pode usar UTC cru.
 * O servidor de hospedagem roda em UTC; a clínica pensa em horário de Brasília.
 * Todo módulo que precisa de data deve passar por aqui.
 */

const { DateTime } = require('luxon');
const { config } = require('../config');

const FUSO = config.app.fuso;

/** Agora, no fuso da clínica. @returns {DateTime} */
function agora() {
  return DateTime.now().setZone(FUSO);
}

/**
 * Janela de tempo relativa a agora, no fuso da clínica.
 * Ex.: janela(0, 48) => de agora até 48h à frente.
 *      janela(-6, 0) => das últimas 6h até agora.
 *
 * @param {number} horasInicio deslocamento em horas para o início
 * @param {number} horasFim deslocamento em horas para o fim
 * @param {DateTime} [referencia] usar outro "agora" (facilita teste)
 * @returns {{inicio: DateTime, fim: DateTime, startDate: string, endDate: string}}
 *          startDate/endDate no formato YYYY-MM-DD exigido pela API ClinicWeb.
 */
function janela(horasInicio, horasFim, referencia = agora()) {
  const inicio = referencia.plus({ hours: horasInicio });
  const fim = referencia.plus({ hours: horasFim });
  return {
    inicio,
    fim,
    startDate: paraDataApi(inicio),
    endDate: paraDataApi(fim),
  };
}

/**
 * Janela em dias — usada pelo polling ("olhar os próximos N dias").
 * @returns {{inicio: DateTime, fim: DateTime, startDate: string, endDate: string}}
 */
function janelaDias(diasInicio, diasFim, referencia = agora()) {
  return janela(diasInicio * 24, diasFim * 24, referencia);
}

/** Formata para YYYY-MM-DD (formato de startDate/endDate da API ClinicWeb). */
function paraDataApi(dt) {
  return dt.setZone(FUSO).toFormat('yyyy-MM-dd');
}

/**
 * Converte o par (data, hora) devolvido pela ClinicWeb em DateTime no fuso local.
 *
 * A API devolve `data` como "2018-05-25T00:00:00.000Z" (meia-noite em UTC —
 * na prática um marcador de DIA, não um instante) e `hora` separada
 * ("16:00:00"). Converter `data` para o fuso local viraria 24/05 21:00, o que
 * causaria erro de um dia. Por isso usamos só a parte YYYY-MM-DD da string e
 * combinamos com `hora` já no fuso da clínica.
 *
 * @param {{data?: string, hora?: string}} agendamento
 * @returns {DateTime|null} inválido/ausente => null
 */
function deDataHoraClinicweb(agendamento) {
  if (!agendamento || !agendamento.data) return null;

  const dia = String(agendamento.data).slice(0, 10);
  const hora = String(agendamento.hora || '00:00:00').slice(0, 8);
  const dt = DateTime.fromISO(`${dia}T${hora}`, { zone: FUSO });

  return dt.isValid ? dt : null;
}

/** Horas (fracionárias) de `referencia` até `dt`. Negativo se `dt` já passou. */
function horasAte(dt, referencia = agora()) {
  return dt.diff(referencia, 'hours').hours;
}

/** Competência YYYY-MM — chave de idempotência das campanhas mensais. */
function competencia(dt = agora()) {
  return dt.setZone(FUSO).toFormat('yyyy-MM');
}

/** Data no formato YYYY-MM-DD de N meses atrás (base da regra de recall). */
function mesesAtras(n, referencia = agora()) {
  return paraDataApi(referencia.minus({ months: n }));
}

/** "25/05/2018" */
function formatarDataBr(dt) {
  return dt.setZone(FUSO).toFormat('dd/MM/yyyy');
}

/** "16:00" */
function formatarHoraBr(dt) {
  return dt.setZone(FUSO).toFormat('HH:mm');
}

/** "25/05/2018 às 16:00" — usado nos parâmetros dos templates. */
function formatarDataHoraBr(dt) {
  return `${formatarDataBr(dt)} às ${formatarHoraBr(dt)}`;
}

/**
 * A hora atual está dentro da faixa permitida para disparo?
 * Evita mandar mensagem de madrugada.
 *
 * @param {string} inicioHHMM ex.: "08:00"
 * @param {string} fimHHMM ex.: "20:00"
 */
function dentroDoHorarioPermitido(inicioHHMM, fimHHMM, referencia = agora()) {
  const minutos = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map((n) => Number.parseInt(n, 10));
    return h * 60 + (m || 0);
  };
  const atual = referencia.setZone(FUSO).hour * 60 + referencia.setZone(FUSO).minute;
  return atual >= minutos(inicioHHMM) && atual <= minutos(fimHHMM);
}

/** Dia útil = segunda a sexta no fuso da clínica. */
function diaUtil(referencia = agora()) {
  return referencia.setZone(FUSO).weekday <= 5;
}

/**
 * Recua uma data para o dia útil anterior quando cai no fim de semana.
 * Sábado/domingo → sexta; dia útil → inalterado.
 */
function recuarParaDiaUtil(dt) {
  let d = dt.setZone(FUSO);
  while (d.weekday > 5) d = d.minus({ days: 1 });
  return d;
}

/**
 * A janela de envio está aberta? Horário comercial e, se `somenteDiasUteis`,
 * apenas seg–sex.
 */
function dentroDaJanelaDeEnvio(inicioHHMM, fimHHMM, somenteDiasUteis = true, referencia = agora()) {
  if (somenteDiasUteis && !diaUtil(referencia)) return false;
  return dentroDoHorarioPermitido(inicioHHMM, fimHHMM, referencia);
}

module.exports = {
  FUSO,
  agora,
  janela,
  janelaDias,
  paraDataApi,
  deDataHoraClinicweb,
  horasAte,
  competencia,
  mesesAtras,
  formatarDataBr,
  formatarHoraBr,
  formatarDataHoraBr,
  dentroDoHorarioPermitido,
  diaUtil,
  recuarParaDiaUtil,
  dentroDaJanelaDeEnvio,
};
