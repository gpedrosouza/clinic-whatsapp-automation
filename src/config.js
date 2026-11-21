'use strict';

/**
 * Carga e validação das variáveis de ambiente.
 * Regra do projeto: nada de credencial hardcoded — tudo vem do .env
 * (espelhado sem valores em .env.example).
 */

const path = require('node:path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

function texto(nome, padrao = '') {
  const v = process.env[nome];
  return v === undefined || v === '' ? padrao : String(v).trim();
}

function inteiro(nome, padrao) {
  const v = texto(nome);
  if (v === '') return padrao;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Variável ${nome} deveria ser um número inteiro, veio "${v}"`);
  }
  return n;
}

function booleano(nome, padrao = false) {
  const v = texto(nome).toLowerCase();
  if (v === '') return padrao;
  return v === 'true' || v === '1' || v === 'sim';
}

function listaInteiros(nome, padrao = []) {
  const v = texto(nome);
  if (v === '') return padrao;
  return v
    .split(',')
    .map((p) => Number.parseInt(p.trim(), 10))
    .filter((n) => !Number.isNaN(n));
}

function lista(nome, padrao = []) {
  const v = texto(nome);
  if (v === '') return padrao;
  return v
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p !== '');
}

function json(nome, padrao) {
  const v = texto(nome);
  if (v === '') return padrao;
  try {
    return JSON.parse(v);
  } catch (erro) {
    throw new Error(`Variável ${nome} deveria ser um JSON válido: ${erro.message}`);
  }
}

const ambiente = texto('CLINICWEB_AMBIENTE', 'stag').toLowerCase();

/**
 * Credencial que pode variar por ambiente. Homologação e produção da clínica
 * têm login/senha/codEmpresa próprios; a v2 (demo presencial) precisa alternar
 * entre os dois sem reescrever o .env inteiro.
 *
 * Resolve na ordem: variável específica do ambiente (`_STAG`/`_PROD`) e, se
 * ausente, cai na variável genérica — mantém compatível com o .env antigo.
 *
 * @param {string} base ex.: 'CLINICWEB_USUARIO'
 */
function credAmbiente(base) {
  const sufixo = ambiente === 'prod' ? 'PROD' : 'STAG';
  return texto(`${base}_${sufixo}`) || texto(base);
}

const config = {
  app: {
    node_env: texto('NODE_ENV', 'development'),
    porta: inteiro('PORT', 3000),
    logNivel: texto('LOG_NIVEL', 'info'),
    fuso: texto('FUSO_HORARIO', 'America/Sao_Paulo'),
    dbCaminho: texto('DB_CAMINHO', './data/clinicweb-whatsapp.sqlite'),
  },

  clinicweb: {
    ambiente,
    baseUrl:
      ambiente === 'prod'
        ? texto('CLINICWEB_URL_PROD', 'https://clinicweb-api.prod.clinicweb.linx.com.br')
        : texto('CLINICWEB_URL_STAG', 'https://clinicweb-api.stag.clinicweb.linx.com.br'),
    usuario: credAmbiente('CLINICWEB_USUARIO'),
    senha: credAmbiente('CLINICWEB_SENHA'),
    otp: credAmbiente('CLINICWEB_OTP'),
    codEmpresa: credAmbiente('CLINICWEB_COD_EMPRESA'),
    timeoutMs: inteiro('CLINICWEB_TIMEOUT_MS', 15000),
    pageSize: inteiro('CLINICWEB_PAGE_SIZE', 50),
    // Espera entre blocos de 30 dias nas buscas longas (aviso/semeadura): a API
    // devolve 429 com muitas consultas seguidas.
    pausaEntreBlocosMs: inteiro('CLINICWEB_PAUSA_BLOCOS_MS', 2000),
    trazerFiliais: booleano('CLINICWEB_TRAZER_FILIAIS', false),
    // Trava: enquanto false, nenhum PATCH/DELETE sai daqui para a agenda real.
    permitirEscrita: booleano('CLINICWEB_PERMITIR_ESCRITA', false),
    status: {
      aguardando: inteiro('CLINICWEB_STATUS_AGUARDANDO', 1),
      confirmado: inteiro('CLINICWEB_STATUS_CONFIRMADO', 2),
      // "Não chegou" (3) é, nesta clínica, o estado PADRÃO de um agendamento
      // ainda NÃO CONFIRMADO (vale para qualquer data, não só o dia da consulta),
      // não uma falta. Por isso entra no fluxo como "em aberto".
      naoChegou: inteiro('CLINICWEB_STATUS_NAO_CHEGOU', 3),
      canceladoPaciente: inteiro('CLINICWEB_STATUS_CANCELADO_PACIENTE', 23),
    },
  },

  clinica: {
    nome: texto('CLINICA_NOME', 'a clínica'),
    endereco: texto('CLINICA_ENDERECO', '—'),
  },

  meta: {
    graphUrl: texto('META_GRAPH_URL', 'https://graph.facebook.com'),
    apiVersao: texto('META_API_VERSAO', 'v21.0'),
    phoneNumberId: texto('META_PHONE_NUMBER_ID'),
    wabaId: texto('META_WABA_ID'),
    token: texto('META_TOKEN'),
    webhookVerifyToken: texto('META_WEBHOOK_VERIFY_TOKEN'),
    appSecret: texto('META_APP_SECRET'),
    idioma: texto('META_TEMPLATE_IDIOMA', 'pt_BR'),
    templates: {
      agendamento: texto('META_TEMPLATE_AGENDAMENTO'),
      confirmacao: texto('META_TEMPLATE_CONFIRMACAO'),
      lembrete: texto('META_TEMPLATE_LEMBRETE'),
      retorno: texto('META_TEMPLATE_RETORNO'),
      aniversario: texto('META_TEMPLATE_ANIVERSARIO'),
    },
  },

  whatsapp: {
    ddiPadrao: texto('WHATSAPP_DDI_PADRAO', '55'),
    modoSeco: booleano('WHATSAPP_MODO_SECO', true),
    numeroTeste: texto('WHATSAPP_NUMERO_TESTE'),
    preparoPadrao: texto('PREPARO_PADRAO', '—'),
    preparoPorProcedimento: json('PREPARO_POR_PROCEDIMENTO', {}),
    // Nome do profissional por código, usado quando a API não traz o nome.
    // Ex.: {"12":"Dra. Ana","15":"Dr. Carlos"} (ver docs/08).
    profissionalPorCod: json('PROFISSIONAL_POR_COD', {}),
    // Tratamento por primeiro nome (fonte de verdade; `sexo` da API nao e
    // confiavel). Ex.: {"carlos":"Dr. Carlos","ana":"Dra. Ana"}.
    profissionalPorNome: json('PROFISSIONAL_POR_NOME', {}),
    // Recomendacao geral anexada a TODOS os lembretes ({{8}}), alem do preparo.
    recomendacaoGeral: texto('RECOMENDACAO_GERAL', ''),
    // Numero da secretaria (so digitos, E.164) para onde o paciente e
    // direcionado ao pedir remarcacao. Vazio = nao envia a auto-resposta.
    secretariaWhatsapp: texto('SECRETARIA_WHATSAPP', ''),
    remarcarMensagem: texto(
      'REMARCAR_MENSAGEM',
      'Recebemos a sua resposta. Para remarcar ou ajustar o seu agendamento, fale diretamente com a nossa secretaria pelo WhatsApp: {link}. Vamos te ajudar a encontrar o melhor horário.',
    ),
    cancelarMensagem: texto(
      'CANCELAR_MENSAGEM',
      'Recebemos o seu cancelamento. Se quiser remarcar, fale com a nossa secretaria pelo WhatsApp: {link}.',
    ),
    // Catch-all: qualquer mensagem livre/não reconhecida é redirecionada à
    // secretaria (o número automático não tem atendimento humano).
    redirecionarMensagem: texto(
      'REDIRECIONAR_MENSAGEM',
      'Este é um canal automático de confirmação de consultas. Para remarcar, tirar dúvidas ou falar com a nossa equipe, fale diretamente com a nossa secretaria pelo WhatsApp: {link}.',
    ),
    // Catch-all anti-spam: minutos de silencio antes de reenviar o
    // redirecionamento a secretaria para o MESMO telefone (0 = sem throttle).
    redirecionamentoCooldownMin: inteiro('REDIRECIONAMENTO_COOLDOWN_MIN', 10),
    maxTentativas: inteiro('ENVIO_MAX_TENTATIVAS', 3),
    // Depois disso, um envio que ficou "pendente" (caiu entre o disparo e a
    // gravação) vira "indeterminado" e NÃO é reenviado sozinho.
    pendenteTimeoutMin: inteiro('ENVIO_PENDENTE_TIMEOUT_MIN', 10),
    // Janela para casar uma resposta sem contexto com o último envio.
    janelaRespostaHoras: inteiro('WEBHOOK_JANELA_RESPOSTA_HORAS', 72),
    // Palavras que concedem/revogam o opt-in de Marketing pelo WhatsApp.
    // Precisam ser inequívocas: "sim" NÃO entra aqui — é confirmação de
    // agendamento, não consentimento para campanha.
    palavrasOptIn: lista('OPTIN_PALAVRAS', ['aceito', 'autorizo', 'concordo', 'quero receber']),
    palavrasOptOut: lista('OPTOUT_PALAVRAS', ['sair', 'parar', 'pare', 'stop', 'descadastrar']),
  },

  jobs: {
    ativos: booleano('JOBS_ATIVOS', false),
    pollingIntervaloMin: inteiro('POLLING_INTERVALO_MIN', 30),
    // Só a confirmação usa esta janela (mín. 4 p/ a regra da sexta; máx. 31, limite da API).
    pollingJanelaDias: inteiro('POLLING_JANELA_DIAS', 4),
    lembreteIntervaloMin: inteiro('LEMBRETE_INTERVALO_MIN', 15),
    confirmacaoHoras: inteiro('CONFIRMACAO_HORAS', 72),
    // Antecedência (dias) do pedido de confirmação; se cair no fim de semana é
    // antecipado para a sexta (consulta de segunda → confirma na sexta).
    confirmacaoAntecedenciaDias: inteiro('CONFIRMACAO_ANTECEDENCIA_DIAS', 2),
    // Aviso "agendamento realizado" (antes do dia da confirmação). Job diário
    // próprio (jobs/aviso.js). Desligado por padrão — só ligar DEPOIS da
    // semeadura (scripts/semear-avisos.js), senão o backlog recebe o aviso.
    avisoAtivo: booleano('AVISO_ATIVO', false),
    // Janela do aviso (dias à frente) e quando ele roda (cron, fuso da clínica).
    avisoJanelaDias: inteiro('AVISO_JANELA_DIAS', 730),
    avisoCron: texto('AVISO_CRON', '30 8 * * 1-5'),
    lembreteHoras: listaInteiros('LEMBRETE_HORAS', [24]),
    lembreteToleranciaMin: inteiro('LEMBRETE_TOLERANCIA_MIN', 60),
    // Hora fixa em que o lembrete de véspera sai (vale todo dia, inclusive
    // domingo p/ consulta de segunda); vai de VESPERA_HORA até ENVIO_HORA_FIM.
    lembreteVesperaHora: texto('LEMBRETE_VESPERA_HORA', '18:00'),
    campanhasCron: texto('CAMPANHAS_CRON', '0 9 * * *'),
    campanhasAtivas: booleano('CAMPANHAS_ATIVAS', false),
    // Recall — regra confirmada na Sessão 4 (ver docs/02 e docs/05)
    recallMeses: inteiro('RECALL_MESES', 6),
    recallJanelaDias: inteiro('RECALL_JANELA_DIAS', 30),
    recallHorizonteFuturoDias: inteiro('RECALL_HORIZONTE_FUTURO_DIAS', 365),
    campanhaMaxPorDia: inteiro('CAMPANHA_MAX_POR_DIA', 50),
    envioHoraInicio: texto('ENVIO_HORA_INICIO', '08:00'),
    envioHoraFim: texto('ENVIO_HORA_FIM', '20:00'),
    // Só dispara em dias úteis (seg–sex): a clínica não atende fim de semana.
    enviarSomenteDiasUteis: booleano('ENVIO_SOMENTE_DIAS_UTEIS', true),
  },

  retry: {
    tentativas: inteiro('RETRY_TENTATIVAS', 3),
    baseMs: inteiro('RETRY_BASE_MS', 500),
  },
};

/**
 * Valida a presença das variáveis exigidas por um grupo de funcionalidade.
 * Chamado sob demanda (não na carga do módulo), para que o healthcheck e os
 * testes unitários rodem sem exigir credenciais.
 *
 * @param {'clinicweb'|'meta'} grupo
 */
function exigir(grupo) {
  const faltando = [];

  if (grupo === 'clinicweb') {
    if (!config.clinicweb.usuario) faltando.push('CLINICWEB_USUARIO');
    if (!config.clinicweb.senha) faltando.push('CLINICWEB_SENHA');
    if (!config.clinicweb.codEmpresa) faltando.push('CLINICWEB_COD_EMPRESA');
  }

  if (grupo === 'meta') {
    if (!config.meta.phoneNumberId) faltando.push('META_PHONE_NUMBER_ID');
    if (!config.meta.token) faltando.push('META_TOKEN');
  }

  if (grupo === 'webhook') {
    if (!config.meta.webhookVerifyToken) faltando.push('META_WEBHOOK_VERIFY_TOKEN');
    if (!config.meta.appSecret) faltando.push('META_APP_SECRET');
  }

  if (faltando.length > 0) {
    const erro = new Error(
      `Variáveis de ambiente ausentes (${grupo}): ${faltando.join(', ')}. ` +
        'Copie .env.example para .env e preencha.',
    );
    // Erro de configuração não melhora com retry — ver lib/retry.js.
    erro.permanente = true;
    throw erro;
  }
}

module.exports = { config, exigir };
