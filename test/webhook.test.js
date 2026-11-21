'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const webhook = require('../src/whatsapp/webhook');
const agendamentos = require('../src/clinicweb/agendamentos');
const db = require('../src/db/db');
const { config } = require('../src/config');

// ---------------------------------------------------------------------------
// Interpretação
// ---------------------------------------------------------------------------

test('respostas afirmativas confirmam', () => {
  for (const texto of ['sim', 'SIM', 'Sim!', 'ok', 'confirmo', 'Confirmado', '1', 'Confirmar presença', 'pode confirmar']) {
    assert.equal(webhook.interpretar(texto), 'confirmar', `"${texto}"`);
  }
});

test('respostas negativas cancelam', () => {
  for (const texto of ['não', 'nao', 'NÃO', 'cancelar', 'Cancela', 'desmarcar', '2', 'não posso', 'nao vou']) {
    assert.equal(webhook.interpretar(texto), 'cancelar', `"${texto}"`);
  }
});

test('resposta ambígua NUNCA vira confirmação ou cancelamento', () => {
  for (const texto of [
    'talvez',
    'Talvez eu consiga',
    'preciso remarcar',
    'Preciso remarcar',
    'dá para reagendar?',
    'pode ser outro dia?',
    'não sei ainda',
    'confirmo que não vou',
    'bom dia',
    'obrigada',
  ]) {
    const r = webhook.interpretar(texto);
    assert.ok(r !== 'confirmar' && r !== 'cancelar', `"${texto}" foi interpretado como ${r}`);
  }
});

test('palavras de opt-out são reconhecidas', () => {
  for (const texto of ['SAIR', 'sair', 'parar', 'descadastrar', 'STOP']) {
    assert.equal(webhook.interpretar(texto), 'optout', `"${texto}"`);
  }
});

test('palavras de opt-in são reconhecidas', () => {
  for (const texto of ['ACEITO', 'aceito', 'Autorizo', 'concordo', 'quero receber']) {
    assert.equal(webhook.interpretar(texto), 'optin', `"${texto}"`);
  }
});

test('"sim" NUNCA concede opt-in — é confirmação de agendamento', () => {
  // Se "sim" valesse como consentimento, a base inteira viraria opt-in por
  // acidente. É exatamente o que a LGPD proíbe.
  for (const texto of ['sim', 'ok', 'confirmo', '1', 'Confirmar presença']) {
    assert.notEqual(webhook.interpretar(texto), 'optin', `"${texto}"`);
  }
});

test('mensagem vazia não vira ação', () => {
  assert.equal(webhook.interpretar(''), 'vazio');
  assert.equal(webhook.interpretar(null), 'vazio');
  assert.equal(webhook.interpretar('   '), 'vazio');
});

// ---------------------------------------------------------------------------
// Assinatura — a trava de segurança do endpoint público
// ---------------------------------------------------------------------------

function assinar(corpo, segredo) {
  return `sha256=${crypto.createHmac('sha256', segredo).update(corpo).digest('hex')}`;
}

test('assinatura correta é aceita; qualquer adulteração é recusada', () => {
  const segredoOriginal = config.meta.appSecret;
  config.meta.appSecret = 'segredo-de-teste';

  try {
    const corpo = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }));

    assert.equal(webhook.assinaturaValida(corpo, assinar(corpo, 'segredo-de-teste')), true);

    // segredo errado
    assert.equal(webhook.assinaturaValida(corpo, assinar(corpo, 'outro-segredo')), false);
    // corpo alterado depois de assinado
    assert.equal(
      webhook.assinaturaValida(Buffer.from('{"object":"outro"}'), assinar(corpo, 'segredo-de-teste')),
      false,
    );
    // sem header, header vazio, formato errado, tamanho diferente
    assert.equal(webhook.assinaturaValida(corpo, undefined), false);
    assert.equal(webhook.assinaturaValida(corpo, ''), false);
    assert.equal(webhook.assinaturaValida(corpo, 'sha1=abc'), false);
    assert.equal(webhook.assinaturaValida(corpo, 'sha256=abc'), false);
  } finally {
    config.meta.appSecret = segredoOriginal;
  }
});

test('sem APP_SECRET configurado, nada é aceito', () => {
  const segredoOriginal = config.meta.appSecret;
  config.meta.appSecret = '';

  try {
    const corpo = Buffer.from('{}');
    assert.equal(webhook.assinaturaValida(corpo, assinar(corpo, 'qualquer')), false);
  } finally {
    config.meta.appSecret = segredoOriginal;
  }
});

test('desafio GET só passa com o verify token certo', () => {
  const original = config.meta.webhookVerifyToken;
  config.meta.webhookVerifyToken = 'token-de-teste';

  try {
    const ok = webhook.verificarDesafio({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'token-de-teste',
      'hub.challenge': '98765',
    });
    assert.deepEqual(ok, { ok: true, challenge: '98765' });

    assert.equal(
      webhook.verificarDesafio({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'errado',
        'hub.challenge': '98765',
      }).ok,
      false,
    );
    assert.equal(webhook.verificarDesafio({}).ok, false);
  } finally {
    config.meta.webhookVerifyToken = original;
  }
});

// ---------------------------------------------------------------------------
// Extração do payload da Meta
// ---------------------------------------------------------------------------

function payloadCom(mensagem) {
  return { entry: [{ changes: [{ value: { messages: [mensagem] } }] }] };
}

test('extrai texto digitado, botão de template e resposta interativa', () => {
  const texto = webhook.extrairMensagens(
    payloadCom({ id: 'w1', from: '5511999998888', type: 'text', text: { body: 'sim' } }),
  );
  assert.equal(texto[0].texto, 'sim');

  const botao = webhook.extrairMensagens(
    payloadCom({
      id: 'w2',
      from: '5511999998888',
      type: 'button',
      button: { payload: 'Confirmar presença', text: 'Confirmar presença' },
      context: { id: 'wamid.origem' },
    }),
  );
  assert.equal(botao[0].texto, 'Confirmar presença');
  assert.equal(botao[0].idMensagemRespondida, 'wamid.origem');

  const interativo = webhook.extrairMensagens(
    payloadCom({
      id: 'w3',
      from: '5511999998888',
      type: 'interactive',
      interactive: { button_reply: { id: 'sim', title: 'Confirmar presença' } },
    }),
  );
  assert.equal(interativo[0].texto, 'Confirmar presença');
});

test('payload de status de entrega não vira mensagem', () => {
  const statuses = { entry: [{ changes: [{ value: { statuses: [{ status: 'delivered' }] } }] }] };
  assert.deepEqual(webhook.extrairMensagens(statuses), []);
  assert.deepEqual(webhook.extrairMensagens({}), []);
});

// ---------------------------------------------------------------------------
// Fluxo completo
// ---------------------------------------------------------------------------

function prepararEnvio({
  codAgendamento = 100,
  codPaciente = 900,
  idMensagemMeta = 'wamid.envio',
  telefone = '5511999998888',
} = {}) {
  const { id } = db.reservar({ codAgendamento, codPaciente, tipo: 'confirmacao' });
  db.marcarEnviado(id, { idMensagemMeta, telefone });
}

test.beforeEach(() => {
  db.fechar();
  db.conectar(':memory:');
});

test.after(() => db.fechar());

test('"sim" respondendo a um envio atualiza o status na ClinicWeb', async () => {
  prepararEnvio({ codAgendamento: 100 });

  const original = agendamentos.atualizarStatus;
  const chamadas = [];
  agendamentos.atualizarStatus = async (id, status, opcoes) => {
    chamadas.push({ id, status, opcoes });
    return { ok: true };
  };

  try {
    const r = await webhook.processarMensagem({
      id: 'wamid.resposta1',
      telefone: '5511999998888',
      tipo: 'text',
      texto: 'sim',
      idMensagemRespondida: 'wamid.envio',
    });

    assert.equal(r.acao, 'status_atualizado');
    assert.equal(r.codAgendamento, 100);
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].id, 100);
    assert.equal(chamadas[0].status, config.clinicweb.status.confirmado);
  } finally {
    agendamentos.atualizarStatus = original;
  }
});

test('"não" usa o status de cancelamento pelo paciente e registra o motivo', async () => {
  prepararEnvio({ codAgendamento: 101 });

  const original = agendamentos.atualizarStatus;
  const chamadas = [];
  agendamentos.atualizarStatus = async (id, status, opcoes) => {
    chamadas.push({ id, status, opcoes });
    return { ok: true };
  };

  try {
    const r = await webhook.processarMensagem({
      id: 'wamid.resposta2',
      telefone: '5511999998888',
      tipo: 'text',
      texto: 'não posso',
      idMensagemRespondida: 'wamid.envio',
    });

    assert.equal(r.acao, 'status_atualizado');
    assert.equal(chamadas[0].status, config.clinicweb.status.canceladoPaciente);
    assert.match(chamadas[0].opcoes.motivo, /WhatsApp/);
  } finally {
    agendamentos.atualizarStatus = original;
  }
});

test('resposta ambígua NÃO chama a ClinicWeb e fica pendente de revisão', async () => {
  prepararEnvio({ codAgendamento: 102 });

  const original = agendamentos.atualizarStatus;
  let chamou = false;
  agendamentos.atualizarStatus = async () => {
    chamou = true;
    return { ok: true };
  };

  try {
    const r = await webhook.processarMensagem({
      id: 'wamid.resposta3',
      telefone: '5511999998888',
      tipo: 'text',
      texto: 'preciso remarcar',
      idMensagemRespondida: 'wamid.envio',
    });

    assert.equal(r.acao, 'pendente_revisao');
    assert.equal(chamou, false, 'não pode tocar na agenda em caso ambíguo');
    assert.equal(db.respostasPendentes().length, 1);
  } finally {
    agendamentos.atualizarStatus = original;
  }
});

test('reentrega da Meta não gera segundo PATCH', async () => {
  prepararEnvio({ codAgendamento: 103 });

  const original = agendamentos.atualizarStatus;
  let chamadas = 0;
  agendamentos.atualizarStatus = async () => {
    chamadas += 1;
    return { ok: true };
  };

  try {
    const mensagem = {
      id: 'wamid.repetida',
      telefone: '5511999998888',
      tipo: 'text',
      texto: 'sim',
      idMensagemRespondida: 'wamid.envio',
    };

    assert.equal((await webhook.processarMensagem(mensagem)).acao, 'status_atualizado');
    assert.equal((await webhook.processarMensagem(mensagem)).acao, 'duplicada');
    assert.equal(chamadas, 1);
  } finally {
    agendamentos.atualizarStatus = original;
  }
});

test('resposta sem contexto casa com o último envio para aquele telefone', async () => {
  prepararEnvio({ codAgendamento: 104, idMensagemMeta: 'wamid.antigo' });

  const original = agendamentos.atualizarStatus;
  agendamentos.atualizarStatus = async () => ({ ok: true });

  try {
    const r = await webhook.processarMensagem({
      id: 'wamid.semcontexto',
      telefone: '5511999998888',
      tipo: 'text',
      texto: 'sim',
      idMensagemRespondida: null,
    });

    assert.equal(r.acao, 'status_atualizado');
    assert.equal(r.codAgendamento, 104);
  } finally {
    agendamentos.atualizarStatus = original;
  }
});

test('telefone desconhecido fica como sem_correspondencia', async () => {
  const r = await webhook.processarMensagem({
    id: 'wamid.orfa',
    telefone: '5511000000000',
    tipo: 'text',
    texto: 'sim',
    idMensagemRespondida: null,
  });

  assert.equal(r.acao, 'sem_correspondencia');
});

test('com a escrita bloqueada, a resposta é registrada mas a agenda não muda', async () => {
  prepararEnvio({ codAgendamento: 105 });

  const original = config.clinicweb.permitirEscrita;
  config.clinicweb.permitirEscrita = false;

  try {
    const r = await webhook.processarMensagem({
      id: 'wamid.bloqueada',
      telefone: '5511999998888',
      tipo: 'text',
      texto: 'sim',
      idMensagemRespondida: 'wamid.envio',
    });

    assert.equal(r.acao, 'escrita_bloqueada');
  } finally {
    config.clinicweb.permitirEscrita = original;
  }
});

test('erro na ClinicWeb não derruba o webhook', async () => {
  prepararEnvio({ codAgendamento: 106 });

  const original = agendamentos.atualizarStatus;
  agendamentos.atualizarStatus = async () => {
    throw new Error('ClinicWeb fora do ar');
  };

  try {
    const r = await webhook.processarMensagem({
      id: 'wamid.erro',
      telefone: '5511999998888',
      tipo: 'text',
      texto: 'sim',
      idMensagemRespondida: 'wamid.envio',
    });

    assert.equal(r.acao, 'erro');
    assert.equal(db.respostasPendentes()[0].acao, 'erro');
  } finally {
    agendamentos.atualizarStatus = original;
  }
});

test('processar() aceita payload inteiro e ignora eventos sem mensagem', async () => {
  const vazio = await webhook.processar({ entry: [{ changes: [{ value: { statuses: [] } }] }] });
  assert.equal(vazio.processadas, 0);
});

// ---------------------------------------------------------------------------
// Opt-in / opt-out pelo WhatsApp (Fase 2b)
// ---------------------------------------------------------------------------

test('"ACEITO" registra o consentimento do paciente que enviou', async () => {
  prepararEnvio({ codAgendamento: 200, codPaciente: 3823 });

  const r = await webhook.processarMensagem({
    id: 'wamid.aceite',
    telefone: '5511999998888',
    tipo: 'text',
    texto: 'ACEITO',
    idMensagemRespondida: 'wamid.envio',
  });

  assert.equal(r.acao, 'optin_registrado');
  assert.equal(db.temOptInAtivo(3823), true);

  const [linha] = db.listarOptIn('ativo');
  assert.match(linha.baseLegal, /LGPD/, 'a base legal precisa ficar registrada');
  assert.equal(linha.evidencia, 'ACEITO', 'a evidência é o texto do próprio paciente');
  assert.equal(linha.telefone, '5511999998888');
});

test('"SAIR" revoga o consentimento na hora', async () => {
  prepararEnvio({ codAgendamento: 201, codPaciente: 3824 });
  db.registrarOptIn({
    codPaciente: 3824,
    baseLegal: 'consentimento via WhatsApp',
    telefone: '5511999998888',
  });

  const r = await webhook.processarMensagem({
    id: 'wamid.sair',
    telefone: '5511999998888',
    tipo: 'text',
    texto: 'SAIR',
    idMensagemRespondida: 'wamid.envio',
  });

  assert.equal(r.acao, 'optin_revogado');
  assert.equal(db.temOptInAtivo(3824), false);
});

test('opt-out é atendido mesmo sem conseguir identificar o paciente', async () => {
  // Ninguém com esse telefone recebeu nada, mas o pedido tem que ser tratado.
  const r = await webhook.processarMensagem({
    id: 'wamid.sair2',
    telefone: '5511000000000',
    tipo: 'text',
    texto: 'PARAR',
    idMensagemRespondida: null,
  });

  assert.equal(r.acao, 'optout_sem_registro');
  assert.equal(db.respostasPendentes().length, 1, 'fica para revisão humana');
});

test('opt-out não é engolido por outra intenção na mesma resposta', () => {
  assert.equal(webhook.interpretar('sair'), 'optout');
});

test('"ACEITO" sem paciente identificável não vira consentimento', async () => {
  const r = await webhook.processarMensagem({
    id: 'wamid.aceite-orfao',
    telefone: '5511000000000',
    tipo: 'text',
    texto: 'aceito',
    idMensagemRespondida: null,
  });

  assert.equal(r.acao, 'pendente_revisao');
  assert.equal(db.listarOptIn('ativo').length, 0, 'consentimento anônimo não existe');
});

test('opt-in não mexe no status do agendamento', async () => {
  prepararEnvio({ codAgendamento: 202, codPaciente: 3825 });

  const original = agendamentos.atualizarStatus;
  let chamou = false;
  agendamentos.atualizarStatus = async () => {
    chamou = true;
    return { ok: true };
  };

  try {
    await webhook.processarMensagem({
      id: 'wamid.aceite2',
      telefone: '5511999998888',
      tipo: 'text',
      texto: 'autorizo',
      idMensagemRespondida: 'wamid.envio',
    });

    assert.equal(chamou, false);
  } finally {
    agendamentos.atualizarStatus = original;
  }
});


// ---------------------------------------------------------------------------
// Auto-resposta de remarcação
// ---------------------------------------------------------------------------

test('avisarRemarcacao envia o link da secretaria quando configurada (modo seco)', async () => {
  const secOrig = config.whatsapp.secretariaWhatsapp;
  const secoOrig = config.whatsapp.modoSeco;
  config.whatsapp.secretariaWhatsapp = '5511900000000';
  config.whatsapp.modoSeco = true; // não sai de verdade no teste
  try {
    webhook._resetThrottle();
    const r = await webhook.avisarRemarcacao('5517999990000', { teste: true });
    assert.equal(r.enviado, true);
    assert.equal(r.simulado, true);
  } finally {
    config.whatsapp.secretariaWhatsapp = secOrig;
    config.whatsapp.modoSeco = secoOrig;
  }
});

test('avisarRemarcacao não envia nada se o número da secretaria não está configurado', async () => {
  const secOrig = config.whatsapp.secretariaWhatsapp;
  config.whatsapp.secretariaWhatsapp = '';
  try {
    const r = await webhook.avisarRemarcacao('5517999990000');
    assert.equal(r.enviado, false);
    assert.equal(r.motivo, 'sem_numero_secretaria');
  } finally {
    config.whatsapp.secretariaWhatsapp = secOrig;
  }
});


test('enviarRedirecionamento manda a mensagem genérica com o link (modo seco)', async () => {
  const secOrig = config.whatsapp.secretariaWhatsapp;
  const secoOrig = config.whatsapp.modoSeco;
  config.whatsapp.secretariaWhatsapp = '5511900000000';
  config.whatsapp.modoSeco = true;
  try {
    webhook._resetThrottle();
    const r = await webhook.enviarRedirecionamento('5517999990000', 'Fale com a secretaria: {link}', 'Olá', { teste: true });
    assert.equal(r.enviado, true);
    assert.equal(r.simulado, true);
  } finally {
    config.whatsapp.secretariaWhatsapp = secOrig;
    config.whatsapp.modoSeco = secoOrig;
  }
});

test('redirecionamento e suprimido no 2o pedido dentro do cooldown (throttle)', async () => {
  const secOrig = config.whatsapp.secretariaWhatsapp;
  const secoOrig = config.whatsapp.modoSeco;
  config.whatsapp.secretariaWhatsapp = '5511900000000';
  config.whatsapp.modoSeco = true;
  webhook._resetThrottle();
  try {
    const tel = '5517912340000';
    const r1 = await webhook.enviarRedirecionamento(tel, 'Fale: {link}', 'Ola', {});
    const r2 = await webhook.enviarRedirecionamento(tel, 'Fale: {link}', 'Ola', {});
    assert.equal(r1.enviado, true);
    assert.equal(r2.enviado, false);
    assert.equal(r2.motivo, 'throttle');
    // bypass explicito (confirmacao de cancelamento) sempre envia
    const r3 = await webhook.enviarRedirecionamento(tel, 'Cancelado {link}', 'Ola', {}, { throttle: false });
    assert.equal(r3.enviado, true);
  } finally {
    config.whatsapp.secretariaWhatsapp = secOrig;
    config.whatsapp.modoSeco = secoOrig;
    webhook._resetThrottle();
  }
});

test('falha no envio NAO consome o cooldown (permite nova tentativa)', async () => {
  const secOrig = config.whatsapp.secretariaWhatsapp;
  const secoOrig = config.whatsapp.modoSeco;
  const cliente = require('../src/whatsapp/client');
  const envOrig = cliente.enviarTexto;
  config.whatsapp.secretariaWhatsapp = '5511900000000';
  config.whatsapp.modoSeco = false;
  webhook._resetThrottle();
  let chamadas = 0;
  cliente.enviarTexto = async () => { chamadas += 1; return { ok: false, simulado: false, erro: 'meta_fora' }; };
  try {
    const tel = '5517955550000';
    const r1 = await webhook.enviarRedirecionamento(tel, 'x {link}', 'Ola', {});
    const r2 = await webhook.enviarRedirecionamento(tel, 'x {link}', 'Ola', {});
    assert.equal(r1.enviado, false);
    assert.equal(r2.enviado, false);
    assert.equal(chamadas, 2);
  } finally {
    cliente.enviarTexto = envOrig;
    config.whatsapp.secretariaWhatsapp = secOrig;
    config.whatsapp.modoSeco = secoOrig;
    webhook._resetThrottle();
  }
});

test('pedido de remarcacao responde mesmo dentro do cooldown do catch-all', async () => {
  const secOrig = config.whatsapp.secretariaWhatsapp;
  const secoOrig = config.whatsapp.modoSeco;
  config.whatsapp.secretariaWhatsapp = '5511900000000';
  config.whatsapp.modoSeco = true;
  webhook._resetThrottle();
  try {
    const tel = '5517933330000';
    const r1 = await webhook.enviarRedirecionamento(tel, 'Fale: {link}', 'Ola', {});
    const r2 = await webhook.avisarRemarcacao(tel, {});
    assert.equal(r1.enviado, true);
    assert.equal(r2.enviado, true);
    // a resposta explicita tambem abre a janela: texto livre logo depois e suprimido
    const r3 = await webhook.enviarRedirecionamento(tel, 'Fale: {link}', 'Ola', {});
    assert.equal(r3.motivo, 'throttle');
  } finally {
    config.whatsapp.secretariaWhatsapp = secOrig;
    config.whatsapp.modoSeco = secoOrig;
    webhook._resetThrottle();
  }
});
