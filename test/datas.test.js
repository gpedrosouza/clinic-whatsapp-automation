'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

const datas = require('../src/lib/datas');

/** Referência fixa: 29/07/2026 22:30 em São Paulo (já é 30/07 em UTC). */
const REF = DateTime.fromISO('2026-07-29T22:30:00', { zone: datas.FUSO });

test('FUSO é America/Sao_Paulo', () => {
  assert.equal(datas.FUSO, 'America/Sao_Paulo');
});

test('agora() responde no fuso da clínica', () => {
  assert.equal(datas.agora().zoneName, 'America/Sao_Paulo');
});

test('deDataHoraClinicweb não desloca o dia por causa do "Z" da API', () => {
  // A API devolve o DIA como meia-noite UTC. Converter ingenuamente daria 24/05.
  const dt = datas.deDataHoraClinicweb({ data: '2018-05-25T00:00:00.000Z', hora: '16:00:00' });

  assert.equal(dt.toFormat('yyyy-MM-dd HH:mm'), '2018-05-25 16:00');
  assert.equal(dt.zoneName, 'America/Sao_Paulo');
});

test('deDataHoraClinicweb aceita data sem "Z" e hora curta', () => {
  const dt = datas.deDataHoraClinicweb({ data: '2025-08-22T00:00:00', hora: '08:00' });
  assert.equal(dt.toFormat('yyyy-MM-dd HH:mm'), '2025-08-22 08:00');
});

test('deDataHoraClinicweb assume meia-noite quando a hora falta', () => {
  const dt = datas.deDataHoraClinicweb({ data: '2025-08-22' });
  assert.equal(dt.toFormat('yyyy-MM-dd HH:mm'), '2025-08-22 00:00');
});

test('deDataHoraClinicweb devolve null para entrada inútil', () => {
  assert.equal(datas.deDataHoraClinicweb(null), null);
  assert.equal(datas.deDataHoraClinicweb({}), null);
  assert.equal(datas.deDataHoraClinicweb({ data: 'banana' }), null);
});

test('paraDataApi usa a data LOCAL, não a UTC (virada de dia)', () => {
  // 22:30 em SP = 01:30 do dia seguinte em UTC. A API espera o dia da clínica.
  assert.equal(datas.paraDataApi(REF), '2026-07-29');
});

test('janela calcula início/fim e as datas de filtro da API', () => {
  const j = datas.janela(0, 48, REF);

  assert.equal(j.inicio.toFormat('dd/MM HH:mm'), '29/07 22:30');
  assert.equal(j.fim.toFormat('dd/MM HH:mm'), '31/07 22:30');
  assert.equal(j.startDate, '2026-07-29');
  assert.equal(j.endDate, '2026-07-31');
});

test('janela aceita deslocamento negativo (olhar para trás)', () => {
  const j = datas.janela(-6, 0, REF);
  assert.equal(j.inicio.toFormat('dd/MM HH:mm'), '29/07 16:30');
  assert.equal(j.fim.toFormat('dd/MM HH:mm'), '29/07 22:30');
});

test('janelaDias converte dias em horas', () => {
  const j = datas.janelaDias(0, 15, REF);
  assert.equal(j.startDate, '2026-07-29');
  assert.equal(j.endDate, '2026-08-13');
});

test('horasAte mede a distância até o agendamento', () => {
  const agendamento = REF.plus({ hours: 24 });
  assert.equal(datas.horasAte(agendamento, REF), 24);
  assert.equal(datas.horasAte(REF.minus({ hours: 3 }), REF), -3);
});

test('competencia é a chave YYYY-MM de idempotência das campanhas', () => {
  assert.equal(datas.competencia(REF), '2026-07');
});

test('mesesAtras é a base da regra de recall', () => {
  assert.equal(datas.mesesAtras(6, REF), '2026-01-29');
});

test('formatações em pt-BR para os parâmetros dos templates', () => {
  assert.equal(datas.formatarDataBr(REF), '29/07/2026');
  assert.equal(datas.formatarHoraBr(REF), '22:30');
  assert.equal(datas.formatarDataHoraBr(REF), '29/07/2026 às 22:30');
});

test('dentroDoHorarioPermitido barra disparo de madrugada', () => {
  const madrugada = DateTime.fromISO('2026-07-29T03:00:00', { zone: datas.FUSO });
  const tarde = DateTime.fromISO('2026-07-29T14:00:00', { zone: datas.FUSO });

  assert.equal(datas.dentroDoHorarioPermitido('08:00', '20:00', madrugada), false);
  assert.equal(datas.dentroDoHorarioPermitido('08:00', '20:00', tarde), true);
  assert.equal(datas.dentroDoHorarioPermitido('08:00', '20:00', REF), false); // 22:30
});

// --- Dias úteis / janela de envio ---

test('recuarParaDiaUtil: sábado e domingo caem para sexta; dia útil fica', () => {
  const sabado = DateTime.fromISO('2026-08-08T12:00:00', { zone: datas.FUSO });
  const domingo = DateTime.fromISO('2026-08-09T12:00:00', { zone: datas.FUSO });
  const quarta = DateTime.fromISO('2026-08-12T12:00:00', { zone: datas.FUSO });
  assert.equal(datas.recuarParaDiaUtil(sabado).toFormat('yyyy-MM-dd'), '2026-08-07');
  assert.equal(datas.recuarParaDiaUtil(domingo).toFormat('yyyy-MM-dd'), '2026-08-07');
  assert.equal(datas.recuarParaDiaUtil(quarta).toFormat('yyyy-MM-dd'), '2026-08-12');
});

test('diaUtil distingue semana de fim de semana', () => {
  assert.equal(datas.diaUtil(DateTime.fromISO('2026-08-07T10:00', { zone: datas.FUSO })), true);
  assert.equal(datas.diaUtil(DateTime.fromISO('2026-08-08T10:00', { zone: datas.FUSO })), false);
  assert.equal(datas.diaUtil(DateTime.fromISO('2026-08-09T10:00', { zone: datas.FUSO })), false);
});

test('dentroDaJanelaDeEnvio bloqueia fim de semana e fora de hora', () => {
  const sabado = DateTime.fromISO('2026-08-08T10:00', { zone: datas.FUSO });
  const sextaCedo = DateTime.fromISO('2026-08-07T06:00', { zone: datas.FUSO });
  const sextaOk = DateTime.fromISO('2026-08-07T10:00', { zone: datas.FUSO });
  assert.equal(datas.dentroDaJanelaDeEnvio('08:00', '20:00', true, sabado), false);
  assert.equal(datas.dentroDaJanelaDeEnvio('08:00', '20:00', true, sextaCedo), false);
  assert.equal(datas.dentroDaJanelaDeEnvio('08:00', '20:00', true, sextaOk), true);
  assert.equal(datas.dentroDaJanelaDeEnvio('08:00', '20:00', false, sabado), true);
});
