'use strict';

/**
 * Testes da garantia de idempotência. Se algum destes quebrar, paciente recebe
 * mensagem duplicada — é o teste mais importante do projeto.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db/db');

function bancoLimpo() {
  db.fechar();
  db.conectar(':memory:');
}

test.beforeEach(bancoLimpo);
test.after(() => db.fechar());

test('reservar duas vezes o mesmo (codAgendamento, tipo) só funciona uma vez', () => {
  const primeira = db.reservar({ codAgendamento: 42, tipo: 'confirmacao' });
  const segunda = db.reservar({ codAgendamento: 42, tipo: 'confirmacao' });

  assert.ok(primeira?.id);
  assert.equal(segunda, null); // <- é isto que impede o envio duplicado
});

test('o mesmo agendamento aceita tipos diferentes (confirmação e cada lembrete)', () => {
  assert.ok(db.reservar({ codAgendamento: 42, tipo: 'confirmacao' }));
  assert.ok(db.reservar({ codAgendamento: 42, tipo: 'lembrete_48h' }));
  assert.ok(db.reservar({ codAgendamento: 42, tipo: 'lembrete_24h' }));

  assert.equal(db.reservar({ codAgendamento: 42, tipo: 'lembrete_24h' }), null);
});

test('depois de enviado, uma nova tentativa é recusada', () => {
  const { id } = db.reservar({ codAgendamento: 7, tipo: 'confirmacao' });
  db.marcarEnviado(id, { idMensagemMeta: 'wamid.1', telefone: '5511999998888' });

  assert.equal(db.reservarOuRetentar({ codAgendamento: 7, tipo: 'confirmacao' }), null);

  const linha = db.buscarPorId(id);
  assert.equal(linha.statusEnvio, 'enviado');
  assert.equal(linha.tentativas, 1);
  assert.ok(linha.enviadoEm);
});

test('falha transitória pode ser retentada até o limite; depois trava', () => {
  const { id } = db.reservar({ codAgendamento: 8, tipo: 'confirmacao' });

  // tentativa 1 falhou
  db.marcarFalha(id, 'timeout');
  assert.equal(db.buscarPorId(id).statusEnvio, 'falhou');

  const r2 = db.reservarOuRetentar({ codAgendamento: 8, tipo: 'confirmacao' });
  assert.equal(r2.retentativa, true);
  db.marcarFalha(id, 'timeout');

  const r3 = db.reservarOuRetentar({ codAgendamento: 8, tipo: 'confirmacao' });
  assert.equal(r3.retentativa, true);
  db.marcarFalha(id, 'timeout');

  // ENVIO_MAX_TENTATIVAS=3 por padrão -> a quarta não sai
  assert.equal(db.reservarOuRetentar({ codAgendamento: 8, tipo: 'confirmacao' }), null);
  assert.equal(db.buscarPorId(id).tentativas, 3);
});

test('telefone inválido vira "invalido" e nunca mais é tentado', () => {
  const { id } = db.reservar({ codAgendamento: 9, tipo: 'confirmacao' });
  db.marcarFalha(id, 'telefone_ddd_ausente', { definitivo: true });

  assert.equal(db.buscarPorId(id).statusEnvio, 'invalido');
  assert.equal(db.reservarOuRetentar({ codAgendamento: 9, tipo: 'confirmacao' }), null);
});

test('pendente antigo vira indeterminado e NÃO é reenviado', () => {
  const { id } = db.reservar({ codAgendamento: 10, tipo: 'confirmacao' });

  // simula o processo tendo caído entre o disparo e a gravação
  db.conexao()
    .prepare("UPDATE mensagens_enviadas SET criadoEm = '2000-01-01T00:00:00.000-03:00' WHERE id = ?")
    .run(id);

  assert.equal(db.reconciliarPendentes(10), 1);
  assert.equal(db.buscarPorId(id).statusEnvio, 'indeterminado');

  // conservador de propósito: preferimos uma mensagem a menos do que duas
  assert.equal(db.reservarOuRetentar({ codAgendamento: 10, tipo: 'confirmacao' }), null);
});

test('pendente recente é preservado (o envio ainda pode estar em voo)', () => {
  db.reservar({ codAgendamento: 11, tipo: 'confirmacao' });
  assert.equal(db.reconciliarPendentes(10), 0);
});

test('resposta da Meta reentregue não é processada duas vezes', () => {
  const resposta = {
    idMensagemMeta: 'wamid.abc',
    telefone: '5511999998888',
    texto: 'sim',
    interpretacao: 'confirmar',
  };

  assert.equal(db.registrarResposta(resposta), true);
  assert.equal(db.registrarResposta(resposta), false); // reentrega
});

test('casamento por idMensagemMeta encontra o agendamento certo', () => {
  const { id } = db.reservar({ codAgendamento: 55, tipo: 'confirmacao' });
  db.marcarEnviado(id, { idMensagemMeta: 'wamid.xyz', telefone: '5511999998888' });

  assert.equal(db.porIdMensagemMeta('wamid.xyz').codAgendamento, 55);
  assert.equal(db.porIdMensagemMeta('wamid.inexistente'), null);
});

test('fallback por telefone pega o envio mais recente dentro da janela', () => {
  const a = db.reservar({ codAgendamento: 1, tipo: 'confirmacao' });
  db.marcarEnviado(a.id, { idMensagemMeta: 'wamid.a', telefone: '5511999998888' });

  const b = db.reservar({ codAgendamento: 2, tipo: 'confirmacao' });
  db.marcarEnviado(b.id, { idMensagemMeta: 'wamid.b', telefone: '5511999998888' });

  assert.equal(db.ultimoEnvioParaTelefone('5511999998888').codAgendamento, 2);
  assert.equal(db.ultimoEnvioParaTelefone('5511000000000'), null);
});

test('envio fora da janela de resposta não casa mais', () => {
  const { id } = db.reservar({ codAgendamento: 3, tipo: 'confirmacao' });
  db.marcarEnviado(id, { idMensagemMeta: 'wamid.c', telefone: '5511999998888' });

  db.conexao()
    .prepare("UPDATE mensagens_enviadas SET enviadoEm = '2000-01-01T00:00:00.000-03:00' WHERE id = ?")
    .run(id);

  assert.equal(db.ultimoEnvioParaTelefone('5511999998888', 72), null);
});

test('resumo conta por status', () => {
  const a = db.reservar({ codAgendamento: 1, tipo: 'confirmacao' });
  db.marcarEnviado(a.id, { idMensagemMeta: 'wamid.1' });
  const b = db.reservar({ codAgendamento: 2, tipo: 'confirmacao' });
  db.marcarFalha(b.id, 'erro qualquer');

  const resumo = db.resumo();
  assert.equal(resumo.mensagens.enviado, 1);
  assert.equal(resumo.mensagens.falhou, 1);
});


test('remarcação (mesma chave, data diferente) reabre o envio para a nova data', () => {
  const dataA = '2026-10-10T08:00:00.000-03:00';
  const dataB = '2026-10-12T09:00:00.000-03:00';

  const r1 = db.reservar({ codAgendamento: 99, tipo: 'confirmacao', dataAgendamento: dataA });
  assert.ok(r1?.id);
  db.marcarEnviado(r1.id, { idMensagemMeta: 'wamid.antigo', telefone: '5511999990000' });

  // Mesma data: idempotência mantém — não reenvia.
  assert.equal(
    db.reservarOuRetentar({ codAgendamento: 99, tipo: 'confirmacao', dataAgendamento: dataA }),
    null,
  );

  // Data nova (remarcado): reabre o MESMO registro para reenviar.
  const r2 = db.reservarOuRetentar({ codAgendamento: 99, tipo: 'confirmacao', dataAgendamento: dataB });
  assert.ok(r2);
  assert.equal(r2.id, r1.id);
  assert.equal(r2.remarcado, true);

  const linha = db.buscarPorId(r1.id);
  assert.equal(linha.statusEnvio, 'pendente');
  assert.equal(linha.dataAgendamento, dataB);
  assert.equal(linha.enviadoEm, null);
});
