'use strict';

/**
 * Simula a Meta chamando o nosso webhook — inclusive assinando o payload com
 * o App Secret, igual ela faz. Serve para testar o fluxo de resposta do
 * paciente sem depender de aprovação de template.
 *
 *   # com o servidor rodando (npm start):
 *   node scripts/simular-webhook.js "sim"
 *   node scripts/simular-webhook.js "talvez" --telefone 5511999998888
 *   node scripts/simular-webhook.js "sim" --contexto wamid.ABC   # responde a um envio
 *   node scripts/simular-webhook.js --verificacao                # testa o desafio GET
 *
 * Precisa de META_APP_SECRET e META_WEBHOOK_VERIFY_TOKEN no .env (podem ser
 * valores fictícios enquanto a conta da Meta não sai — os dois lados usam o
 * mesmo .env).
 */

const crypto = require('node:crypto');

const { config } = require('../src/config');
const u = require('./_util');

const base = u.opcao('url', `http://127.0.0.1:${config.app.porta}`);

function montarPayload(texto, telefone, idContexto) {
  const mensagem = {
    from: telefone,
    id: `wamid.simulado.${Date.now()}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: 'text',
    text: { body: texto },
  };
  if (idContexto) mensagem.context = { id: idContexto };

  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: config.meta.wabaId || 'WABA_SIMULADA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '5500000000000',
                phone_number_id: config.meta.phoneNumberId || 'PHONE_ID_SIMULADO',
              },
              contacts: [{ profile: { name: 'Paciente Teste' }, wa_id: telefone }],
              messages: [mensagem],
            },
          },
        ],
      },
    ],
  };
}

async function testarVerificacao() {
  u.subtitulo('GET /webhook (desafio da Meta)');

  const url = new URL(`${base}/webhook`);
  url.searchParams.set('hub.mode', 'subscribe');
  url.searchParams.set('hub.verify_token', config.meta.webhookVerifyToken);
  url.searchParams.set('hub.challenge', '123456');

  const resposta = await fetch(url);
  const corpo = await resposta.text();

  console.log(`HTTP ${resposta.status} — corpo: "${corpo}"`);
  console.log(resposta.status === 200 && corpo === '123456' ? '✔ desafio aceito' : '✖ desafio recusado');

  // E o caminho negativo, que é o que importa para a segurança:
  url.searchParams.set('hub.verify_token', 'token-errado');
  const recusa = await fetch(url);
  console.log(`token errado -> HTTP ${recusa.status} ${recusa.status === 403 ? '✔' : '✖ deveria ser 403'}`);
}

async function enviarPayload(texto) {
  const telefone = u.opcao('telefone', '5511999998888');
  const idContexto = u.opcao('contexto', null);
  const payload = montarPayload(texto, telefone, idContexto);
  const corpo = JSON.stringify(payload);

  const assinatura = crypto
    .createHmac('sha256', config.meta.appSecret)
    .update(corpo, 'utf8')
    .digest('hex');

  u.subtitulo(`POST /webhook — resposta simulada: "${texto}"`);
  console.log(`telefone: ${telefone}${idContexto ? ` | respondendo a: ${idContexto}` : ''}`);

  const resposta = await fetch(`${base}/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': `sha256=${assinatura}`,
    },
    body: corpo,
  });

  console.log(`assinatura correta -> HTTP ${resposta.status} ${resposta.status === 200 ? '✔' : '✖'}`);

  // Caminho negativo: assinatura adulterada tem que ser recusada.
  const recusa = await fetch(`${base}/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
    },
    body: corpo,
  });

  console.log(
    `assinatura falsa    -> HTTP ${recusa.status} ${recusa.status === 401 ? '✔' : '✖ deveria ser 401'}`,
  );

  console.log('\nVeja o log do servidor para a interpretação e a ação tomada.');
}

async function principal() {
  u.titulo('Simulador do webhook da Meta');
  console.log(`alvo: ${base}`);

  if (!config.meta.appSecret) {
    console.log('\nMETA_APP_SECRET vazio no .env — o servidor recusa tudo.');
    console.log('Preencha com qualquer valor para testar localmente.');
    process.exit(1);
  }

  if (process.argv.includes('--verificacao')) {
    await testarVerificacao();
    return;
  }

  const texto = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'sim';
  await testarVerificacao();
  await enviarPayload(texto);
}

principal().then(() => u.encerrar()).catch(u.encerrar);
