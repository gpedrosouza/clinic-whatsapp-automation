'use strict';

/**
 * Montagem das mensagens de template da Meta.
 *
 * Os textos NÃO vivem aqui — quem manda é o template aprovado no WhatsApp
 * Manager (a Meta só aceita o `name` + os parâmetros posicionais). O que este
 * módulo faz é traduzir um agendamento da ClinicWeb na ORDEM de variáveis que
 * cada template espera. Se o texto mudar na Meta, mude o mapa aqui junto.
 *
 * Fonte de verdade dos textos: docs/08-templates-whatsapp.md
 *
 * ---------------------------------------------------------------------------
 * São TRÊS mensagens de Utilidade no ciclo de um agendamento (ver docs/08):
 *
 * agendamento_realizado (Utilidade) — disparo na detecção do agendamento novo
 *   "Olá, {{1}}! Seu agendamento de {{2}} com {{3}} na {{4}} foi realizado para
 *    o dia {{5}} às {{6}}." — só informa, NÃO pede ação. Sem botões.
 *   {{1}} nome  {{2}} profissional  {{3}} clínica  {{4}} data  {{5}} hora
 *
 * confirmacao_consulta (Utilidade) — ~3 dias antes (CONFIRMACAO_HORAS)
 *   "... Podemos confirmar a sua presença?" — pede ação e aciona o PATCH.
 *   Mesmas variáveis {{1}}..{{6}}. Botões: "Confirmar presença" | "Preciso remarcar"
 *
 * lembrete_consulta (Utilidade) — véspera, ~1 dia antes (LEMBRETE_HORAS)
 *   Lembra da consulta com preparo e endereço; NÃO pede confirmação. Sem botões.
 *   {{1}} nome  {{2}} profissional  {{3}} clínica  {{4}} data  {{5}} hora
 *   {{7}} endereço                       ex.: Rua X, 100 — Centro
 *   {{8}} preparo (ou "—" quando não há) ex.: Comparecer em jejum de 8h.
 * ---------------------------------------------------------------------------
 *
 * Regras da Meta respeitadas: parâmetro não pode ser vazio, conter quebra de
 * linha, tab ou 4+ espaços seguidos — senão a API devolve erro 132000/131008.
 */

const { config } = require('../config');
const datas = require('../lib/datas');

const TIPO_AGENDAMENTO = 'agendamento_realizado';
const TIPO_CONFIRMACAO = 'confirmacao';
const prefixoLembrete = (horas) => `lembrete_${horas}h`;

/** Higieniza um parâmetro para não estourar as regras da Meta. */
function parametro(valor, alternativa = '—') {
  const texto = String(valor ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{4,}/g, ' ')
    .trim();
  return texto === '' ? alternativa : texto;
}

/** "MARIA DA SILVA" -> "Maria". Nome inteiro em caixa alta soa como cobrança. */
function primeiroNome(nomeCompleto) {
  const bruto = String(nomeCompleto ?? '').trim().split(/\s+/)[0] || '';
  if (bruto === '') return 'tudo bem';
  return bruto.charAt(0).toUpperCase() + bruto.slice(1).toLowerCase();
}

/**
 * Procedimento do agendamento. Cai para um termo genérico quando a API não
 * traz o grupo — melhor "seu atendimento" do que uma variável vazia (que a
 * Meta recusa).
 */
function procedimento(agendamento) {
  const nome = agendamento?.GrupoProcedimento?.nome || agendamento?.Especialidade?.descricao;
  return parametro(nome ? tituloCaso(nome) : nome, 'seu atendimento');
}

/**
 * Normaliza a caixa de um rotulo (procedimento) que vem da API sem padrao:
 * "ESTETICA" -> "Estetica", "SESSAO" -> "Sessao", "Consulta" -> "Consulta".
 */
function tituloCaso(valor) {
  return String(valor ?? '')
    .toLowerCase()
    .replace(/(^|[\s/-])(\p{L})/gu, (_todo, sep, ch) => sep + ch.toUpperCase());
}

/**
 * Instrução de preparo ({{7}} do lembrete).
 *
 * A API da ClinicWeb não expõe preparo. Fica configurável por código de
 * procedimento via PREPARO_POR_PROCEDIMENTO (JSON no .env), com PREPARO_PADRAO
 * como fallback. ❓ A lista real precisa vir da clínica.
 */
function preparo(agendamento) {
  const cod = agendamento?.codProcedimento ?? agendamento?.GrupoProcedimento?.codGrupoProcedimento;
  const mapa = config.whatsapp.preparoPorProcedimento || {};
  const especifico = mapa[String(cod)];
  const geral = (config.whatsapp.recomendacaoGeral || '').trim();

  const partes = [];
  if (especifico) partes.push(especifico);
  if (geral) partes.push(geral);

  if (partes.length === 0) return parametro(config.whatsapp.preparoPadrao || '—');
  return parametro(partes.join(' '));
}

/**
 * Nome do profissional que vai atender ({{3}}).
 *
 * Prioridade: (1) override por código em PROFISSIONAL_POR_COD (JSON no .env);
 * (2) nome da API formatado como "Dr./Dra. <primeiro nome>" — o cadastro vem em
 * CAIXA ALTA e com nome inteiro, e o tratamento sai do sexo do profissional;
 * (3) "nossa equipe" de último recurso. Nunca devolve vazio (a Meta recusa).
 */
function profissional(agendamento) {
  const prof = agendamento?.Profissional || {};
  const cod = agendamento?.codProfissional ?? prof.codUsuario;
  const mapaCod = config.whatsapp.profissionalPorCod || {};
  const mapaNome = config.whatsapp.profissionalPorNome || {};

  // 1. Override explícito por código (quando a API traz codProfissional).
  if (cod != null && mapaCod[String(cod)]) {
    return parametro(mapaCod[String(cod)], 'nossa equipe');
  }

  const nomeApi = prof.nome || prof.nomeCompleto || agendamento?.nomeProfissional;
  const primeiro = nomeApi ? primeiroNome(nomeApi) : '';

  // 2. Override pelo primeiro nome. É a fonte de verdade do tratamento:
  //    o campo `sexo` do ClinicWeb provou-se não confiável (ex.: Carlos
  //    vinha como "F" -> "Dra. Carlos").
  if (primeiro && mapaNome[primeiro.toLowerCase()]) {
    return parametro(mapaNome[primeiro.toLowerCase()], 'nossa equipe');
  }

  // 3. Fallback: nome da API + tratamento pelo sexo (pode vir errado).
  if (primeiro) {
    const sexo = String(prof.sexo || '').trim().toUpperCase();
    const tratamento = sexo === 'F' ? 'Dra.' : sexo === 'M' ? 'Dr.' : '';
    return parametro(tratamento ? `${tratamento} ${primeiro}` : primeiro, 'nossa equipe');
  }

  // 4. Nada utilizável.
  return 'nossa equipe';
}

/**
 * Parâmetros comuns às mensagens.
 * @param {object} agendamento com `dataHora` (DateTime) já resolvida
 */
function base(agendamento) {
  const dataHora = agendamento.dataHora || datas.deDataHoraClinicweb(agendamento);
  if (!dataHora) {
    const erro = new Error(
      `agendamento ${agendamento?.codAgendamento}: data/hora inválida (${agendamento?.data} ${agendamento?.hora})`,
    );
    erro.permanente = true;
    throw erro;
  }

  return {
    nome: parametro(primeiroNome(agendamento?.Paciente?.nome), 'tudo bem'),
    procedimento: procedimento(agendamento),
    profissional: profissional(agendamento),
    clinica: parametro(config.clinica.nome, 'a clínica'),
    data: datas.formatarDataBr(dataHora).slice(0, 5), // dd/MM — o ano polui
    hora: datas.formatarHoraBr(dataHora),
  };
}

/**
 * Monta os parâmetros do AVISO de agendamento realizado, {{1}}..{{5}}.
 * Mensagem informativa (a secretária marcou) — não pede ação do paciente.
 */
function agendamentoRealizado(agendamento) {
  const b = base(agendamento);
  return {
    tipo: TIPO_AGENDAMENTO,
    nomeTemplate: config.meta.templates.agendamento,
    idioma: config.meta.idioma,
    parametros: [b.nome, b.profissional, b.clinica, b.data, b.hora],
  };
}

/** Monta os parâmetros do template de CONFIRMAÇÃO, na ordem {{1}}..{{5}}. */
function confirmacao(agendamento) {
  const b = base(agendamento);
  return {
    tipo: TIPO_CONFIRMACAO,
    nomeTemplate: config.meta.templates.confirmacao,
    idioma: config.meta.idioma,
    parametros: [b.nome, b.profissional, b.clinica, b.data, b.hora],
  };
}

/** Monta os parâmetros do template de LEMBRETE, na ordem {{1}}..{{7}}. */
function lembrete(agendamento, horasAntes) {
  const b = base(agendamento);
  return {
    tipo: horasAntes == null ? 'lembrete' : prefixoLembrete(horasAntes),
    nomeTemplate: config.meta.templates.lembrete,
    idioma: config.meta.idioma,
    parametros: [
      b.nome,
      b.profissional,
      b.clinica,
      b.data,
      b.hora,
      parametro(config.clinica.endereco),
      preparo(agendamento),
    ],
  };
}

// ---------------------------------------------------------------------------
// Campanhas de MARKETING (Fase 2b)
//
// Categoria diferente das de cima: custam mais por conversa e SÓ podem sair
// para quem tem opt-in ativo. Quem checa isso é o job — aqui só se monta.
//
// felicitacao_aniversario (Marketing)
//   "Feliz aniversário, {{1}}! 🎉 A equipe da {{2}} deseja..."
//   {{1}} primeiro nome do paciente
//   {{2}} nome da clínica
//   Rodapé fixo: "Para não receber estas mensagens, responda SAIR."
//
// lembrete_retorno (Marketing)
//   "Olá, {{1}}! Notamos que sua última visita à {{2}} foi há um tempinho."
//   {{1}} primeiro nome do paciente
//   {{2}} nome da clínica
//   Rodapé fixo: "Para não receber estas mensagens, responda SAIR."
//
// Nenhum dado clínico entra nestes textos — nem procedimento, nem data de
// atendimento. É recall, não prontuário.
// ---------------------------------------------------------------------------

const TIPO_ANIVERSARIO = 'aniversario';
const TIPO_RETORNO = 'retorno';

/** Parâmetros comuns às campanhas: só nome e clínica. */
function baseCampanha(paciente) {
  return [
    parametro(primeiroNome(paciente?.nome), 'tudo bem'),
    parametro(config.clinica.nome, 'a clínica'),
  ];
}

/** Monta o template de ANIVERSÁRIO, na ordem {{1}}..{{2}}. */
function aniversario(paciente) {
  return {
    tipo: TIPO_ANIVERSARIO,
    nomeTemplate: config.meta.templates.aniversario,
    idioma: config.meta.idioma,
    parametros: baseCampanha(paciente),
  };
}

/** Monta o template de RETORNO/recall, na ordem {{1}}..{{2}}. */
function retorno(paciente) {
  return {
    tipo: TIPO_RETORNO,
    nomeTemplate: config.meta.templates.retorno,
    idioma: config.meta.idioma,
    parametros: baseCampanha(paciente),
  };
}

module.exports = {
  TIPO_AGENDAMENTO,
  TIPO_CONFIRMACAO,
  TIPO_ANIVERSARIO,
  TIPO_RETORNO,
  prefixoLembrete,
  agendamentoRealizado,
  confirmacao,
  lembrete,
  aniversario,
  retorno,
  primeiroNome,
  parametro,
  procedimento,
  profissional,
  preparo,
};
