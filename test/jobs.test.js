'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

const polling = require('../src/jobs/polling');
const lembrete = require('../src/jobs/lembrete');
const templates = require('../src/whatsapp/templates');
const cliente = require('../src/whatsapp/client');
const datas = require('../src/lib/datas');
const db = require('../src/db/db');
const { config } = require('../src/config');

// Banco em memória ANTES de qualquer teste: um ciclo de job que chegue ao
// banco não pode criar o SQLite de verdade dentro do projeto.
db.conectar(':memory:');

const AGORA = DateTime.fromISO('2026-08-01T10:00:00', { zone: datas.FUSO });

/** Agendamento de exemplo, no formato que a ClinicWeb devolve. */
function agendamento(extra = {}) {
  const dataHora = extra.dataHora ?? AGORA.plus({ days: 3 });
  return {
    codAgendamento: 1,
    codPaciente: 9,
    codProcedimento: 4649,
    data: `${dataHora.toFormat('yyyy-MM-dd')}T00:00:00.000Z`,
    hora: dataHora.toFormat('HH:mm:ss'),
    status: 1,
    ativo: 'S',
    dataHora,
    GrupoProcedimento: { codGrupoProcedimento: 4649, nome: 'Ultrassom' },
    Paciente: { nome: 'MARIA DA SILVA', dddCelular: '11', telCelular: '999998888' },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Polling — elegibilidade
// ---------------------------------------------------------------------------

test('agendamento longe, com aviso DESLIGADO (padrão), apenas aguarda o dia', () => {
  const longe = agendamento({ dataHora: AGORA.plus({ days: 10 }) });
  assert.equal(polling.decidir(longe, AGORA).ok, false);
  assert.equal(polling.decidir(longe, AGORA).motivo, 'aguardando_dia_confirmacao');
});

test('agendamento longe, decidido para o job de AVISO (comAviso), recebe o aviso', () => {
  const d = polling.decidir(agendamento({ dataHora: AGORA.plus({ days: 10 }) }), AGORA, { comAviso: true });
  assert.equal(d.ok, true);
  assert.equal(d.tipo, templates.TIPO_AGENDAMENTO);
});

test('o polling nunca decide aviso, mesmo com AVISO_ATIVO (o aviso é do job diário)', () => {
  const orig = config.jobs.avisoAtivo;
  config.jobs.avisoAtivo = true;
  try {
    const d = polling.decidir(agendamento({ dataHora: AGORA.plus({ days: 10 }) }), AGORA);
    assert.equal(d.ok, false);
    assert.equal(d.motivo, 'aguardando_dia_confirmacao');
  } finally {
    config.jobs.avisoAtivo = orig;
  }
});

test('dentro da janela de confirmação, pede a confirmação', () => {
  const proximo = agendamento({ dataHora: AGORA.plus({ hours: 48 }) });
  const d = polling.decidir(proximo, AGORA);
  assert.equal(d.ok, true);
  assert.equal(d.tipo, templates.TIPO_CONFIRMACAO);
});

test('agendamento que já passou não recebe nada', () => {
  const passado = agendamento({ dataHora: AGORA.minus({ hours: 2 }) });
  assert.deepEqual(polling.decidir(passado, AGORA), { ok: false, motivo: 'ja_passou' });
});

test('agendamento já confirmado não recebe pedido de confirmação na janela', () => {
  const confirmado = agendamento({
    dataHora: AGORA.plus({ hours: 48 }),
    status: config.clinicweb.status.confirmado,
  });
  assert.equal(polling.decidir(confirmado, AGORA).motivo, 'ja_confirmado');
});

test('confirmado não recebe nada — nem aviso nem pedido (qualquer distância)', () => {
  const confirmadoLonge = agendamento({
    dataHora: AGORA.plus({ days: 10 }),
    status: config.clinicweb.status.confirmado,
  });
  assert.equal(polling.decidir(confirmadoLonge, AGORA).motivo, 'ja_confirmado');
});

test('Não chegou (3) é o padrão não-confirmado → recebe confirmação e lembrete', () => {
  const naoChegou = agendamento({ dataHora: AGORA.plus({ hours: 10 }), status: 3 });
  const d = polling.decidir(naoChegou, AGORA);
  assert.equal(d.ok, true);
  assert.equal(d.tipo, templates.TIPO_CONFIRMACAO);
  assert.equal(lembrete.elegivelParaLembrete(naoChegou).ok, true);
});

test('status fora do fluxo (ex.: Atendido = 9) não recebe mensagem', () => {
  const atendido = agendamento({ dataHora: AGORA.plus({ hours: 48 }), status: 9 });
  assert.equal(polling.decidir(atendido, AGORA).motivo, 'status_9');
  assert.equal(lembrete.elegivelParaLembrete(atendido).motivo, 'status_9');
});

test('agendamento cancelado ou inativo é ignorado', () => {
  const cancelado = agendamento({ status: config.clinicweb.status.canceladoPaciente });
  assert.equal(polling.decidir(cancelado, AGORA).motivo, `status_${config.clinicweb.status.canceladoPaciente}`);

  const inativo = agendamento({ ativo: 'N' });
  assert.equal(polling.decidir(inativo, AGORA).motivo, 'agendamento_inativo');
});

test('agendamento com data inválida não quebra o ciclo', () => {
  const quebrado = agendamento({ dataHora: null, data: 'banana', hora: null });
  assert.equal(polling.decidir(quebrado, AGORA).motivo, 'data_invalida');
  assert.equal(polling.decidir(null, AGORA).ok, false);
});

test('expressão cron acompanha o intervalo configurado', () => {
  assert.equal(polling.expressaoCron(30), '*/30 * * * *');
  assert.equal(polling.expressaoCron(15), '*/15 * * * *');
  assert.equal(polling.expressaoCron(120), '0 */2 * * *');
});

// ---------------------------------------------------------------------------
// Lembrete — janelas
// ---------------------------------------------------------------------------

test('ehVespera: consulta de amanhã é véspera; hoje e depois de amanhã não', () => {
  const ref = DateTime.fromISO('2026-08-05T19:00:00', { zone: datas.FUSO }); // qua 19h
  assert.equal(lembrete.ehVespera(agendamento({ dataHora: ref.plus({ days: 1 }).set({ hour: 9 }) }), ref), true);
  assert.equal(lembrete.ehVespera(agendamento({ dataHora: ref.set({ hour: 20 }) }), ref), false);
  assert.equal(lembrete.ehVespera(agendamento({ dataHora: ref.plus({ days: 2 }) }), ref), false);
});

test('ehVespera vale no DOMINGO para consulta de segunda', () => {
  const domingo = DateTime.fromISO('2026-08-09T18:30:00', { zone: datas.FUSO });
  const seg = agendamento({ dataHora: DateTime.fromISO('2026-08-10T09:00:00', { zone: datas.FUSO }) });
  assert.equal(lembrete.ehVespera(seg, domingo), true);
});

test('diasDeBusca cobre amanhã', () => {
  assert.equal(lembrete.diasDeBusca(), 2);
});

test('lembrete sem horasAntes usa o tipo único "lembrete" (véspera)', () => {
  assert.equal(templates.lembrete(agendamento()).tipo, 'lembrete');
});

test('lembrete respeita cancelamento mas segue valendo para confirmado', () => {
  assert.equal(lembrete.elegivelParaLembrete(agendamento()).ok, true);
  assert.equal(
    lembrete.elegivelParaLembrete(agendamento({ status: config.clinicweb.status.confirmado })).ok,
    true,
  );
  assert.equal(
    lembrete.elegivelParaLembrete(agendamento({ status: config.clinicweb.status.canceladoPaciente }))
      .motivo,
    `status_${config.clinicweb.status.canceladoPaciente}`,
  );
  assert.equal(lembrete.elegivelParaLembrete(agendamento({ ativo: 'N' })).motivo, 'agendamento_inativo');
});

// ---------------------------------------------------------------------------
// Templates — ordem das variáveis (docs/08)
// ---------------------------------------------------------------------------

test('confirmação monta {{1}}..{{5}} na ordem do template aprovado', () => {
  const nomeOriginal = config.clinica.nome;
  const profOriginal = config.whatsapp.profissionalPorCod;
  config.clinica.nome = 'Clínica Exemplo';
  config.whatsapp.profissionalPorCod = { 12: 'Dra. Ana' };

  try {
    const m = templates.confirmacao(
      agendamento({ dataHora: AGORA.set({ hour: 14, minute: 30 }), codProfissional: 12 }),
    );

    assert.deepEqual(m.parametros, [
      'Maria', // {{1}} primeiro nome
      'Dra. Ana', // {{2}} profissional (mapa PROFISSIONAL_POR_COD)
      'Clínica Exemplo', // {{3}} clínica
      '01/08', // {{4}} data
      '14:30', // {{5}} hora
    ]);
    assert.equal(m.tipo, 'confirmacao');
  } finally {
    config.clinica.nome = nomeOriginal;
    config.whatsapp.profissionalPorCod = profOriginal;
  }
});

test('profissional vem da API como "Dr./Dra. <primeiro nome>" (tratamento pelo sexo)', () => {
  const profOriginal = config.whatsapp.profissionalPorCod;
  config.whatsapp.profissionalPorCod = {};
  try {
    const homem = templates.confirmacao(
      agendamento({
        codProfissional: 58364023,
        Profissional: { codUsuario: 4242, nome: 'CARLOS ALBERTO LIMA', sexo: 'M' },
      }),
    );
    assert.equal(homem.parametros[1], 'Dr. Carlos');

    const mulher = templates.agendamentoRealizado(
      agendamento({
        codProfissional: 111,
        Profissional: { codUsuario: 111, nome: 'ANA LIMA', sexo: 'F' },
      }),
    );
    assert.equal(mulher.parametros[1], 'Dra. Ana');
  } finally {
    config.whatsapp.profissionalPorCod = profOriginal;
  }
});

test('PROFISSIONAL_POR_COD tem prioridade sobre o nome da API', () => {
  const profOriginal = config.whatsapp.profissionalPorCod;
  config.whatsapp.profissionalPorCod = { 58364023: 'Dr. Carlos Menezes' };
  try {
    const m = templates.confirmacao(
      agendamento({
        codProfissional: 58364023,
        Profissional: { codUsuario: 4242, nome: 'CARLOS ALBERTO LIMA', sexo: 'M' },
      }),
    );
    assert.equal(m.parametros[1], 'Dr. Carlos Menezes');
  } finally {
    config.whatsapp.profissionalPorCod = profOriginal;
  }
});

test('PROFISSIONAL_POR_NOME corrige tratamento quando o sexo da API vem errado', () => {
  const nomeOrig = config.whatsapp.profissionalPorNome;
  const codOrig = config.whatsapp.profissionalPorCod;
  config.whatsapp.profissionalPorCod = {};
  config.whatsapp.profissionalPorNome = { carlos: 'Dr. Carlos', ana: 'Dra. Ana' };
  try {
    // sexo='F' no ClinicWeb, mas o mapa por nome manda: NAO pode virar "Dra. Carlos".
    const m = templates.confirmacao(
      agendamento({
        codProfissional: 999,
        Profissional: { codUsuario: 999, nome: 'CARLOS ALBERTO LIMA', sexo: 'F' },
      }),
    );
    assert.equal(m.parametros[1], 'Dr. Carlos');
  } finally {
    config.whatsapp.profissionalPorNome = nomeOrig;
    config.whatsapp.profissionalPorCod = codOrig;
  }
});

test('procedimento (helper) normaliza a caixa para titulo-caso', () => {
  // O procedimento nao entra mais no corpo das mensagens, mas o helper
  // continua exportado (uso futuro / relatorios).
  assert.equal(templates.procedimento({ GrupoProcedimento: { nome: 'ESTETICA' } }), 'Estetica');
  assert.equal(templates.procedimento({ GrupoProcedimento: { nome: 'SESSÃO' } }), 'Sessão');
});

test('aviso de agendamento realizado monta {{1}}..{{5}} com profissional (fallback "nossa equipe")', () => {
  const nomeOriginal = config.clinica.nome;
  const profOriginal = config.whatsapp.profissionalPorCod;
  config.clinica.nome = 'Clínica Exemplo';
  config.whatsapp.profissionalPorCod = {}; // sem mapa e sem nome na API -> fallback

  try {
    const m = templates.agendamentoRealizado(
      agendamento({ dataHora: AGORA.set({ hour: 14, minute: 30 }), codProfissional: undefined }),
    );
    assert.equal(m.tipo, 'agendamento_realizado');
    assert.deepEqual(m.parametros, [
      'Maria',
      'nossa equipe',
      'Clínica Exemplo',
      '01/08',
      '14:30',
    ]);
  } finally {
    config.clinica.nome = nomeOriginal;
    config.whatsapp.profissionalPorCod = profOriginal;
  }
});

test('lembrete monta {{1}}..{{7}} incluindo endereço e preparo', () => {
  const enderecoOriginal = config.clinica.endereco;
  const preparosOriginal = config.whatsapp.preparoPorProcedimento;
  config.clinica.endereco = 'Rua X, 100 — Centro';
  config.whatsapp.preparoPorProcedimento = { 4649: 'Comparecer em jejum de 8h.' };

  try {
    const m = templates.lembrete(agendamento({ dataHora: AGORA.set({ hour: 9, minute: 0 }) }), 48);

    assert.equal(m.parametros.length, 7);
    assert.equal(m.parametros[1], 'nossa equipe'); // {{2}} profissional (fallback)
    assert.equal(m.parametros[5], 'Rua X, 100 — Centro');
    assert.equal(m.parametros[6], 'Comparecer em jejum de 8h.');
    assert.equal(m.tipo, 'lembrete_48h');
  } finally {
    config.clinica.endereco = enderecoOriginal;
    config.whatsapp.preparoPorProcedimento = preparosOriginal;
  }
});

test('recomendacao geral e anexada ao {{7}} de todos os lembretes', () => {
  const preparosOriginal = config.whatsapp.preparoPorProcedimento;
  const geralOriginal = config.whatsapp.recomendacaoGeral;
  config.whatsapp.recomendacaoGeral = 'Somente 1 acompanhante por paciente.';

  try {
    config.whatsapp.preparoPorProcedimento = {};
    const semPreparo = templates.lembrete(agendamento(), 24);
    assert.equal(semPreparo.parametros[6], 'Somente 1 acompanhante por paciente.');

    config.whatsapp.preparoPorProcedimento = { 4649: 'Comparecer em jejum de 8h.' };
    const comPreparo = templates.lembrete(agendamento(), 24);
    assert.equal(
      comPreparo.parametros[6],
      'Comparecer em jejum de 8h. Somente 1 acompanhante por paciente.',
    );
  } finally {
    config.whatsapp.preparoPorProcedimento = preparosOriginal;
    config.whatsapp.recomendacaoGeral = geralOriginal;
  }
});

test('cada horizonte de lembrete tem um tipo próprio (idempotência)', () => {
  const ag = agendamento();
  assert.equal(templates.lembrete(ag, 48).tipo, 'lembrete_48h');
  assert.equal(templates.lembrete(ag, 24).tipo, 'lembrete_24h');
});

test('nenhum parâmetro sai vazio ou com quebra de linha (a Meta recusa)', () => {
  const semNada = agendamento({
    Paciente: { nome: '', dddCelular: '', telCelular: '' },
    GrupoProcedimento: null,
  });

  const m = templates.lembrete(semNada, 24);
  for (const [i, p] of m.parametros.entries()) {
    assert.notEqual(p, '', `parâmetro {{${i + 1}}} vazio`);
    assert.doesNotMatch(p, /[\r\n\t]/, `parâmetro {{${i + 1}}} com quebra de linha`);
  }
});

test('data/hora inválida vira erro permanente, não mensagem torta', () => {
  const quebrado = { codAgendamento: 5, data: 'banana', Paciente: { nome: 'X' } };
  assert.throws(() => templates.confirmacao(quebrado), /data\/hora inválida/);
});

// ---------------------------------------------------------------------------
// Cliente da Meta — corpo da requisição e modo seco
// ---------------------------------------------------------------------------

test('corpo do template message segue o formato da Cloud API', () => {
  const corpo = cliente.montarCorpo('5511999998888', {
    nomeTemplate: 'confirmacao_agendamento',
    idioma: 'pt_BR',
    parametros: ['Maria', 'Ultrassom', 'Clínica', '01/08', '14:30'],
  });

  assert.equal(corpo.messaging_product, 'whatsapp');
  assert.equal(corpo.to, '5511999998888');
  assert.equal(corpo.template.name, 'confirmacao_agendamento');
  assert.equal(corpo.template.language.code, 'pt_BR');
  assert.equal(corpo.template.components[0].parameters.length, 5);
  assert.deepEqual(corpo.template.components[0].parameters[0], { type: 'text', text: 'Maria' });
});

test('modo seco não envia e devolve id simulado', async () => {
  const original = config.whatsapp.modoSeco;
  config.whatsapp.modoSeco = true;

  try {
    const r = await cliente.enviarTemplate(
      { ddd: '11', tel: '999998888' },
      { nomeTemplate: 'confirmacao_agendamento', idioma: 'pt_BR', parametros: ['Maria'] },
    );

    assert.equal(r.ok, true);
    assert.equal(r.simulado, true);
    assert.match(r.idMensagemMeta, /^seco-/);
  } finally {
    config.whatsapp.modoSeco = original;
  }
});

test('telefone inválido nem chega a tentar enviar', async () => {
  const r = await cliente.enviarTemplate(
    { ddd: '', tel: '' },
    { nomeTemplate: 'x', idioma: 'pt_BR', parametros: [] },
  );

  assert.equal(r.ok, false);
  assert.equal(r.definitivo, true);
  assert.match(r.erro, /telefone_/);
});

test('erro da Meta é classificado entre definitivo e retentável', () => {
  const definitivo = cliente.detalharErro({
    response: { data: { error: { code: 132000, message: 'número de parâmetros errado' } } },
  });
  assert.equal(definitivo.definitivo, true);

  const transitorio = cliente.detalharErro({
    response: { data: { error: { code: 131056, message: 'limite de taxa' } } },
  });
  assert.equal(transitorio.definitivo, false);

  const rede = cliente.detalharErro(new Error('ECONNRESET'));
  assert.equal(rede.definitivo, false);
});

// ---------------------------------------------------------------------------
// Ciclo do polling ponta a ponta (ClinicWeb e Meta simulados)
// ---------------------------------------------------------------------------

test('ciclo do polling envia uma vez e ignora na segunda passada', async () => {
  db.fechar();
  db.conectar(':memory:');

  const agendamentos = require('../src/clinicweb/agendamentos');
  const originalListar = agendamentos.listarProximos;
  const originalSeco = config.whatsapp.modoSeco;
  const originalTemplate = config.meta.templates.confirmacao;
  const originalTemplateAviso = config.meta.templates.agendamento;
  const originalInicio = config.jobs.envioHoraInicio;
  const originalFim = config.jobs.envioHoraFim;
  const originalAviso = config.jobs.avisoAtivo;
  const originalDiasUteis = config.jobs.enviarSomenteDiasUteis;

  config.whatsapp.modoSeco = true;
  config.meta.templates.confirmacao = 'confirmacao_consulta';
  config.meta.templates.agendamento = 'agendamento_realizado';
  config.jobs.envioHoraInicio = '00:00';
  config.jobs.envioHoraFim = '23:59';
  config.jobs.avisoAtivo = true; // mesmo ligado, o polling não manda aviso
  config.jobs.enviarSomenteDiasUteis = false; // teste roda em qualquer dia

  const agoraFixo = datas.agora();
  agendamentos.listarProximos = async () => [
    agendamento({ codAgendamento: 500, dataHora: agoraFixo.plus({ days: 2 }) }), // janela -> confirmacao
    agendamento({ codAgendamento: 502, dataHora: agoraFixo.plus({ days: 10 }) }), // longe -> nada (aviso é do job diário)
    agendamento({ codAgendamento: 501, dataHora: agoraFixo.minus({ days: 1 }) }), // passado
  ];

  try {
    const primeiro = await polling.ciclo();
    assert.equal(primeiro.encontrados, 3);
    assert.equal(primeiro.simulado, 1);
    assert.equal(primeiro.inelegiveis.ja_passou, 1);
    assert.equal(primeiro.inelegiveis.aguardando_dia_confirmacao, 1);
    assert.equal(primeiro.porTipo.confirmacao, 1);
    assert.equal(primeiro.porTipo.agendamento_realizado, undefined);

    // segunda passada: o banco impede o reenvio
    const segundo = await polling.ciclo();
    assert.equal(segundo.simulado, 0);
    assert.equal(segundo.ja_enviado, 1);
  } finally {
    agendamentos.listarProximos = originalListar;
    config.whatsapp.modoSeco = originalSeco;
    config.meta.templates.confirmacao = originalTemplate;
    config.meta.templates.agendamento = originalTemplateAviso;
    config.jobs.envioHoraInicio = originalInicio;
    config.jobs.envioHoraFim = originalFim;
    config.jobs.avisoAtivo = originalAviso;
    config.jobs.enviarSomenteDiasUteis = originalDiasUteis;
    db.fechar();
    db.conectar(':memory:'); // nunca deixar o próximo teste cair no banco real
  }
});

test('fora da janela de horário o ciclo não envia nada', async () => {
  const originalInicio = config.jobs.envioHoraInicio;
  const originalFim = config.jobs.envioHoraFim;

  // janela impossível: 1 minuto no passado
  const agora = datas.agora();
  config.jobs.envioHoraInicio = agora.minus({ hours: 2 }).toFormat('HH:mm');
  config.jobs.envioHoraFim = agora.minus({ hours: 1 }).toFormat('HH:mm');

  try {
    const r = await polling.ciclo();
    assert.equal(r.pulado, 'fora_da_janela');
  } finally {
    config.jobs.envioHoraInicio = originalInicio;
    config.jobs.envioHoraFim = originalFim;
  }
});

// ---------------------------------------------------------------------------
// Remarcação após confirmação (reconfirmar na nova data)
// ---------------------------------------------------------------------------

test('confirmado para a MESMA data não repete o pedido', () => {
  const dh = AGORA.plus({ hours: 48 });
  const ag = agendamento({ dataHora: dh, status: config.clinicweb.status.confirmado });
  const d = polling.decidir(ag, AGORA, { dataConfirmada: dh.toISO() });
  assert.equal(d.motivo, 'ja_confirmado');
});

test('confirmado mas remarcado para dentro da janela volta a pedir confirmação', () => {
  const ag = agendamento({ dataHora: AGORA.plus({ hours: 48 }), status: config.clinicweb.status.confirmado });
  // já pedimos confirmação para OUTRA data (a antiga)
  const d = polling.decidir(ag, AGORA, { dataConfirmada: AGORA.plus({ days: 9 }).toISO() });
  assert.equal(d.ok, true);
  assert.equal(d.tipo, templates.TIPO_CONFIRMACAO);
});

test('confirmado mas remarcado para data distante volta a avisar (aviso da nova data)', () => {
  const ag = agendamento({ dataHora: AGORA.plus({ days: 10 }), status: config.clinicweb.status.confirmado });
  const d = polling.decidir(ag, AGORA, { dataConfirmada: AGORA.plus({ days: 3 }).toISO(), comAviso: true });
  assert.equal(d.ok, true);
  assert.equal(d.tipo, templates.TIPO_AGENDAMENTO);
});

test('confirmado sem registro de confirmação anterior continua pulando', () => {
  const ag = agendamento({ dataHora: AGORA.plus({ hours: 48 }), status: config.clinicweb.status.confirmado });
  const d = polling.decidir(ag, AGORA, { dataConfirmada: null });
  assert.equal(d.motivo, 'ja_confirmado');
});

// ---------------------------------------------------------------------------
// Confirmação: 2 dias antes, antecipando para a sexta no fim de semana
// ---------------------------------------------------------------------------

const SEXTA = DateTime.fromISO('2026-08-07T10:00:00', { zone: datas.FUSO });
const QUINTA = DateTime.fromISO('2026-08-06T10:00:00', { zone: datas.FUSO });

test('na sexta, consulta de SEGUNDA recebe confirmação (antecipada do sábado)', () => {
  const seg = agendamento({ dataHora: SEXTA.plus({ days: 3 }).set({ hour: 9 }) }); // 10/08 seg
  const d = polling.decidir(seg, SEXTA);
  assert.equal(d.ok, true);
  assert.equal(d.tipo, templates.TIPO_CONFIRMACAO);
});

test('na sexta, consulta de TERÇA recebe confirmação (antecipada do domingo)', () => {
  const ter = agendamento({ dataHora: SEXTA.plus({ days: 4 }).set({ hour: 9 }) }); // 11/08 ter
  const d = polling.decidir(ter, SEXTA);
  assert.equal(d.ok, true);
  assert.equal(d.tipo, templates.TIPO_CONFIRMACAO);
});

test('na sexta, consulta de QUARTA ainda aguarda (dia certo é segunda)', () => {
  const qua = agendamento({ dataHora: SEXTA.plus({ days: 5 }).set({ hour: 9 }) }); // 12/08 qua
  const d = polling.decidir(qua, SEXTA);
  assert.equal(d.ok, false);
  assert.equal(d.motivo, 'aguardando_dia_confirmacao');
});

test('consulta de segunda não é confirmada já na quinta (cedo demais)', () => {
  const seg = agendamento({ dataHora: QUINTA.plus({ days: 4 }).set({ hour: 9 }) }); // 10/08 seg
  const d = polling.decidir(seg, QUINTA);
  assert.equal(d.ok, false);
  assert.equal(d.motivo, 'aguardando_dia_confirmacao');
});
