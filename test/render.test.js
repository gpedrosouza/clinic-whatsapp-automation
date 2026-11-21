'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const render = require('../src/whatsapp/render');

/** Agendamento mínimo no formato da LISTAGEM (camelCase), como templates.js espera. */
function agendamentoFake(over = {}) {
  return {
    codAgendamento: 999,
    data: '2026-08-20T00:00:00.000Z',
    hora: '14:30:00',
    status: 1,
    ativo: 'S',
    Paciente: { nome: 'MARIA DA SILVA', dddCelular: '11', telCelular: '987654321' },
    GrupoProcedimento: { nome: 'ultrassom' },
    ...over,
  };
}

test('interpolar substitui os marcadores posicionais', () => {
  assert.equal(render.interpolar('Olá, {{1}} — {{2}}!', ['Maria', 'ultrassom']), 'Olá, Maria — ultrassom!');
});

test('interpolar não deixa marcador para parâmetro ausente', () => {
  assert.equal(render.interpolar('a {{1}} b {{2}}', ['x']), 'a x b ');
});

test('confirmacao renderiza o texto do paciente com nome, data e hora', () => {
  const m = render.confirmacao(agendamentoFake());
  assert.equal(m.tipo, 'confirmacao');
  assert.match(m.corpo, /Maria/); // primeiro nome normalizado, não caixa-alta
  assert.match(m.corpo, /20\/08/);
  assert.match(m.corpo, /14:30/);
  assert.match(m.corpo, /Podemos confirmar a sua presença\?/);
  assert.deepEqual(m.botoes, ['Confirmar presença', 'Preciso remarcar']);
});

test('nenhum marcador {{n}} sobra no corpo nem no rodapé', () => {
  const m = render.confirmacao(agendamentoFake());
  assert.doesNotMatch(m.corpo, /\{\{\d+\}\}/);
  assert.doesNotMatch(m.rodape, /\{\{\d+\}\}/);
});

test('lembrete tem profissional, endereço, recomendações e sem botões (véspera)', () => {
  const m = render.lembrete(agendamentoFake(), 24);
  assert.equal(m.parametros.length, 7);
  assert.match(m.corpo, /com /); // "com <profissional>"
  assert.match(m.corpo, /Endereço:/);
  assert.match(m.corpo, /Recomendações:/);
  assert.deepEqual(m.botoes, []);
  assert.doesNotMatch(m.corpo, /\{\{\d+\}\}/);
});

test('aviso de agendamento realizado é informativo e sem botões', () => {
  const m = render.agendamentoRealizado(agendamentoFake());
  assert.equal(m.tipo, 'agendamento_realizado');
  assert.match(m.corpo, /foi realizado/);
  assert.match(m.corpo, /Maria/);
  assert.deepEqual(m.botoes, []);
  assert.doesNotMatch(m.corpo, /\{\{\d+\}\}/);
  assert.doesNotMatch(m.rodape, /\{\{\d+\}\}/);
});

test('paraTerminal produz uma "bolha" com bordas e os botões', () => {
  const saida = render.paraTerminal(render.confirmacao(agendamentoFake()));
  assert.match(saida, /┌/);
  assert.match(saida, /└/);
  assert.match(saida, /Confirmar presença/);
});

test('paraTextoPuro devolve texto sem bordas, com os botões listados', () => {
  const saida = render.paraTextoPuro(render.confirmacao(agendamentoFake()));
  assert.doesNotMatch(saida, /[┌└│]/);
  assert.match(saida, /Botões: \[Confirmar presença\]/);
});
