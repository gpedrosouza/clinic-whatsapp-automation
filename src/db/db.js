'use strict';

/**
 * Banco local de controle (SQLite via better-sqlite3).
 *
 * REGRA DE OURO do projeto: nenhuma mensagem sai sem passar por aqui antes.
 * O padrão usado é "reservar depois enviar":
 *
 *   1. `reservar()` faz INSERT com statusEnvio='pendente'. Se o índice único
 *      (codAgendamento, tipo) já existir, devolve null => NÃO envia.
 *   2. só então chama a Meta;
 *   3. `marcarEnviado()` / `marcarFalha()` fecham a linha.
 *
 * Se o processo morrer entre 2 e 3, a linha fica 'pendente' e o próximo ciclo
 * NÃO reenvia: `reconciliarPendentes()` a marca como 'indeterminado' para
 * revisão humana. Preferimos uma mensagem a menos do que uma a mais.
 */

const fs = require('node:fs');
const path = require('node:path');

const Database = require('better-sqlite3');

const { config } = require('../config');
const datas = require('../lib/datas');
const log = require('../lib/logger');

const CAMINHO_SCHEMA = path.join(__dirname, 'schema.sql');

let bd = null;

/** Abre (e cria, se preciso) o banco. Idempotente. */
function conectar(caminho = config.app.dbCaminho) {
  if (bd) return bd;

  if (caminho !== ':memory:') {
    const pasta = path.dirname(path.resolve(caminho));
    fs.mkdirSync(pasta, { recursive: true });
  }

  bd = new Database(caminho);
  bd.pragma('journal_mode = WAL');
  bd.exec(fs.readFileSync(CAMINHO_SCHEMA, 'utf8'));

  log.info('db: conectado', { caminho });
  return bd;
}

function conexao() {
  return bd || conectar();
}

/** Fecha o banco (usado nos testes). */
function fechar() {
  if (bd) {
    bd.close();
    bd = null;
  }
}

const agoraIso = () => datas.agora().toISO();

// ---------------------------------------------------------------------------
// Mensagens enviadas
// ---------------------------------------------------------------------------

/**
 * Reserva o direito de enviar. É ISTO que garante a idempotência.
 *
 * @param {{codAgendamento: number, tipo: string, telefone?: string, dataAgendamento?: string}} dados
 * @returns {{id: number}|null} null = já existe registro para (codAgendamento, tipo)
 */
function reservar({ codAgendamento, tipo, telefone = null, dataAgendamento = null, codPaciente = null }) {
  const stmt = conexao().prepare(`
    INSERT OR IGNORE INTO mensagens_enviadas
      (codAgendamento, codPaciente, tipo, statusEnvio, telefone, dataAgendamento, criadoEm, atualizadoEm)
    VALUES (?, ?, ?, 'pendente', ?, ?, ?, ?)
  `);

  const agora = agoraIso();
  const r = stmt.run(codAgendamento, codPaciente, tipo, telefone, dataAgendamento, agora, agora);

  if (r.changes === 0) return null; // já existe — não envia
  return { id: Number(r.lastInsertRowid) };
}

/**
 * Reserva um envio novo OU reabre um que falhou e ainda tem tentativa.
 *
 * Existe porque `reservar()` sozinho é bom demais: uma linha 'falhou' (a Meta
 * caiu, por exemplo) bloquearia o reenvio para sempre. Aqui a retentativa é
 * explícita e limitada por ENVIO_MAX_TENTATIVAS. Status 'invalido',
 * 'indeterminado', 'enviado' e 'simulado' nunca reabrem.
 *
 * @returns {{id: number, novo: boolean, retentativa: boolean}|null}
 */
function reservarOuRetentar(dados) {
  const novo = reservar(dados);
  if (novo) return { id: novo.id, novo: true, retentativa: false };

  const existente = buscarPorAgendamento(dados.codAgendamento, dados.tipo);
  if (!existente) return null; // corrida improvável; melhor não enviar

  // REMARCAÇÃO: o ClinicWeb reaproveita o codAgendamento ao remarcar (só muda
  // a data). Se a data do agendamento mudou em relação ao que já enviamos,
  // reabrimos o envio para avisar da NOVA data — senão o paciente remarcado
  // ficaria sem confirmação/lembrete (a idempotência pularia como já enviado).
  // Comparação em precisão de MINUTO (YYYY-MM-DDTHH:mm): a data do agendamento
  // vem estável da API, mas isso evita reabrir por diferença de segundos/ms.
  const ateMinuto = (iso) => (iso ? String(iso).slice(0, 16) : null);
  const novaData = dados.dataAgendamento ?? null;
  const dataMudou =
    novaData &&
    existente.dataAgendamento &&
    ateMinuto(novaData) !== ateMinuto(existente.dataAgendamento);

  if (dataMudou) {
    const r = conexao()
      .prepare(
        `UPDATE mensagens_enviadas
            SET statusEnvio = 'pendente', dataAgendamento = ?, tentativas = 0,
                erro = NULL, enviadoEm = NULL, criadoEm = ?, atualizadoEm = ?
          WHERE id = ?`,
      )
      .run(novaData, agoraIso(), agoraIso(), existente.id);

    if (r.changes === 0) return null;

    log.info('db: agendamento remarcado — reabrindo envio para a nova data', {
      codAgendamento: dados.codAgendamento,
      tipo: dados.tipo,
      de: existente.dataAgendamento,
      para: novaData,
    });
    return { id: existente.id, novo: false, retentativa: true, remarcado: true };
  }

  // Retentativa de uma FALHA (a Meta caiu, etc.) — limitada por maxTentativas.
  if (existente.statusEnvio !== 'falhou' || existente.tentativas >= config.whatsapp.maxTentativas) {
    return null;
  }

  const r = conexao()
    .prepare(
      `UPDATE mensagens_enviadas
          SET statusEnvio = 'pendente', atualizadoEm = ?
        WHERE id = ? AND statusEnvio = 'falhou'`,
    )
    .run(agoraIso(), existente.id);

  if (r.changes === 0) return null; // outro processo pegou primeiro

  return { id: existente.id, novo: false, retentativa: true };
}

/** A mensagem (codAgendamento, tipo) já foi tratada? */
function jaRegistrado(codAgendamento, tipo) {
  return Boolean(
    conexao()
      .prepare('SELECT 1 FROM mensagens_enviadas WHERE codAgendamento = ? AND tipo = ?')
      .get(codAgendamento, tipo),
  );
}

function buscarPorId(id) {
  return conexao().prepare('SELECT * FROM mensagens_enviadas WHERE id = ?').get(id) ?? null;
}

function buscarPorAgendamento(codAgendamento, tipo) {
  return (
    conexao()
      .prepare('SELECT * FROM mensagens_enviadas WHERE codAgendamento = ? AND tipo = ?')
      .get(codAgendamento, tipo) ?? null
  );
}

function marcarEnviado(id, { idMensagemMeta = null, simulado = false, telefone = null } = {}) {
  conexao()
    .prepare(
      `UPDATE mensagens_enviadas
          SET statusEnvio = ?, idMensagemMeta = ?, enviadoEm = ?, atualizadoEm = ?,
              tentativas = tentativas + 1, erro = NULL,
              telefone = COALESCE(?, telefone)
        WHERE id = ?`,
    )
    .run(simulado ? 'simulado' : 'enviado', idMensagemMeta, agoraIso(), agoraIso(), telefone, id);
}

/**
 * @param {number} id
 * @param {string} erro
 * @param {{definitivo?: boolean}} [opcoes] definitivo = não adianta repetir
 */
function marcarFalha(id, erro, { definitivo = false } = {}) {
  conexao()
    .prepare(
      `UPDATE mensagens_enviadas
          SET statusEnvio = ?, erro = ?, atualizadoEm = ?, tentativas = tentativas + 1
        WHERE id = ?`,
    )
    .run(definitivo ? 'invalido' : 'falhou', String(erro).slice(0, 500), agoraIso(), id);
}

/**
 * Devolve as linhas que falharam e ainda podem ser retentadas no próximo ciclo.
 * `invalido` e `indeterminado` ficam de fora de propósito.
 */
function retentaveis(limite = 100) {
  return conexao()
    .prepare(
      `SELECT * FROM mensagens_enviadas
        WHERE statusEnvio = 'falhou' AND tentativas < ?
        ORDER BY atualizadoEm ASC LIMIT ?`,
    )
    .all(config.whatsapp.maxTentativas, limite);
}

/**
 * Fecha o buraco do "enviou mas não gravou": linhas 'pendente' velhas viram
 * 'indeterminado'. Rodar no início de cada ciclo de job.
 *
 * @returns {number} quantas linhas foram marcadas
 */
function reconciliarPendentes(minutos = config.whatsapp.pendenteTimeoutMin) {
  const limite = datas.agora().minus({ minutes: minutos }).toISO();

  const r = conexao()
    .prepare(
      `UPDATE mensagens_enviadas
          SET statusEnvio = 'indeterminado', atualizadoEm = ?,
              erro = 'pendente além do timeout — verificar manualmente se a mensagem saiu'
        WHERE statusEnvio = 'pendente' AND criadoEm < ?`,
    )
    .run(agoraIso(), limite);

  if (r.changes > 0) {
    log.warn('db: envios indeterminados — revisar manualmente', {
      quantidade: r.changes,
      alerta: true,
    });
  }
  return r.changes;
}

/** Remove a reserva (usado quando o envio nem chegou a ser tentado). */
function liberarReserva(id) {
  conexao().prepare('DELETE FROM mensagens_enviadas WHERE id = ? AND statusEnvio = \'pendente\'').run(id);
}

// ---------------------------------------------------------------------------
// Casamento resposta -> agendamento
// ---------------------------------------------------------------------------

/** Acha o envio que originou uma resposta com `context.id` (o caminho bom). */
function porIdMensagemMeta(idMensagemMeta) {
  return (
    conexao()
      .prepare('SELECT * FROM mensagens_enviadas WHERE idMensagemMeta = ?')
      .get(idMensagemMeta) ?? null
  );
}

/**
 * Fallback: último envio para aquele telefone dentro da janela de resposta.
 * Usado quando o paciente responde sem citar a mensagem.
 */
function ultimoEnvioParaTelefone(telefone, horas = config.whatsapp.janelaRespostaHoras) {
  const limite = datas.agora().minus({ hours: horas }).toISO();

  return (
    conexao()
      .prepare(
        `SELECT * FROM mensagens_enviadas
          WHERE telefone = ? AND enviadoEm IS NOT NULL AND enviadoEm >= ?
          ORDER BY enviadoEm DESC LIMIT 1`,
      )
      .get(telefone, limite) ?? null
  );
}

// ---------------------------------------------------------------------------
// Respostas recebidas
// ---------------------------------------------------------------------------

/**
 * Registra a resposta. Devolve false se a Meta já tinha mandado esse
 * `idMensagemMeta` (reentrega) — nesse caso NÃO processar de novo.
 */
function registrarResposta({ idMensagemMeta, telefone, texto, interpretacao }) {
  const r = conexao()
    .prepare(
      `INSERT OR IGNORE INTO respostas_recebidas
         (idMensagemMeta, telefone, texto, interpretacao, recebidoEm)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(idMensagemMeta, telefone, texto, interpretacao, agoraIso());

  return r.changes > 0;
}

function concluirResposta(idMensagemMeta, { codAgendamento = null, acao, detalhe = null }) {
  conexao()
    .prepare(
      `UPDATE respostas_recebidas
          SET codAgendamento = ?, acao = ?, detalhe = ?
        WHERE idMensagemMeta = ?`,
    )
    .run(codAgendamento, acao, detalhe ? String(detalhe).slice(0, 500) : null, idMensagemMeta);
}

/** Respostas que ninguém tratou — a secretária precisa olhar. */
function respostasPendentes(limite = 50) {
  return conexao()
    .prepare(
      `SELECT * FROM respostas_recebidas
        WHERE acao IN ('pendente_revisao', 'sem_correspondencia', 'erro', 'optout_sem_registro')
        ORDER BY recebidoEm DESC LIMIT ?`,
    )
    .all(limite);
}

// ---------------------------------------------------------------------------
// Opt-in de Marketing (LGPD)
// ---------------------------------------------------------------------------

/**
 * Registra (ou reativa) o consentimento de um paciente.
 *
 * `evidencia` guarda o texto exato que o paciente mandou. Sem isso o
 * consentimento não é comprovável, e consentimento não comprovável não vale.
 *
 * @param {{codPaciente: number, canal?: string, baseLegal: string,
 *          evidencia?: string, telefone?: string}} dados
 */
function registrarOptIn({ codPaciente, canal = 'whatsapp', baseLegal, evidencia = null, telefone = null }) {
  const agora = agoraIso();

  conexao()
    .prepare(
      `INSERT INTO opt_in_pacientes
         (codPaciente, canal, status, baseLegal, evidencia, telefone, consentidoEm, atualizadoEm)
       VALUES (?, ?, 'ativo', ?, ?, ?, ?, ?)
       ON CONFLICT (codPaciente, canal) DO UPDATE SET
         status = 'ativo',
         baseLegal = excluded.baseLegal,
         evidencia = excluded.evidencia,
         telefone = COALESCE(excluded.telefone, opt_in_pacientes.telefone),
         consentidoEm = excluded.consentidoEm,
         revogadoEm = NULL,
         atualizadoEm = excluded.atualizadoEm`,
    )
    .run(codPaciente, canal, baseLegal, evidencia, telefone, agora, agora);

  log.info('optin: consentimento registrado', { codPaciente, canal, baseLegal });
}

/**
 * Revoga o consentimento. A linha NÃO é apagada — fica como prova de que o
 * pedido foi atendido.
 *
 * @returns {number} quantas linhas foram revogadas
 */
function revogarOptIn({ codPaciente = null, telefone = null, canal = 'whatsapp', motivo = null }) {
  if (codPaciente === null && telefone === null) {
    throw new Error('revogarOptIn: informe codPaciente ou telefone');
  }

  const agora = agoraIso();
  const alvo = codPaciente !== null ? 'codPaciente = ?' : 'telefone = ?';
  const valor = codPaciente !== null ? codPaciente : telefone;

  const r = conexao()
    .prepare(
      `UPDATE opt_in_pacientes
          SET status = 'revogado', revogadoEm = ?, atualizadoEm = ?,
              baseLegal = COALESCE(?, baseLegal)
        WHERE ${alvo} AND canal = ? AND status = 'ativo'`,
    )
    .run(agora, agora, motivo, valor, canal);

  if (r.changes > 0) {
    log.info('optin: consentimento revogado', { codPaciente, canal, revogados: r.changes });
  }
  return r.changes;
}

/** O paciente pode receber Marketing? */
function temOptInAtivo(codPaciente, canal = 'whatsapp') {
  return Boolean(
    conexao()
      .prepare(
        "SELECT 1 FROM opt_in_pacientes WHERE codPaciente = ? AND canal = ? AND status = 'ativo'",
      )
      .get(codPaciente, canal),
  );
}

/** Conjunto dos que têm opt-in ativo — evita N consultas dentro do job. */
function codigosComOptIn(canal = 'whatsapp') {
  const linhas = conexao()
    .prepare("SELECT codPaciente FROM opt_in_pacientes WHERE canal = ? AND status = 'ativo'")
    .all(canal);

  return new Set(linhas.map((l) => Number(l.codPaciente)));
}

function listarOptIn(status = null) {
  return status
    ? conexao()
        .prepare('SELECT * FROM opt_in_pacientes WHERE status = ? ORDER BY atualizadoEm DESC')
        .all(status)
    : conexao().prepare('SELECT * FROM opt_in_pacientes ORDER BY atualizadoEm DESC').all();
}

// ---------------------------------------------------------------------------
// Campanhas (aniversário e retorno)
// ---------------------------------------------------------------------------

/**
 * Reserva o envio de campanha. Mesmo padrão das mensagens transacionais:
 * o índice único (codPaciente, tipo, competencia) é a garantia.
 *
 * @returns {{id: number, novo: boolean, retentativa: boolean}|null}
 */
function reservarCampanha({ codPaciente, tipo, competencia, telefone = null }) {
  const agora = agoraIso();

  const r = conexao()
    .prepare(
      `INSERT OR IGNORE INTO campanhas_enviadas
         (codPaciente, tipo, competencia, statusEnvio, telefone, criadoEm, atualizadoEm)
       VALUES (?, ?, ?, 'pendente', ?, ?, ?)`,
    )
    .run(codPaciente, tipo, competencia, telefone, agora, agora);

  if (r.changes > 0) return { id: Number(r.lastInsertRowid), novo: true, retentativa: false };

  const existente = conexao()
    .prepare(
      'SELECT * FROM campanhas_enviadas WHERE codPaciente = ? AND tipo = ? AND competencia = ?',
    )
    .get(codPaciente, tipo, competencia);

  if (
    !existente ||
    existente.statusEnvio !== 'falhou' ||
    existente.tentativas >= config.whatsapp.maxTentativas
  ) {
    return null;
  }

  const atualizou = conexao()
    .prepare(
      `UPDATE campanhas_enviadas SET statusEnvio = 'pendente', atualizadoEm = ?
        WHERE id = ? AND statusEnvio = 'falhou'`,
    )
    .run(agora, existente.id);

  if (atualizou.changes === 0) return null;
  return { id: existente.id, novo: false, retentativa: true };
}

function buscarCampanha(id) {
  return conexao().prepare('SELECT * FROM campanhas_enviadas WHERE id = ?').get(id) ?? null;
}

function marcarCampanhaEnviada(id, { idMensagemMeta = null, simulado = false, telefone = null } = {}) {
  conexao()
    .prepare(
      `UPDATE campanhas_enviadas
          SET statusEnvio = ?, idMensagemMeta = ?, enviadoEm = ?, atualizadoEm = ?,
              tentativas = tentativas + 1, erro = NULL,
              telefone = COALESCE(?, telefone)
        WHERE id = ?`,
    )
    .run(simulado ? 'simulado' : 'enviado', idMensagemMeta, agoraIso(), agoraIso(), telefone, id);
}

function marcarCampanhaFalha(id, erro, { definitivo = false } = {}) {
  conexao()
    .prepare(
      `UPDATE campanhas_enviadas
          SET statusEnvio = ?, erro = ?, atualizadoEm = ?, tentativas = tentativas + 1
        WHERE id = ?`,
    )
    .run(definitivo ? 'invalido' : 'falhou', String(erro).slice(0, 500), agoraIso(), id);
}

/** Mesma reconciliação das mensagens: pendente velho vira indeterminado. */
function reconciliarCampanhasPendentes(minutos = config.whatsapp.pendenteTimeoutMin) {
  const limite = datas.agora().minus({ minutes: minutos }).toISO();

  const r = conexao()
    .prepare(
      `UPDATE campanhas_enviadas
          SET statusEnvio = 'indeterminado', atualizadoEm = ?,
              erro = 'pendente além do timeout — verificar manualmente se a mensagem saiu'
        WHERE statusEnvio = 'pendente' AND criadoEm < ?`,
    )
    .run(agoraIso(), limite);

  if (r.changes > 0) {
    log.warn('db: campanhas indeterminadas — revisar manualmente', {
      quantidade: r.changes,
      alerta: true,
    });
  }
  return r.changes;
}

// ---------------------------------------------------------------------------

/** Contagens para o /health e para os scripts de operação. */
function resumo() {
  const porStatus = conexao()
    .prepare('SELECT statusEnvio, COUNT(*) AS total FROM mensagens_enviadas GROUP BY statusEnvio')
    .all();

  const respostas = conexao()
    .prepare('SELECT acao, COUNT(*) AS total FROM respostas_recebidas GROUP BY acao')
    .all();

  const campanhas = conexao()
    .prepare('SELECT tipo, statusEnvio, COUNT(*) AS total FROM campanhas_enviadas GROUP BY tipo, statusEnvio')
    .all();

  const optin = conexao()
    .prepare('SELECT status, COUNT(*) AS total FROM opt_in_pacientes GROUP BY status')
    .all();

  return {
    mensagens: Object.fromEntries(porStatus.map((l) => [l.statusEnvio, l.total])),
    respostas: Object.fromEntries(respostas.map((l) => [l.acao ?? 'sem_acao', l.total])),
    campanhas: Object.fromEntries(campanhas.map((l) => [`${l.tipo}_${l.statusEnvio}`, l.total])),
    optin: Object.fromEntries(optin.map((l) => [l.status, l.total])),
  };
}

module.exports = {
  conectar,
  conexao,
  fechar,
  reservar,
  reservarOuRetentar,
  jaRegistrado,
  buscarPorId,
  buscarPorAgendamento,
  marcarEnviado,
  marcarFalha,
  retentaveis,
  reconciliarPendentes,
  liberarReserva,
  porIdMensagemMeta,
  ultimoEnvioParaTelefone,
  registrarResposta,
  concluirResposta,
  respostasPendentes,
  registrarOptIn,
  revogarOptIn,
  temOptInAtivo,
  codigosComOptIn,
  listarOptIn,
  reservarCampanha,
  buscarCampanha,
  marcarCampanhaEnviada,
  marcarCampanhaFalha,
  reconciliarCampanhasPendentes,
  resumo,
};
