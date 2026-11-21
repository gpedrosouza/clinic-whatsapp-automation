'use strict';

/**
 * Recebimento das respostas do paciente (webhook da Meta).
 *
 * Três cuidados que não são negociáveis:
 *
 *  1. **Assinatura.** O endpoint é público. Sem validar o header
 *     `X-Hub-Signature-256` com o App Secret, qualquer um pode confirmar
 *     agendamento alheio. Comparação em tempo constante.
 *  2. **Reentrega.** A Meta reenvia o evento se não receber 200 rápido. O
 *     `id` da mensagem é único e fica gravado — resposta repetida não vira
 *     um segundo PATCH na ClinicWeb.
 *  3. **Ambiguidade.** "talvez", "reagendar", "preciso remarcar" NÃO mexem no
 *     status. Ficam como `pendente_revisao` para uma pessoa decidir.
 */

const crypto = require('node:crypto');

const { config } = require('../config');
const agendamentos = require('../clinicweb/agendamentos');
const db = require('../db/db');
const log = require('../lib/logger');
const whatsapp = require('./client');

// ---------------------------------------------------------------------------
// Interpretação da resposta
// ---------------------------------------------------------------------------

/** Tira acento, pontuação e caixa: "Não, obrigada!" -> "nao obrigada" */
function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // tira as marcas soltas pelo NFD
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Respostas exatas — o caso mais comum ("sim", "1", "ok").
const EXATO_CONFIRMAR = new Set(['sim', 's', 'ss', 'ok', 'okay', 'confirmo', 'confirmado', 'confirmar', 'confirmada', 'presenca confirmada', '1', 'yes', 'claro', 'certo', 'positivo', 'confirmar presenca']);
const EXATO_CANCELAR = new Set(['nao', 'n', 'nao vou', 'nao posso', 'cancelar', 'cancela', 'cancelo', 'desmarcar', 'desmarca', '2', 'negativo']);

/**
 * Opt-in/opt-out vêm do .env (OPTIN_PALAVRAS / OPTOUT_PALAVRAS) porque o texto
 * exato depende do que a mensagem da clínica pede ao paciente.
 *
 * Cuidado deliberado: "sim" NÃO concede opt-in. Um paciente confirmando
 * presença não está consentindo em receber marketing — se "sim" valesse como
 * consentimento, a base inteira viraria opt-in por acidente, o que é
 * exatamente o que a LGPD proíbe.
 */
const palavrasOptOut = () => new Set([...config.whatsapp.palavrasOptOut, 'cancelar inscricao', 'nao quero receber']);
const palavrasOptIn = () => new Set(config.whatsapp.palavrasOptIn);

// Palavras que, aparecendo em frase, indicam a intenção.
const CONTEM_CONFIRMAR = /\b(confirm\w*|estarei|vou (sim|comparecer|estar)|comparecerei|pode (confirmar|contar))\b/;
const CONTEM_CANCELAR = /\b(cancel\w*|desmarc\w*|nao (vou|poderei|posso|consigo|vai dar)|desisti)\b/;
const CONTEM_AMBIGUO = /\b(talvez|remarc\w*|reagend\w*|adiar|mudar (a )?(data|hora|horario)|outro (dia|horario)|nao sei|acho que|se possivel|preciso remarcar|pode ser)\b/;
// Subconjunto do ambíguo que é especificamente um pedido de REMARCAÇÃO —
// dispara a auto-resposta com o link da secretaria.
const CONTEM_REMARCAR = /\b(remarc\w*|reagend\w*|adiar|outro (dia|horario)|mudar (a )?(data|hora|horario))\b/;

/**
 * Classifica a resposta do paciente.
 *
 * Ordem importa: ambiguidade ganha de tudo. "não sei" contém "não", mas não é
 * um cancelamento — e trocar o status por engano é pior do que pedir ajuda
 * humana.
 *
 * @param {string} texto
 * @returns {'confirmar'|'cancelar'|'optin'|'optout'|'ambiguo'|'vazio'}
 */
function interpretar(texto) {
  const t = normalizar(texto);
  if (t === '') return 'vazio';

  // Opt-out primeiro: é obrigação legal e não pode ser ofuscado por
  // nenhuma outra intenção na mesma frase.
  if (palavrasOptOut().has(t)) return 'optout';
  if (palavrasOptIn().has(t)) return 'optin';

  if (EXATO_CONFIRMAR.has(t)) return 'confirmar';
  if (EXATO_CANCELAR.has(t)) return 'cancelar';

  if (CONTEM_AMBIGUO.test(t)) return 'ambiguo';

  const confirma = CONTEM_CONFIRMAR.test(t);
  const cancela = CONTEM_CANCELAR.test(t);

  if (confirma && cancela) return 'ambiguo'; // "confirmo que não vou"
  if (confirma) return 'confirmar';
  if (cancela) return 'cancelar';

  return 'ambiguo';
}

/**
 * Extrai texto e id das mensagens de um payload da Meta.
 * Cobre `text` (digitado), `button` (botão do template) e `interactive`.
 */
function extrairMensagens(payload) {
  const saida = [];

  for (const entrada of payload?.entry ?? []) {
    for (const alteracao of entrada?.changes ?? []) {
      const valor = alteracao?.value;
      for (const msg of valor?.messages ?? []) {
        let texto = null;

        if (msg.type === 'text') texto = msg.text?.body;
        else if (msg.type === 'button') texto = msg.button?.payload || msg.button?.text;
        else if (msg.type === 'interactive') {
          texto =
            msg.interactive?.button_reply?.title ||
            msg.interactive?.button_reply?.id ||
            msg.interactive?.list_reply?.title;
        }

        saida.push({
          id: msg.id,
          telefone: msg.from,
          tipo: msg.type,
          texto,
          idMensagemRespondida: msg.context?.id ?? null,
        });
      }
    }
  }

  return saida;
}

// ---------------------------------------------------------------------------
// Segurança
// ---------------------------------------------------------------------------

/**
 * Confere o `X-Hub-Signature-256` contra o corpo BRUTO da requisição.
 * Precisa ser o buffer original — reserializar o JSON muda os bytes.
 *
 * @param {Buffer|string} corpoBruto
 * @param {string} cabecalho valor de x-hub-signature-256 ("sha256=...")
 */
function assinaturaValida(corpoBruto, cabecalho) {
  if (!config.meta.appSecret) {
    log.error('webhook: META_APP_SECRET não configurado — recusando tudo', { alerta: true });
    return false;
  }
  if (!cabecalho || !cabecalho.startsWith('sha256=')) return false;

  const esperado = crypto
    .createHmac('sha256', config.meta.appSecret)
    .update(corpoBruto)
    .digest('hex');

  const recebido = cabecalho.slice('sha256='.length);

  const a = Buffer.from(esperado, 'utf8');
  const b = Buffer.from(recebido, 'utf8');
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

/**
 * Desafio GET de verificação do webhook.
 * @param {object} query req.query
 * @returns {{ok: boolean, challenge?: string}}
 */
function verificarDesafio(query) {
  const modo = query?.['hub.mode'];
  const token = query?.['hub.verify_token'];
  const challenge = query?.['hub.challenge'];

  if (!config.meta.webhookVerifyToken) {
    log.error('webhook: META_WEBHOOK_VERIFY_TOKEN não configurado', { alerta: true });
    return { ok: false };
  }

  if (modo === 'subscribe' && token === config.meta.webhookVerifyToken) {
    log.info('webhook: verificação da Meta aceita');
    return { ok: true, challenge: String(challenge ?? '') };
  }

  log.warn('webhook: verificação recusada', { modo });
  return { ok: false };
}

// ---------------------------------------------------------------------------
// Processamento
// ---------------------------------------------------------------------------

/**
 * Descobre a qual agendamento a resposta se refere.
 *  - caminho bom: o paciente respondeu A mensagem (`context.id`);
 *  - fallback: último envio para aquele telefone dentro da janela.
 */
function acharAgendamento({ idMensagemRespondida, telefone }) {
  if (idMensagemRespondida) {
    const envio = db.porIdMensagemMeta(idMensagemRespondida);
    if (envio) return { envio, origem: 'contexto' };
  }

  const envio = db.ultimoEnvioParaTelefone(telefone);
  if (envio) return { envio, origem: 'ultimo_envio' };

  return { envio: null, origem: null };
}

/** Aplica a decisão na ClinicWeb. */
async function aplicarNaClinicweb(interpretacao, codAgendamento) {
  const idStatus =
    interpretacao === 'confirmar'
      ? config.clinicweb.status.confirmado
      : config.clinicweb.status.canceladoPaciente;

  const opcoes =
    interpretacao === 'cancelar'
      ? { motivo: 'Cancelado pelo paciente via WhatsApp' }
      : {};

  return agendamentos.atualizarStatus(codAgendamento, idStatus, opcoes);
}

// Throttle anti-spam do catch-all: cada telefone só recebe um redirecionamento
// à secretaria por janela de cooldown. Memória do processo (reinício zera — é
// anti-spam best-effort, não idempotência). Cooldown 0 desliga.
const ultimoRedirect = new Map();

function cooldownRedirectMs() {
  return Math.max(0, config.whatsapp.redirecionamentoCooldownMin) * 60 * 1000;
}

/** Ainda estamos dentro do cooldown deste telefone? (só consulta, não registra) */
function redirecionamentoBloqueado(telefone, agoraMs = Date.now()) {
  const cooldownMs = cooldownRedirectMs();
  if (cooldownMs === 0) return false;
  const anterior = ultimoRedirect.get(telefone) || 0;
  return agoraMs - anterior < cooldownMs;
}

/** Abre a janela de cooldown após um envio que de fato saiu. Poda os velhos. */
function registrarRedirecionamento(telefone, agoraMs = Date.now()) {
  ultimoRedirect.set(telefone, agoraMs);
  if (ultimoRedirect.size > 500) {
    const cooldownMs = cooldownRedirectMs();
    for (const [tel, ts] of ultimoRedirect) {
      if (agoraMs - ts >= cooldownMs) ultimoRedirect.delete(tel);
    }
  }
}

/** Zera o throttle — só para testes. */
function _resetThrottle() {
  ultimoRedirect.clear();
}

/**
 * Após um pedido de remarcação, orienta o paciente a falar com a secretaria,
 * enviando um link de WhatsApp direto. Mensagem livre — vale porque o paciente
 * acabou de escrever (janela de 24h aberta). Nunca lança.
 *
 * @param {string} telefone E.164 do paciente
 * @param {object} [contexto] dados para o log
 * @param {{throttle?: boolean}} [opcoes] throttle=false para respostas a um
 *   pedido explícito (remarcar/cancelar), que nunca podem ser suprimidas
 */
async function enviarRedirecionamento(telefone, mensagemBase, prefill, contexto = {}, opcoes = {}) {
  const { throttle = true } = opcoes;
  const num = String(config.whatsapp.secretariaWhatsapp || '').replace(/\D/g, '');
  if (!num) return { enviado: false, motivo: 'sem_numero_secretaria' };

  if (throttle && redirecionamentoBloqueado(telefone)) {
    log.info('webhook: redirecionamento suprimido (throttle por telefone)', { ...contexto });
    return { enviado: false, motivo: 'throttle' };
  }

  const link = `https://wa.me/${num}?text=${encodeURIComponent(prefill || 'Olá, preciso falar sobre a minha consulta.')}`;
  const corpo = String(mensagemBase || '').replace('{link}', link);

  try {
    const r = await whatsapp.enviarTexto(telefone, corpo, { contexto });
    // Abre o cooldown só quando o envio saiu — falha transitória (Meta fora)
    // não pode silenciar o paciente pela janela inteira. Envios que furam o
    // throttle também abrem a janela: um "obrigado" logo depois não gera outro.
    if (r.ok) registrarRedirecionamento(telefone);
    log.info('webhook: redirecionamento à secretaria enviado', { ...contexto, ok: r.ok, simulado: r.simulado });
    return { enviado: r.ok === true, simulado: r.simulado === true };
  } catch (erro) {
    log.error('webhook: falha ao enviar redirecionamento', { ...contexto, erro: erro.message });
    return { enviado: false, erro: erro.message };
  }
}

/** Atalho: pedido de remarcação (mantém a mensagem específica de remarcar). */
async function avisarRemarcacao(telefone, contexto = {}) {
  return enviarRedirecionamento(
    telefone,
    config.whatsapp.remarcarMensagem,
    'Olá, preciso remarcar minha consulta.',
    contexto,
    { throttle: false },
  );
}

/**
 * Processa UMA mensagem recebida. Nunca lança — o webhook precisa responder
 * 200 rápido para a Meta não reenviar.
 *
 * @returns {Promise<{acao: string, codAgendamento?: number, interpretacao?: string}>}
 */
async function processarMensagem(mensagem) {
  const interpretacao = interpretar(mensagem.texto);
  const contexto = {
    idMensagemMeta: mensagem.id,
    telefone: mensagem.telefone,
    interpretacao,
    tipoMensagem: mensagem.tipo,
  };

  // Reentrega da Meta: já tratamos essa mensagem.
  const novo = db.registrarResposta({
    idMensagemMeta: mensagem.id,
    telefone: mensagem.telefone,
    texto: mensagem.texto,
    interpretacao,
  });

  if (!novo) {
    log.info('webhook: mensagem repetida, ignorada', contexto);
    return { acao: 'duplicada' };
  }

  const { envio, origem } = acharAgendamento(mensagem);

  // Opt-out é obrigação legal: atende SEMPRE, mesmo sem saber de que
  // agendamento veio. A revogação por telefone cobre o caso de não
  // conseguirmos identificar o paciente.
  if (interpretacao === 'optout') {
    const codPaciente = envio?.codPaciente ?? null;
    let revogados = db.revogarOptIn({
      telefone: mensagem.telefone,
      motivo: 'revogado pelo paciente via WhatsApp',
    });

    if (codPaciente !== null) {
      revogados += db.revogarOptIn({
        codPaciente,
        motivo: 'revogado pelo paciente via WhatsApp',
      });
    }

    db.concluirResposta(mensagem.id, {
      codAgendamento: envio?.codAgendamento ?? null,
      acao: revogados > 0 ? 'optin_revogado' : 'optout_sem_registro',
      detalhe: `pedido de descadastro; ${revogados} consentimento(s) revogado(s)`,
    });

    log.warn('webhook: paciente pediu opt-out', { ...contexto, codPaciente, revogados });
    return { acao: revogados > 0 ? 'optin_revogado' : 'optout_sem_registro', interpretacao };
  }

  // Opt-in precisa saber QUEM consentiu — sem paciente identificado não há
  // consentimento registrável.
  if (interpretacao === 'optin') {
    const codPaciente = envio?.codPaciente ?? null;

    if (codPaciente === null) {
      db.concluirResposta(mensagem.id, {
        codAgendamento: envio?.codAgendamento ?? null,
        acao: 'pendente_revisao',
        detalhe: 'aceite recebido mas não foi possível identificar o paciente',
      });
      log.warn('webhook: opt-in sem paciente identificável', contexto);
      return { acao: 'pendente_revisao', interpretacao };
    }

    db.registrarOptIn({
      codPaciente,
      canal: 'whatsapp',
      baseLegal: 'consentimento do titular (LGPD art. 7º, I) — coletado via WhatsApp',
      evidencia: String(mensagem.texto ?? '').slice(0, 200),
      telefone: mensagem.telefone,
    });

    db.concluirResposta(mensagem.id, {
      codAgendamento: envio?.codAgendamento ?? null,
      acao: 'optin_registrado',
      detalhe: `consentimento registrado (casado por ${origem})`,
    });

    log.info('webhook: opt-in registrado', { ...contexto, codPaciente });
    return { acao: 'optin_registrado', codAgendamento: envio?.codAgendamento, interpretacao };
  }

  if (!envio) {
    await enviarRedirecionamento(
      mensagem.telefone,
      config.whatsapp.redirecionarMensagem,
      'Olá, preciso falar sobre a minha consulta.',
      contexto,
    );
    db.concluirResposta(mensagem.id, {
      acao: 'sem_correspondencia',
      detalhe: 'nenhum envio recente casa com este telefone — paciente redirecionado à secretaria',
    });
    log.warn('webhook: resposta sem agendamento correspondente', contexto);
    return { acao: 'sem_correspondencia', interpretacao };
  }

  const codAgendamento = envio.codAgendamento;

  if (interpretacao !== 'confirmar' && interpretacao !== 'cancelar') {
    const querRemarcar = CONTEM_REMARCAR.test(normalizar(mensagem.texto));
    if (querRemarcar) {
      await avisarRemarcacao(mensagem.telefone, contexto);
    } else {
      await enviarRedirecionamento(
        mensagem.telefone,
        config.whatsapp.redirecionarMensagem,
        'Olá, preciso falar sobre a minha consulta.',
        contexto,
      );
    }
    db.concluirResposta(mensagem.id, {
      codAgendamento,
      acao: 'pendente_revisao',
      detalhe: querRemarcar
        ? `pedido de remarcação: "${String(mensagem.texto ?? '').slice(0, 100)}" — paciente orientado a falar com a secretaria`
        : `resposta ambígua: "${String(mensagem.texto ?? '').slice(0, 120)}"`,
    });
    log.warn('webhook: resposta ambígua — status NÃO alterado', { ...contexto, codAgendamento, querRemarcar });
    return { acao: 'pendente_revisao', codAgendamento, interpretacao, remarcacao: querRemarcar };
  }

  try {
    const resultado = await aplicarNaClinicweb(interpretacao, codAgendamento);

    if (resultado.bloqueado) {
      db.concluirResposta(mensagem.id, {
        codAgendamento,
        acao: 'escrita_bloqueada',
        detalhe: 'CLINICWEB_PERMITIR_ESCRITA=false',
      });
      // Não conseguimos registrar: NÃO afirmar que cancelou. Só direciona.
      if (interpretacao === 'cancelar') {
        await enviarRedirecionamento(
          mensagem.telefone,
          config.whatsapp.redirecionarMensagem,
          'Olá, preciso falar sobre a minha consulta.',
          contexto,
          { throttle: false },
        );
      }
      return { acao: 'escrita_bloqueada', codAgendamento, interpretacao };
    }

    db.concluirResposta(mensagem.id, {
      codAgendamento,
      acao: 'status_atualizado',
      detalhe: `${interpretacao} (casado por ${origem})`,
    });

    log.info('webhook: status atualizado na ClinicWeb', {
      ...contexto,
      codAgendamento,
      origem,
    });

    // Cancelamento REGISTRADO com sucesso: agora sim confirma e orienta a remarcar.
    if (interpretacao === 'cancelar') {
      await enviarRedirecionamento(
        mensagem.telefone,
        config.whatsapp.cancelarMensagem,
        'Olá, preciso remarcar a minha consulta.',
        contexto,
        { throttle: false },
      );
    }

    return { acao: 'status_atualizado', codAgendamento, interpretacao };
  } catch (erro) {
    db.concluirResposta(mensagem.id, {
      codAgendamento,
      acao: 'erro',
      detalhe: erro.message,
    });
    log.error('webhook: falha ao atualizar status na ClinicWeb', {
      ...contexto,
      alerta: true,
      codAgendamento,
      erro: erro.message,
    });
    // Falha na gravação: direciona sem afirmar que o cancelamento foi feito.
    if (interpretacao === 'cancelar') {
      await enviarRedirecionamento(
        mensagem.telefone,
        config.whatsapp.redirecionarMensagem,
        'Olá, preciso falar sobre a minha consulta.',
        contexto,
        { throttle: false },
      );
    }
    return { acao: 'erro', codAgendamento, interpretacao };
  }
}

/**
 * Processa o payload inteiro do webhook.
 * @returns {Promise<{processadas: number, resultados: object[]}>}
 */
async function processar(payload) {
  const mensagens = extrairMensagens(payload);

  if (mensagens.length === 0) {
    // Eventos de status de entrega (sent/delivered/read) caem aqui — normal.
    return { processadas: 0, resultados: [] };
  }

  const resultados = [];
  for (const mensagem of mensagens) {
    try {
      resultados.push(await processarMensagem(mensagem));
    } catch (erro) {
      log.error('webhook: erro inesperado ao processar mensagem', {
        idMensagemMeta: mensagem.id,
        erro: erro.message,
      });
      resultados.push({ acao: 'erro' });
    }
  }

  return { processadas: resultados.length, resultados };
}

module.exports = {
  interpretar,
  normalizar,
  assinaturaValida,
  verificarDesafio,
  extrairMensagens,
  processarMensagem,
  processar,
  acharAgendamento,
  avisarRemarcacao,
  enviarRedirecionamento,
  _resetThrottle,
};
