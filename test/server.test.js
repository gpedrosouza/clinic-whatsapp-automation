'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../src/server');
const { serializarParams } = require('../src/clinicweb/agendamentos');
const log = require('../src/lib/logger');
const db = require('../src/db/db');

// /health consulta o banco — em memória, para o teste não criar o SQLite real.
db.conectar(':memory:');
test.after(() => db.fechar());

async function comServidor(fn) {
  const servidor = app.listen(0);
  await new Promise((resolve) => servidor.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${servidor.address().port}`);
  } finally {
    servidor.close();
  }
}

test('GET /health responde ok e não vaza credencial', async () => {
  const corpo = await comServidor(async (base) => {
    const resposta = await fetch(`${base}/health`);
    assert.equal(resposta.status, 200);
    return resposta.json();
  });

  assert.equal(corpo.status, 'ok');
  assert.equal(corpo.fuso, 'America/Sao_Paulo');
  assert.equal(typeof corpo.configurado.clinicweb, 'boolean');

  const texto = JSON.stringify(corpo);
  assert.doesNotMatch(texto, /senha|password|token|secret/i);
});

test('rota inexistente devolve 404 em JSON', async () => {
  const resposta = await comServidor((base) => fetch(`${base}/nao-existe`));
  assert.equal(resposta.status, 404);
});

test('serializarParams monta arrays como a doc da ClinicWeb mostra', () => {
  const query = serializarParams({
    codEmpresa: -1,
    startDate: '2026-07-29',
    status: [1, 2],
    endDate: undefined,
    vazio: '',
    $pageSize: 50,
  });

  assert.equal(query, 'codEmpresa=-1&startDate=2026-07-29&status=%5B1%2C2%5D&%24pageSize=50');
  assert.equal(decodeURIComponent(query).includes('status=[1,2]'), true);
});

test('logger mascara segredo, telefone e nome', () => {
  const saida = log.mascarar({
    senha: 'super-secreta',
    token: 'abc.def.ghi',
    telefone: '5511999998888',
    to: '5511999998888',
    nomePaciente: 'MARIA DA SILVA',
    codAgendamento: 42,
  });

  assert.equal(saida.senha, '***');
  assert.equal(saida.token, '***');
  assert.equal(saida.telefone, '55119****8888');
  assert.equal(saida.to, '55119****8888');
  assert.equal(saida.nomePaciente, 'MARIA S.');
  // campo comum não pode ser mascarado por engano (ex.: "codAgendamento")
  assert.equal(saida.codAgendamento, 42);
});
