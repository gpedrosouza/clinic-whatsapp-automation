'use strict';

/**
 * Autenticação na API ClinicWeb + cliente HTTP autenticado.
 *
 * A API usa JWT: POST /auth/login devolve um token que vai no header
 * `Authorization: JWT {token}`. O token expira; como o serviço roda 24/7 em
 * polling, a renovação precisa ser automática (docs/06 — "token expira
 * durante polling => falha silenciosa").
 *
 * O wrapper `requisitar()` mora aqui de propósito: quem sabe tratar o 401 é
 * quem controla o ciclo de vida do token.
 */

const axios = require('axios');

const { config, exigir } = require('../config');
const { comRetry, repetivelPorPadrao } = require('../lib/retry');
const log = require('../lib/logger');

const MARGEM_RENOVACAO_MS = 60_000; // renova 1 min antes de expirar
const VALIDADE_PADRAO_MS = 30 * 60_000; // usado se o JWT não trouxer "exp"

const cliente = axios.create({
  baseURL: config.clinicweb.baseUrl,
  timeout: config.clinicweb.timeoutMs,
  headers: { 'Content-Type': 'application/json' },
});

let tokenAtual = null;
let expiraEmMs = 0;
let loginEmAndamento = null;

/** Observabilidade da autenticação — exposta em /health. */
const estadoAuth = {
  autenticado: false,
  ultimoLoginEm: null,
  expiraEm: null,
  falhasConsecutivas: 0,
  ultimoErro: null,
};

/** Lê o `exp` do JWT sem validar assinatura (só para saber quando renovar). */
function expiracaoDoToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Transforma o erro do axios em algo legível, sem vazar credencial. */
function erroDaApi(erro, rotulo) {
  const status = erro?.response?.status;
  const detalhe = erro?.response?.data?.error || erro?.response?.data?.message || erro.message;
  const e = new Error(`ClinicWeb ${rotulo} falhou${status ? ` (HTTP ${status})` : ''}: ${detalhe}`);
  e.status = status;
  e.original = erro;
  if (erro?.permanente) e.permanente = true;
  return e;
}

/**
 * Faz o login e guarda o token em memória.
 *
 * Falha de autenticação é o modo de falha mais traiçoeiro do serviço (docs/06:
 * "token expira durante polling => falha silenciosa"), então ela sai como
 * `log.error` com `alerta: true` e fica registrada em `estado()` para o
 * healthcheck denunciar.
 *
 * @returns {Promise<string>}
 */
async function login() {
  try {
    exigir('clinicweb');

    const corpo = {
      username: config.clinicweb.usuario,
      password: config.clinicweb.senha,
    };
    if (config.clinicweb.otp) corpo.otp = config.clinicweb.otp;

    const resposta = await comRetry(() => cliente.post('/auth/login', corpo), {
      rotulo: 'auth/login',
    }).catch((erro) => {
      throw erroDaApi(erro, 'auth/login');
    });

    const token = resposta.data?.token || resposta.data?.data?.token;
    if (!token) {
      throw new Error('ClinicWeb auth/login: resposta sem campo "token".');
    }

    tokenAtual = token;
    expiraEmMs = expiracaoDoToken(token) ?? Date.now() + VALIDADE_PADRAO_MS;

    estadoAuth.autenticado = true;
    estadoAuth.ultimoLoginEm = new Date().toISOString();
    estadoAuth.expiraEm = new Date(expiraEmMs).toISOString();
    estadoAuth.falhasConsecutivas = 0;
    estadoAuth.ultimoErro = null;

    log.info('clinicweb: autenticado', {
      ambiente: config.clinicweb.ambiente,
      expiraEm: estadoAuth.expiraEm,
    });

    return token;
  } catch (erro) {
    estadoAuth.autenticado = false;
    estadoAuth.falhasConsecutivas += 1;
    estadoAuth.ultimoErro = erro.message;

    log.error('clinicweb: FALHA DE AUTENTICAÇÃO — nenhum envio vai acontecer', {
      alerta: true,
      ambiente: config.clinicweb.ambiente,
      falhasConsecutivas: estadoAuth.falhasConsecutivas,
      status: erro.status,
      erro: erro.message,
    });

    throw erro;
  }
}

/** Snapshot para o /health e para os jobs decidirem se seguem. */
function estado() {
  return { ...estadoAuth };
}

/**
 * Devolve um token válido, renovando quando necessário.
 * Chamadas concorrentes compartilham o mesmo login em andamento.
 *
 * @param {{forcar?: boolean}} [opcoes]
 */
async function obterToken(opcoes = {}) {
  const expirado = !tokenAtual || Date.now() >= expiraEmMs - MARGEM_RENOVACAO_MS;

  if (!opcoes.forcar && !expirado) return tokenAtual;

  if (!loginEmAndamento) {
    loginEmAndamento = login().finally(() => {
      loginEmAndamento = null;
    });
  }
  return loginEmAndamento;
}

/** Descarta o token em memória (usado quando a API responde 401). */
function invalidarToken() {
  tokenAtual = null;
  expiraEmMs = 0;
}

/**
 * Requisição autenticada. Renova o token e repete uma vez em caso de 401.
 *
 * @param {import('axios').AxiosRequestConfig} opcoes
 * @param {{rotulo?: string}} [meta]
 * @returns {Promise<any>} corpo da resposta (já desembrulhado do axios)
 */
async function requisitar(opcoes, meta = {}) {
  const rotulo = meta.rotulo || `${opcoes.method || 'GET'} ${opcoes.url}`;

  return comRetry(
    async () => {
      const token = await obterToken();
      try {
        const resposta = await cliente.request({
          ...opcoes,
          headers: { Authorization: `JWT ${token}`, ...(opcoes.headers || {}) },
        });
        return resposta.data;
      } catch (erro) {
        if (erro?.response?.status === 401) {
          log.warn('clinicweb: 401 — token será renovado', { rotulo });
          invalidarToken();
        }
        throw erro;
      }
    },
    {
      rotulo,
      deveRepetir: (erro) => erro?.response?.status === 401 || repetivelPorPadrao(erro),
    },
  ).catch((erro) => {
    throw erroDaApi(erro, rotulo);
  });
}

module.exports = { login, obterToken, invalidarToken, requisitar, estado, cliente, erroDaApi };
