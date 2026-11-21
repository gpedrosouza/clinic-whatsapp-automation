'use strict';

/**
 * Wrapper da Meta Cloud API (envio de template message).
 *
 * Duas travas de segurança, ligadas por padrão:
 *  - `WHATSAPP_MODO_SECO=true` → nada sai; loga o payload e devolve id falso.
 *  - `WHATSAPP_NUMERO_TESTE`   → se preenchido, TODO envio é redirecionado
 *    para esse número. Evita mandar mensagem de teste para paciente real.
 *
 * Este módulo NÃO decide se deve enviar — isso é do job, que consulta o banco
 * antes (idempotência). Aqui só se envia o que já foi autorizado.
 */

const axios = require('axios');

const { config, exigir } = require('../config');
const { comRetry } = require('../lib/retry');
const log = require('../lib/logger');
const telefone = require('../lib/telefone');

const cliente = axios.create({ timeout: 20000 });

/** Erros da Meta que não melhoram com repetição (número inválido, template errado). */
const CODIGOS_DEFINITIVOS = new Set([
  131008, // parâmetro obrigatório ausente
  131009, // valor de parâmetro inválido
  131026, // número não está no WhatsApp / não pode receber
  131047, // fora da janela de 24h (para mensagem que não é template)
  132000, // número de parâmetros não bate com o template
  132001, // template não existe no idioma pedido
  132005, // template pausado/reprovado
  132007, // conteúdo viola a política
  132012, // formato de parâmetro inválido
  100, // parâmetro inválido genérico
]);

function detalharErro(erro) {
  const dados = erro?.response?.data?.error;
  if (!dados) {
    return { mensagem: erro.message, codigo: null, definitivo: false };
  }
  const codigo = dados.code;
  return {
    mensagem: `${dados.message}${dados.error_data?.details ? ` — ${dados.error_data.details}` : ''}`,
    codigo,
    definitivo: CODIGOS_DEFINITIVOS.has(codigo),
  };
}

/** URL do endpoint de mensagens do número da clínica. */
function urlMensagens() {
  return `${config.meta.graphUrl}/${config.meta.apiVersao}/${config.meta.phoneNumberId}/messages`;
}

/**
 * Monta o corpo do template message da Cloud API.
 * Só componente `body` — cabeçalho e rodapé dos nossos templates são fixos e
 * os botões são de resposta rápida (não levam parâmetro).
 */
function montarCorpo(para, { nomeTemplate, idioma, parametros }) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: para,
    type: 'template',
    template: {
      name: nomeTemplate,
      language: { code: idioma },
      components:
        parametros.length > 0
          ? [
              {
                type: 'body',
                parameters: parametros.map((texto) => ({ type: 'text', text: String(texto) })),
              },
            ]
          : [],
    },
  };
}

/**
 * Envia uma mensagem de template.
 *
 * @param {{ddi?: string, ddd?: string, tel?: string}|string} destino partes do
 *        cadastro OU um E.164 pronto
 * @param {{nomeTemplate: string, idioma: string, parametros: string[], tipo?: string}} mensagem
 * @param {{contexto?: object}} [opcoes] dados extras para o log
 * @returns {Promise<{ok: boolean, idMensagemMeta: string|null, simulado: boolean,
 *                    erro?: string, definitivo?: boolean, numero?: string}>}
 */
async function enviarTemplate(destino, mensagem, opcoes = {}) {
  const contexto = opcoes.contexto || {};

  // 1. telefone -> E.164
  const resolvido = typeof destino === 'string' ? { ok: true, numero: destino } : telefone.paraE164(destino);

  if (!resolvido.ok) {
    log.warn('whatsapp: telefone inutilizável, envio abortado', {
      ...contexto,
      motivo: resolvido.motivo,
      sugestao: resolvido.sugestao ? 'existe sugestão para conferência humana' : undefined,
    });
    return { ok: false, idMensagemMeta: null, simulado: false, erro: `telefone_${resolvido.motivo}`, definitivo: true };
  }

  // 2. trava de teste: redireciona tudo para o número de teste
  const numeroReal = resolvido.numero;
  const para = config.whatsapp.numeroTeste || numeroReal;
  const redirecionado = para !== numeroReal;

  if (!mensagem.nomeTemplate) {
    return {
      ok: false,
      idMensagemMeta: null,
      simulado: false,
      erro: 'nome do template não configurado no .env (META_TEMPLATE_*)',
      definitivo: true,
    };
  }

  const corpo = montarCorpo(para, mensagem);

  // 3. modo seco: não sai da máquina
  if (config.whatsapp.modoSeco) {
    log.info('whatsapp: MODO SECO — mensagem não enviada', {
      ...contexto,
      to: para,
      template: mensagem.nomeTemplate,
      parametros: mensagem.parametros.length,
    });
    return { ok: true, idMensagemMeta: `seco-${Date.now()}`, simulado: true, numero: para };
  }

  exigir('meta');

  // 4. envio de verdade
  try {
    const resposta = await comRetry(
      () =>
        cliente.post(urlMensagens(), corpo, {
          headers: {
            Authorization: `Bearer ${config.meta.token}`,
            'Content-Type': 'application/json',
          },
        }),
      {
        rotulo: 'meta: POST /messages',
        deveRepetir: (erro) => {
          const { definitivo } = detalharErro(erro);
          if (definitivo) return false;
          const status = erro?.response?.status;
          if (status === undefined) return true;
          return status === 408 || status === 429 || status >= 500;
        },
      },
    );

    const idMensagemMeta = resposta.data?.messages?.[0]?.id ?? null;

    log.info('whatsapp: enviado', {
      ...contexto,
      to: para,
      template: mensagem.nomeTemplate,
      idMensagemMeta,
      redirecionado: redirecionado || undefined,
    });

    return { ok: true, idMensagemMeta, simulado: false, numero: para };
  } catch (erro) {
    const { mensagem: texto, codigo, definitivo } = detalharErro(erro);

    log.error('whatsapp: falha no envio', {
      ...contexto,
      to: para,
      template: mensagem.nomeTemplate,
      codigoMeta: codigo,
      definitivo,
      erro: texto,
    });

    return { ok: false, idMensagemMeta: null, simulado: false, erro: texto, definitivo };
  }
}

/**
 * Envia uma mensagem de TEXTO livre (não-template). Só é entregue dentro da
 * janela de 24h aberta por uma mensagem do paciente (ex.: logo após ele tocar
 * num botão). Respeita as mesmas travas: modo seco e número de teste.
 *
 * @param {string|{ddi?:string,ddd?:string,tel?:string}} destino E.164 pronto ou partes
 * @param {string} corpo
 * @param {{contexto?: object}} [opcoes]
 */
async function enviarTexto(destino, corpo, opcoes = {}) {
  const contexto = opcoes.contexto || {};
  const resolvido = typeof destino === 'string' ? { ok: true, numero: destino } : telefone.paraE164(destino);
  if (!resolvido.ok) {
    return { ok: false, idMensagemMeta: null, simulado: false, erro: `telefone_${resolvido.motivo}` };
  }
  const texto = String(corpo ?? '').trim();
  if (!texto) return { ok: false, idMensagemMeta: null, simulado: false, erro: 'corpo_vazio' };

  const para = config.whatsapp.numeroTeste || resolvido.numero;
  const corpoReq = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: para,
    type: 'text',
    text: { preview_url: false, body: texto },
  };

  if (config.whatsapp.modoSeco) {
    log.info('whatsapp: MODO SECO — texto não enviado', { ...contexto, to: para });
    return { ok: true, idMensagemMeta: `seco-${Date.now()}`, simulado: true, numero: para };
  }

  exigir('meta');
  try {
    const resposta = await comRetry(
      () =>
        cliente.post(urlMensagens(), corpoReq, {
          headers: { Authorization: `Bearer ${config.meta.token}`, 'Content-Type': 'application/json' },
        }),
      {
        rotulo: 'meta: POST /messages (texto)',
        deveRepetir: (erro) => {
          const { definitivo } = detalharErro(erro);
          if (definitivo) return false;
          const status = erro?.response?.status;
          if (status === undefined) return true;
          return status === 408 || status === 429 || status >= 500;
        },
      },
    );
    const idMensagemMeta = resposta.data?.messages?.[0]?.id ?? null;
    log.info('whatsapp: texto enviado', { ...contexto, to: para, idMensagemMeta });
    return { ok: true, idMensagemMeta, simulado: false, numero: para };
  } catch (erro) {
    const { mensagem: txt, codigo, definitivo } = detalharErro(erro);
    log.error('whatsapp: falha no envio de texto', { ...contexto, to: para, codigoMeta: codigo, erro: txt });
    return { ok: false, idMensagemMeta: null, simulado: false, erro: txt, definitivo };
  }
}

module.exports = { enviarTemplate, enviarTexto, montarCorpo, detalharErro, urlMensagens, CODIGOS_DEFINITIVOS };
