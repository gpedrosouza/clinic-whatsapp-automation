'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { comRetry, repetivelPorPadrao } = require('../src/lib/retry');

test('erro permanente não é repetido (config errada não melhora com retry)', async () => {
  let chamadas = 0;
  const erro = new Error('falta variável de ambiente');
  erro.permanente = true;

  await assert.rejects(
    comRetry(
      () => {
        chamadas += 1;
        return Promise.reject(erro);
      },
      { rotulo: 'teste', tentativas: 3, baseMs: 1 },
    ),
    /falta variável/,
  );

  assert.equal(chamadas, 1);
});

test('falha transitória é repetida até dar certo', async () => {
  let chamadas = 0;

  const resultado = await comRetry(
    () => {
      chamadas += 1;
      if (chamadas < 3) return Promise.reject(new Error('ECONNRESET'));
      return Promise.resolve('ok');
    },
    { rotulo: 'teste', tentativas: 3, baseMs: 1 },
  );

  assert.equal(resultado, 'ok');
  assert.equal(chamadas, 3);
});

test('4xx de negócio não é repetido; 429 e 5xx são', () => {
  const comStatus = (status) => ({ response: { status } });

  assert.equal(repetivelPorPadrao(comStatus(400)), false);
  assert.equal(repetivelPorPadrao(comStatus(403)), false);
  assert.equal(repetivelPorPadrao(comStatus(404)), false);
  assert.equal(repetivelPorPadrao(comStatus(408)), true);
  assert.equal(repetivelPorPadrao(comStatus(429)), true);
  assert.equal(repetivelPorPadrao(comStatus(500)), true);
  assert.equal(repetivelPorPadrao(comStatus(503)), true);
  assert.equal(repetivelPorPadrao(new Error('timeout')), true); // sem response = rede
});

test('esgota as tentativas e propaga o último erro', async () => {
  let chamadas = 0;

  await assert.rejects(
    comRetry(
      () => {
        chamadas += 1;
        return Promise.reject(new Error('sempre falha'));
      },
      { rotulo: 'teste', tentativas: 2, baseMs: 1 },
    ),
    /sempre falha/,
  );

  assert.equal(chamadas, 2);
});
