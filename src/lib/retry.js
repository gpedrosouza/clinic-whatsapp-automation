'use strict';

/**
 * Retry com backoff exponencial + jitter.
 *
 * Motivação (docs/06): o rate limit da API ClinicWeb não é documentado e o
 * token JWT pode expirar durante o polling. Falha de rede não pode derrubar
 * o ciclo inteiro nem, muito menos, causar reenvio de mensagem.
 */

const { config } = require('../config');
const log = require('./logger');

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Erros que vale a pena repetir: rede, 408, 429 e 5xx.
 * Erros marcados como `permanente` (ex.: variável de ambiente ausente,
 * parâmetro obrigatório faltando) NÃO são repetidos — repetir só atrasa o
 * diagnóstico.
 */
function repetivelPorPadrao(erro) {
  if (erro?.permanente) return false;
  const status = erro?.response?.status;
  if (status === undefined) return true; // timeout, DNS, socket
  return status === 408 || status === 429 || status >= 500;
}

/** Respeita Retry-After (segundos) quando a API manda. */
function esperaSugerida(erro) {
  const cabecalho = erro?.response?.headers?.['retry-after'];
  if (!cabecalho) return null;
  const segundos = Number.parseInt(cabecalho, 10);
  return Number.isNaN(segundos) ? null : segundos * 1000;
}

/**
 * Executa `fn` repetindo em caso de falha transitória.
 *
 * @param {() => Promise<any>} fn
 * @param {object} [opcoes]
 * @param {string} [opcoes.rotulo] identificação nos logs
 * @param {number} [opcoes.tentativas] total de tentativas (default: RETRY_TENTATIVAS)
 * @param {number} [opcoes.baseMs] base do backoff (default: RETRY_BASE_MS)
 * @param {(erro: Error) => boolean} [opcoes.deveRepetir]
 */
async function comRetry(fn, opcoes = {}) {
  const {
    rotulo = 'operacao',
    tentativas = config.retry.tentativas,
    baseMs = config.retry.baseMs,
    deveRepetir = repetivelPorPadrao,
  } = opcoes;

  let ultimoErro;

  for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
    try {
      return await fn();
    } catch (erro) {
      ultimoErro = erro;

      const ehUltima = tentativa === tentativas;
      if (ehUltima || !deveRepetir(erro)) {
        log.error('retry: desistindo', {
          rotulo,
          tentativa,
          tentativas,
          status: erro?.response?.status,
          erro: erro.message,
        });
        throw erro;
      }

      const exponencial = baseMs * 2 ** (tentativa - 1);
      const jitter = Math.floor(Math.random() * baseMs);
      const espera = esperaSugerida(erro) ?? exponencial + jitter;

      log.warn('retry: nova tentativa', {
        rotulo,
        tentativa,
        tentativas,
        esperaMs: espera,
        status: erro?.response?.status,
        erro: erro.message,
      });

      await dormir(espera);
    }
  }

  throw ultimoErro;
}

module.exports = { comRetry, repetivelPorPadrao, dormir };
