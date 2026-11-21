'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

const db = require('../src/db/db');
const campanhas = require('../src/jobs/campanhas');
const templates = require('../src/whatsapp/templates');
const pacientesApi = require('../src/clinicweb/pacientes');
const agendamentosApi = require('../src/clinicweb/agendamentos');
const datas = require('../src/lib/datas');
const { config } = require('../src/config');

db.conectar(':memory:');

test.beforeEach(() => {
  db.fechar();
  db.conectar(':memory:');
});

test.after(() => db.fechar());

const CONSENTIMENTO = { baseLegal: 'consentimento via WhatsApp', evidencia: 'ACEITO' };

// ---------------------------------------------------------------------------
// Opt-in — a trava legal das campanhas
// ---------------------------------------------------------------------------

test('paciente sem registro não tem opt-in', () => {
  assert.equal(db.temOptInAtivo(1), false);
});

test('consentimento fica ativo e guarda base legal e evidência', () => {
  db.registrarOptIn({ codPaciente: 1, ...CONSENTIMENTO, telefone: '5511999998888' });

  assert.equal(db.temOptInAtivo(1), true);

  const [linha] = db.listarOptIn('ativo');
  assert.equal(linha.baseLegal, CONSENTIMENTO.baseLegal);
  assert.equal(linha.evidencia, 'ACEITO');
  assert.ok(linha.consentidoEm, 'a data do consentimento é obrigatória para a LGPD');
});

test('revogação desliga o opt-in mas preserva o histórico', () => {
  db.registrarOptIn({ codPaciente: 1, ...CONSENTIMENTO });
  assert.equal(db.revogarOptIn({ codPaciente: 1, motivo: 'pediu SAIR' }), 1);

  assert.equal(db.temOptInAtivo(1), false);

  const [linha] = db.listarOptIn('revogado');
  assert.ok(linha.revogadoEm, 'a data da revogação é a prova de que atendemos');
  assert.equal(linha.consentidoEm !== null, true, 'o consentimento original não some');
});

test('revogar duas vezes não é erro e não conta duplicado', () => {
  db.registrarOptIn({ codPaciente: 1, ...CONSENTIMENTO });
  assert.equal(db.revogarOptIn({ codPaciente: 1 }), 1);
  assert.equal(db.revogarOptIn({ codPaciente: 1 }), 0);
});

test('revogação por telefone funciona sem saber quem é o paciente', () => {
  db.registrarOptIn({ codPaciente: 1, ...CONSENTIMENTO, telefone: '5511999998888' });

  assert.equal(db.revogarOptIn({ telefone: '5511999998888' }), 1);
  assert.equal(db.temOptInAtivo(1), false);
});

test('paciente pode voltar a consentir depois de revogar', () => {
  db.registrarOptIn({ codPaciente: 1, ...CONSENTIMENTO });
  db.revogarOptIn({ codPaciente: 1 });
  db.registrarOptIn({ codPaciente: 1, ...CONSENTIMENTO, evidencia: 'ACEITO de novo' });

  assert.equal(db.temOptInAtivo(1), true);
  const [linha] = db.listarOptIn('ativo');
  assert.equal(linha.revogadoEm, null);
});

test('revogarOptIn exige codPaciente ou telefone', () => {
  assert.throws(() => db.revogarOptIn({}), /codPaciente ou telefone/);
});

// ---------------------------------------------------------------------------
// Idempotência das campanhas
// ---------------------------------------------------------------------------

test('a mesma campanha na mesma competência só é reservada uma vez', () => {
  const primeira = db.reservarCampanha({ codPaciente: 1, tipo: 'aniversario', competencia: '2026-07' });
  const segunda = db.reservarCampanha({ codPaciente: 1, tipo: 'aniversario', competencia: '2026-07' });

  assert.ok(primeira?.id);
  assert.equal(segunda, null);
});

test('competência diferente é um envio novo (aniversário do ano seguinte)', () => {
  assert.ok(db.reservarCampanha({ codPaciente: 1, tipo: 'aniversario', competencia: '2026-07' }));
  assert.ok(db.reservarCampanha({ codPaciente: 1, tipo: 'aniversario', competencia: '2027-07' }));
});

test('aniversário e retorno na mesma competência não se bloqueiam', () => {
  assert.ok(db.reservarCampanha({ codPaciente: 1, tipo: 'aniversario', competencia: '2026-07' }));
  assert.ok(db.reservarCampanha({ codPaciente: 1, tipo: 'retorno', competencia: '2026-07' }));
});

// ---------------------------------------------------------------------------
// Disparo — a checagem de opt-in vem antes de tudo
// ---------------------------------------------------------------------------

function comModoSeco(fn) {
  const seco = config.whatsapp.modoSeco;
  const aniversario = config.meta.templates.aniversario;
  const retorno = config.meta.templates.retorno;

  config.whatsapp.modoSeco = true;
  config.meta.templates.aniversario = 'felicitacao_aniversario';
  config.meta.templates.retorno = 'lembrete_retorno';

  return Promise.resolve(fn()).finally(() => {
    config.whatsapp.modoSeco = seco;
    config.meta.templates.aniversario = aniversario;
    config.meta.templates.retorno = retorno;
  });
}

test('sem opt-in, a campanha NÃO é enviada nem reservada', async () => {
  await comModoSeco(async () => {
    const status = await campanhas.dispararCampanha({
      codPaciente: 1,
      nome: 'MARIA DA SILVA',
      telefone: { ddd: '11', tel: '999998888' },
      tipo: 'aniversario',
      competencia: '2026-07',
    });

    assert.equal(status, 'sem_optin');
    assert.equal(db.resumo().campanhas.aniversario_pendente, undefined);
  });
});

test('com opt-in, envia uma vez e bloqueia a segunda na mesma competência', async () => {
  db.registrarOptIn({ codPaciente: 1, ...CONSENTIMENTO });

  await comModoSeco(async () => {
    const paciente = {
      codPaciente: 1,
      nome: 'MARIA DA SILVA',
      telefone: { ddd: '11', tel: '999998888' },
      tipo: 'aniversario',
      competencia: '2026-07',
    };

    assert.equal(await campanhas.dispararCampanha(paciente), 'simulado');
    assert.equal(await campanhas.dispararCampanha(paciente), 'ja_enviado');
  });
});

test('opt-in revogado no meio do caminho interrompe os envios seguintes', async () => {
  db.registrarOptIn({ codPaciente: 1, ...CONSENTIMENTO });

  await comModoSeco(async () => {
    const base = {
      codPaciente: 1,
      nome: 'MARIA',
      telefone: { ddd: '11', tel: '999998888' },
      tipo: 'aniversario',
    };

    assert.equal(await campanhas.dispararCampanha({ ...base, competencia: '2026-07' }), 'simulado');

    db.revogarOptIn({ codPaciente: 1 });

    assert.equal(await campanhas.dispararCampanha({ ...base, competencia: '2027-07' }), 'sem_optin');
  });
});

test('telefone inválido é registrado como inválido e não repetido', async () => {
  db.registrarOptIn({ codPaciente: 1, ...CONSENTIMENTO });

  await comModoSeco(async () => {
    const paciente = {
      codPaciente: 1,
      nome: 'MARIA',
      telefone: { ddd: '', tel: '' },
      tipo: 'retorno',
      competencia: '2026-07',
    };

    assert.equal(await campanhas.dispararCampanha(paciente), 'invalido');
    assert.equal(await campanhas.dispararCampanha(paciente), 'ja_enviado');
  });
});

// ---------------------------------------------------------------------------
// Templates de Marketing
// ---------------------------------------------------------------------------

test('aniversário e retorno levam só nome e clínica — nada de dado clínico', () => {
  const original = config.clinica.nome;
  config.clinica.nome = 'Clínica Exemplo';

  try {
    const aniversario = templates.aniversario({ nome: 'MARIA DA SILVA' });
    assert.deepEqual(aniversario.parametros, ['Maria', 'Clínica Exemplo']);
    assert.equal(aniversario.tipo, 'aniversario');

    const retorno = templates.retorno({ nome: 'JOÃO PEDRO SOUZA' });
    assert.deepEqual(retorno.parametros, ['João', 'Clínica Exemplo']);
    assert.equal(retorno.tipo, 'retorno');
  } finally {
    config.clinica.nome = original;
  }
});

// ---------------------------------------------------------------------------
// Regra de recall (confirmada na Sessão 4)
// ---------------------------------------------------------------------------

/** Monta um agendamento no formato da ClinicWeb. */
function ag(codPaciente, quando, extra = {}) {
  return {
    codAgendamento: codPaciente * 10,
    codPaciente,
    data: `${quando.toFormat('yyyy-MM-dd')}T00:00:00.000Z`,
    hora: '10:00:00',
    ativo: 'S',
    Paciente: { nome: `PACIENTE ${codPaciente}`, dddCelular: '11', telCelular: '999998888' },
    GrupoProcedimento: { nome: 'Ultrassom' },
    ...extra,
  };
}

async function comRecallSimulado(naFaixa, futuros, fn) {
  const originalListar = agendamentosApi.listarTodos;
  const chamadas = [];

  agendamentosApi.listarTodos = async (opcoes) => {
    chamadas.push(opcoes);
    // A primeira chamada é a varredura da faixa; a segunda checa quem voltou.
    return chamadas.length === 1 ? naFaixa : futuros;
  };

  try {
    return await fn(chamadas);
  } finally {
    agendamentosApi.listarTodos = originalListar;
  }
}

test('recall pega quem foi atendido na faixa e não voltou', async () => {
  const agora = datas.agora();
  const naFaixa = agora.minus({ months: 6, days: 5 });

  await comRecallSimulado([ag(1, naFaixa), ag(2, naFaixa)], [ag(2, agora.plus({ days: 10 }))], async () => {
    const lista = await pacientesApi.paraRecall({ meses: 6, janelaDias: 30 });

    assert.equal(lista.length, 1);
    assert.equal(lista[0].codPaciente, 1, 'o paciente 2 tem consulta marcada, não é recall');
    assert.equal(lista[0].nome, 'PACIENTE 1');
    assert.deepEqual(lista[0].telefone, { ddi: undefined, ddd: '11', tel: '999998888' });
  });
});

test('a faixa consultada olha só para trás — nunca dispara antes dos N meses', async () => {
  await comRecallSimulado([], [], async (chamadas) => {
    await pacientesApi.paraRecall({ meses: 6, janelaDias: 30 });

    const faixa = chamadas[0];
    const agora = datas.agora();
    const fimEsperado = datas.paraDataApi(agora.minus({ months: 6 }));
    const inicioEsperado = datas.paraDataApi(agora.minus({ months: 6 }).minus({ days: 30 }));

    assert.equal(faixa.endDate, fimEsperado);
    assert.equal(faixa.startDate, inicioEsperado);
    assert.ok(faixa.endDate <= datas.paraDataApi(agora), 'a faixa não pode alcançar o presente');
  });
});

test('agendamento inativo (cancelado) não gera candidato nem impede recall', async () => {
  const agora = datas.agora();
  const naFaixa = agora.minus({ months: 6, days: 3 });

  await comRecallSimulado(
    [ag(1, naFaixa), ag(2, naFaixa, { ativo: 'N' })],
    [ag(1, agora.plus({ days: 5 }), { ativo: 'N' })], // consulta futura CANCELADA
    async () => {
      const lista = await pacientesApi.paraRecall({ meses: 6, janelaDias: 30 });

      const codigos = lista.map((p) => p.codPaciente);
      assert.deepEqual(codigos, [1], 'cancelamento futuro não conta como "voltou"');
    },
  );
});

test('quando o paciente tem vários atendimentos na faixa, vale o mais recente', async () => {
  const agora = datas.agora();
  const antigo = agora.minus({ months: 6, days: 25 });
  const recente = agora.minus({ months: 6, days: 2 });

  await comRecallSimulado([ag(1, antigo), ag(1, recente)], [], async () => {
    const lista = await pacientesApi.paraRecall({ meses: 6, janelaDias: 30 });

    assert.equal(lista.length, 1);
    assert.equal(
      lista[0].ultimoAgendamento.toFormat('yyyy-MM-dd'),
      recente.toFormat('yyyy-MM-dd'),
    );
  });
});

test('competência do recall vem do último agendamento, não do disparo', () => {
  // É o que impede o mesmo paciente de receber dois convites quando a janela
  // deslizante atravessa a virada de mês.
  const ultimo = DateTime.fromISO('2026-01-28T10:00:00', { zone: datas.FUSO });
  assert.equal(datas.competencia(ultimo), '2026-01');

  const outroDiaDaMesmaJanela = DateTime.fromISO('2026-01-30T10:00:00', { zone: datas.FUSO });
  assert.equal(datas.competencia(outroDiaDaMesmaJanela), '2026-01');
});

test('sem candidatos, nem chega a consultar quem voltou', async () => {
  await comRecallSimulado([], [], async (chamadas) => {
    const lista = await pacientesApi.paraRecall({ meses: 6 });
    assert.deepEqual(lista, []);
    assert.equal(chamadas.length, 1, 'só a varredura da faixa');
  });
});

// ---------------------------------------------------------------------------
// Ciclo diário
// ---------------------------------------------------------------------------

test('campanhas desligadas não fazem nada', async () => {
  const original = config.jobs.campanhasAtivas;
  config.jobs.campanhasAtivas = false;

  try {
    assert.deepEqual(await campanhas.ciclo(), { pulado: 'desligadas' });
  } finally {
    config.jobs.campanhasAtivas = original;
  }
});

test('o teto diário limita quantos recebem por dia', async () => {
  const originalTeto = config.jobs.campanhaMaxPorDia;
  const originalAniversariantes = pacientesApi.aniversariantesDe;

  config.jobs.campanhaMaxPorDia = 2;
  pacientesApi.aniversariantesDe = async () =>
    [1, 2, 3, 4, 5].map((i) => ({
      idPaciente: i,
      nome: `PACIENTE ${i}`,
      dddCelular: '11',
      telCelular: '999998888',
      ativo: 'S',
    }));

  for (const i of [1, 2, 3, 4, 5]) db.registrarOptIn({ codPaciente: i, ...CONSENTIMENTO });

  try {
    await comModoSeco(async () => {
      const r = await campanhas.aniversariantes();
      assert.equal(r.candidatos, 5);
      assert.equal(r.simulado, 2, 'só o teto foi disparado');
    });
  } finally {
    config.jobs.campanhaMaxPorDia = originalTeto;
    pacientesApi.aniversariantesDe = originalAniversariantes;
  }
});

test('falha da API na busca de aniversariantes não derruba o ciclo', async () => {
  const original = pacientesApi.aniversariantesDe;
  pacientesApi.aniversariantesDe = async () => {
    throw new Error('Parâmetro query é obrigatório');
  };

  try {
    const r = await campanhas.aniversariantes();
    assert.equal(r.pulado, 'erro_api');
  } finally {
    pacientesApi.aniversariantesDe = original;
  }
});

test('paciente inativo ou falecido é pulado na campanha de aniversário', async () => {
  const original = pacientesApi.aniversariantesDe;
  pacientesApi.aniversariantesDe = async () => [
    { idPaciente: 1, nome: 'ATIVO', dddCelular: '11', telCelular: '999998888', ativo: 'S', vivo: 1 },
    { idPaciente: 2, nome: 'INATIVO', dddCelular: '11', telCelular: '999998888', ativo: 'N', vivo: 1 },
    { idPaciente: 3, nome: 'FALECIDO', dddCelular: '11', telCelular: '999998888', ativo: 'S', vivo: 0 },
  ];

  for (const i of [1, 2, 3]) db.registrarOptIn({ codPaciente: i, ...CONSENTIMENTO });

  try {
    await comModoSeco(async () => {
      const r = await campanhas.aniversariantes();
      assert.equal(r.candidatos, 3);
      assert.equal(r.simulado, 1, 'só o paciente ativo e vivo recebe');
    });
  } finally {
    pacientesApi.aniversariantesDe = original;
  }
});
