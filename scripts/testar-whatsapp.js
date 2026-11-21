'use strict';

/**
 * Valida as credenciais da Meta Cloud API (número de TESTE ou real) de ponta a
 * ponta, sem depender do resto do sistema. É o passo C2/C4 do checklist de
 * ativação (docs/09) e a etapa 5 da ordem de ativação (docs/09, Parte F).
 *
 *   npm run testar:whatsapp                 # só checa credenciais (GET, seguro)
 *   npm run testar:whatsapp -- --para 5534999999999
 *   npm run testar:whatsapp -- --para 5534999999999 --template hello_world --idioma en_US
 *
 * O que faz, em ordem:
 *   1. GET /{phoneNumberId}         -> confirma que o token enxerga o número
 *                                      (nome de exibição, status, qualidade).
 *   2. GET /{wabaId}/message_templates -> lista os templates disponíveis.
 *   3. Se --para for passado: POST /{phoneNumberId}/messages enviando um
 *      template (hello_world por padrão, que já vem aprovado no número de teste).
 *
 * IMPORTANTE sobre o número de TESTE da Meta:
 *   - O token da tela inicial expira em 24h — serve só para este teste. O token
 *     permanente (System User) vem depois, no passo C4 (vira META_TOKEN).
 *   - Um número de teste SÓ envia para destinatários pré-cadastrados no painel
 *     (até 5). Cadastre o seu WhatsApp em "Para" e confirme o código ANTES de
 *     usar --para, senão a Meta devolve erro 131030 ("recipient not in
 *     allowed list").
 *   - hello_world é en_US. Os templates da clínica (pt_BR) só existem depois de
 *     aprovados (passo C7).
 *
 * NÃO passa pelo client.js de propósito: aqui o objetivo é testar a credencial
 * crua, ignorando as travas WHATSAPP_MODO_SECO / WHATSAPP_NUMERO_TESTE.
 */

const axios = require('axios');

const { config } = require('../src/config');
const u = require('./_util');

const cliente = axios.create({ timeout: 20000 });

function baseUrl() {
  return `${config.meta.graphUrl}/${config.meta.apiVersao}`;
}

function auth() {
  return { headers: { Authorization: `Bearer ${config.meta.token}` } };
}

/** Extrai a mensagem de erro da Meta de um jeito legível. */
function erroMeta(erro) {
  const dados = erro?.response?.data?.error;
  if (dados && dados.message) {
    const detalhe = dados.error_data?.details ? ` — ${dados.error_data.details}` : '';
    return `[${dados.code}] ${dados.message}${detalhe}`;
  }
  const corpo = erro?.response?.data;
  if (corpo) return `HTTP ${erro.response.status}: ${JSON.stringify(corpo).slice(0, 300)}`;
  return erro.message;
}

/** Envelopa um erro da Meta preservando o original (encerrar imprime o corpo). */
function falhaMeta(prefixo, erro) {
  const envelope = new Error(`${prefixo}: ${erroMeta(erro)}`);
  envelope.original = erro;
  envelope.status = erro?.response?.status;
  return envelope;
}

async function checarCredenciais() {
  u.titulo('WhatsApp Cloud API — teste de credenciais');

  console.log(`graphUrl:      ${config.meta.graphUrl}`);
  console.log(`apiVersao:     ${config.meta.apiVersao}`);
  console.log(`phoneNumberId: ${config.meta.phoneNumberId || 'AUSENTE'}`);
  console.log(`wabaId:        ${config.meta.wabaId || 'AUSENTE'}`);
  console.log(`token:         ${config.meta.token ? `presente (${config.meta.token.length} caracteres)` : 'AUSENTE'}`);

  if (!config.meta.phoneNumberId || !config.meta.token) {
    throw new Error(
      'Faltam META_PHONE_NUMBER_ID e/ou META_TOKEN no .env. ' +
        'Gere o token na tela do WhatsApp (botão "Gerar token") e preencha o .env.',
    );
  }
}

/** GET no número: confirma que o token tem acesso e mostra o estado do número. */
async function inspecionarNumero() {
  u.subtitulo('1/3 — número de telefone (GET /{phoneNumberId})');

  const campos = 'verified_name,display_phone_number,quality_rating,code_verification_status,platform_type';
  const url = `${baseUrl()}/${config.meta.phoneNumberId}?fields=${campos}`;

  const { data } = await cliente.get(url, auth());
  console.log(`nome de exibição:   ${data.verified_name ?? '—'}`);
  console.log(`número:             ${data.display_phone_number ?? '—'}`);
  console.log(`qualidade:          ${data.quality_rating ?? '—'}`);
  console.log(`verificação:        ${data.code_verification_status ?? '—'}`);
  console.log(`plataforma:         ${data.platform_type ?? '—'}`);
  console.log('\n✔ token válido e com acesso ao número.');
}

/** GET nos templates da WABA: mostra quais já existem e seu status. */
async function listarTemplates() {
  u.subtitulo('2/3 — templates da conta (GET /{wabaId}/message_templates)');

  if (!config.meta.wabaId) {
    console.log('META_WABA_ID ausente — pulando (opcional para este teste).');
    return;
  }

  const url = `${baseUrl()}/${config.meta.wabaId}/message_templates?fields=name,language,status,category&limit=50`;
  const { data } = await cliente.get(url, auth());
  const itens = data.data ?? [];

  if (itens.length === 0) {
    console.log('nenhum template próprio ainda (esperado antes do passo C7).');
    console.log('hello_world (en_US) continua disponível por padrão no número de teste.');
    return;
  }

  console.log(`${itens.length} template(s):`);
  for (const t of itens) {
    console.log(`  • ${t.name.padEnd(28)} ${String(t.language).padEnd(6)} ${t.category ?? '—'}  [${t.status}]`);
  }
}

/** POST /messages: o envio de verdade. Só roda se --para for informado. */
async function enviar(para, nomeTemplate, idioma) {
  u.subtitulo('3/3 — envio de template (POST /{phoneNumberId}/messages)');

  const corpo = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: para,
    type: 'template',
    template: { name: nomeTemplate, language: { code: idioma } },
  };

  console.log(`para:     ${u.mascararValor(para)}`);
  console.log(`template: ${nomeTemplate} (${idioma})`);

  const url = `${baseUrl()}/${config.meta.phoneNumberId}/messages`;
  const { data } = await cliente.post(url, corpo, auth());
  const id = data.messages?.[0]?.id ?? null;

  console.log(`\n✔ enviado. id da mensagem: ${id}`);
  console.log('Confira o WhatsApp do número de destino — a mensagem deve chegar em segundos.');
}

async function principal() {
  await checarCredenciais();

  try {
    await inspecionarNumero();
    await listarTemplates();
  } catch (erro) {
    throw falhaMeta('falha ao consultar a Meta', erro);
  }

  const para = u.opcao('para');
  if (!para) {
    u.subtitulo('3/3 — envio');
    console.log('nenhum --para informado: parando na checagem (nenhuma mensagem enviada).');
    console.log('\nPara enviar de verdade, cadastre seu número no painel da Meta e rode:');
    console.log('  npm run testar:whatsapp -- --para 55DDDNUMERO');
    return;
  }

  const nomeTemplate = u.opcao('template', 'hello_world');
  // hello_world é en_US; para templates da clínica o padrão é o do .env (pt_BR).
  const idioma = u.opcao('idioma', nomeTemplate === 'hello_world' ? 'en_US' : config.meta.idioma);

  try {
    await enviar(String(para).replace(/\D/g, ''), nomeTemplate, idioma);
  } catch (erro) {
    throw falhaMeta('falha no envio', erro);
  }
}

principal()
  .then(() => u.encerrar())
  .catch(u.encerrar);
