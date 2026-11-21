'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const agendamentos = require('../src/clinicweb/agendamentos');
const aviso = require('../src/jobs/aviso');
const templates = require('../src/whatsapp/templates');
const datas = require('../src/lib/datas');
const db = require('../src/db/db');
const log = require('../src/lib/logger');
const { config } = require('../src/config');

db.conectar(':memory:');

function ag(cod, dataHora, extra = {}) {
  return {
    codAgendamento: cod,
    codPaciente: 9,
    data: `${dataHora.toFormat('yyyy-MM-dd')}T00:00:00.000Z`,
    hora: dataHora.toFormat('HH:mm:ss'),
    status: config.clinicweb.status.naoChegou,
    ativo: 'S',
    dataHora,
    GrupoProcedimento: { codGrupoProcedimento: 1, nome: 'Consulta' },
    Paciente: { nome: 'MARIA EXEMPLO', dddCelular: '17', telCelular: '900000000' },
    ...extra,
  };
}

/** Troca valores de config durante `fn` e restaura no fim. */
async function comConfig(trocas, fn) {
  const originais = trocas.map(([obj, k]) => [obj, k, obj[k]]);
  trocas.forEach(([obj, k, v]) => { obj[k] = v; });
  try {
    return await fn();
  } finally {
    originais.forEach(([obj, k, v]) => { obj[k] = v; });
  }
}

// ---------------------------------------------------------------------------
// Busca em blocos (janela longa sem estourar o limite de paginação)
// ---------------------------------------------------------------------------

test('listarProximosEmBlocos cobre 730 dias em blocos de 30, contíguos', async () => {
  const original = agendamentos.listarTodos;
  const janelas = [];
  agendamentos.listarTodos = async (opcoes) => { janelas.push(opcoes); return []; };
  try {
    await agendamentos.listarProximosEmBlocos(730, 30, 20, 0);
  } finally {
    agendamentos.listarTodos = original;
  }
  assert.equal(janelas.length, 25); // ceil(730/30)
  const hoje = datas.agora().toFormat('yyyy-MM-dd');
  assert.equal(janelas[0].startDate, hoje);
  const ultimoFim = datas.agora().plus({ days: 730 }).toFormat('yyyy-MM-dd');
  assert.equal(janelas[janelas.length - 1].endDate, ultimoFim);
  for (let i = 1; i < janelas.length; i += 1) {
    assert.ok(janelas[i].startDate <= janelas[i - 1].endDate, 'blocos sem buraco entre si');
  }
});

test('listarProximosEmBlocos remove duplicados da borda e resolve dataHora', async () => {
  const original = agendamentos.listarTodos;
  const dh = datas.agora().plus({ days: 30 });
  const bruto = { codAgendamento: 7, data: `${dh.toFormat('yyyy-MM-dd')}T00:00:00.000Z`, hora: '09:00:00' };
  agendamentos.listarTodos = async () => [bruto];
  try {
    const lista = await agendamentos.listarProximosEmBlocos(60, 30, 20, 0);
    assert.equal(lista.length, 1);
    assert.ok(lista[0].dataHora);
  } finally {
    agendamentos.listarTodos = original;
  }
});

test('listarProximosEmBlocos alerta quando um bloco bate no teto de paginação', async () => {
  const original = agendamentos.listarTodos;
  const originalErro = log.error;
  const alertas = [];
  const teto = 20 * config.clinicweb.pageSize;
  agendamentos.listarTodos = async () =>
    Array.from({ length: teto }, (_v, i) => ({ codAgendamento: i + 1, data: '2027-01-01T00:00:00.000Z', hora: '09:00:00' }));
  log.error = (msg, extra) => alertas.push({ msg, extra });
  try {
    await agendamentos.listarProximosEmBlocos(30, 30, 20, 0);
  } finally {
    agendamentos.listarTodos = original;
    log.error = originalErro;
  }
  assert.equal(alertas.length, 1);
  assert.equal(alertas[0].extra.alerta, true);
});

// ---------------------------------------------------------------------------
// Job diário de aviso
// ---------------------------------------------------------------------------

test('ciclo do aviso: só agendamentos antes do dia da confirmação; uma vez só', async () => {
  db.fechar();
  db.conectar(':memory:');
  const original = agendamentos.listarProximosEmBlocos;
  const agora = datas.agora();
  agendamentos.listarProximosEmBlocos = async () => [
    ag(800, agora.plus({ days: 40 })), // longe -> aviso
    ag(801, agora.plus({ days: 400 })), // muito longe (2 anos) -> aviso
    ag(802, agora.plus({ hours: 30 })), // já no dia da confirmação -> nada (é do polling)
    ag(803, agora.minus({ days: 1 })), // passado -> nada
    ag(804, agora.plus({ days: 40 }), { status: config.clinicweb.status.confirmado }), // confirmado -> nada
  ];
  try {
    await comConfig([
      [config.whatsapp, 'modoSeco', true],
      [config.meta.templates, 'agendamento', 'agendamento_realizado'],
      [config.jobs, 'envioHoraInicio', '00:00'],
      [config.jobs, 'envioHoraFim', '23:59'],
      [config.jobs, 'enviarSomenteDiasUteis', false],
    ], async () => {
      const primeiro = await aviso.ciclo();
      assert.equal(primeiro.encontrados, 5);
      assert.equal(primeiro.simulado, 2);
      assert.equal(primeiro.porTipo.agendamento_realizado, 2);
      assert.equal(primeiro.porTipo.confirmacao, undefined);

      const segundo = await aviso.ciclo();
      assert.equal(segundo.simulado, 0);
      assert.equal(segundo.ja_enviado, 2);
    });
  } finally {
    agendamentos.listarProximosEmBlocos = original;
    db.fechar();
    db.conectar(':memory:');
  }
});

test('agendamento semeado (retroativo) não recebe o aviso', async () => {
  db.fechar();
  db.conectar(':memory:');
  const original = agendamentos.listarProximosEmBlocos;
  const dh = datas.agora().plus({ days: 60 });
  const semeado = ag(900, dh);
  const r = db.reservarOuRetentar({
    codAgendamento: 900, codPaciente: 9, tipo: templates.TIPO_AGENDAMENTO,
    telefone: null, dataAgendamento: dh.toISO(),
  });
  db.marcarEnviado(r.id, { idMensagemMeta: null, simulado: true, telefone: null });
  agendamentos.listarProximosEmBlocos = async () => [semeado];
  try {
    await comConfig([
      [config.whatsapp, 'modoSeco', true],
      [config.meta.templates, 'agendamento', 'agendamento_realizado'],
      [config.jobs, 'envioHoraInicio', '00:00'],
      [config.jobs, 'envioHoraFim', '23:59'],
      [config.jobs, 'enviarSomenteDiasUteis', false],
    ], async () => {
      const c = await aviso.ciclo();
      assert.equal(c.simulado, 0);
      assert.equal(c.ja_enviado, 1);
    });
  } finally {
    agendamentos.listarProximosEmBlocos = original;
    db.fechar();
    db.conectar(':memory:');
  }
});

test('aviso fora da janela de envio não consulta nem envia', async () => {
  const original = agendamentos.listarProximosEmBlocos;
  let consultou = false;
  agendamentos.listarProximosEmBlocos = async () => { consultou = true; return []; };
  const agora = datas.agora();
  try {
    await comConfig([
      [config.jobs, 'envioHoraInicio', agora.minus({ hours: 2 }).toFormat('HH:mm')],
      [config.jobs, 'envioHoraFim', agora.minus({ hours: 1 }).toFormat('HH:mm')],
    ], async () => {
      const r = await aviso.ciclo();
      assert.equal(r.pulado, 'fora_da_janela');
    });
  } finally {
    agendamentos.listarProximosEmBlocos = original;
  }
  assert.equal(consultou, false);
});

test('listarProximosEmBlocos espera entre blocos (evita 429), não antes do primeiro', async () => {
  const original = agendamentos.listarTodos;
  const instantes = [];
  agendamentos.listarTodos = async () => { instantes.push(Date.now()); return []; };
  try {
    await agendamentos.listarProximosEmBlocos(90, 30, 20, 50);
  } finally {
    agendamentos.listarTodos = original;
  }
  assert.equal(instantes.length, 3);
  assert.ok(instantes[1] - instantes[0] >= 45, 'pausa entre o 1º e o 2º bloco');
  assert.ok(instantes[2] - instantes[1] >= 45, 'pausa entre o 2º e o 3º bloco');
});

test('aviso usa a janela e o horário configurados (padrões 730 dias, 08:30 seg–sex)', () => {
  assert.equal(config.jobs.avisoJanelaDias, 730);
  assert.equal(config.jobs.avisoCron, '30 8 * * 1-5');
});
