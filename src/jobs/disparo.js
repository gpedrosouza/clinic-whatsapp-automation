'use strict';

/**
 * O caminho ÚNICO por onde uma mensagem sai do serviço.
 *
 * Confirmação e lembrete compartilham a mesma disciplina, e ela mora aqui para
 * não existir em duas versões ligeiramente diferentes:
 *
 *   1. checa/reserva no banco  — se já existe registro, NÃO envia;
 *   2. só então chama a Meta;
 *   3. grava o desfecho (enviado / falhou / inválido).
 *
 * Nenhum job deve chamar `whatsapp/client.js` direto.
 */

const db = require('../db/db');
const cliente = require('../whatsapp/client');
const pacientes = require('../clinicweb/pacientes');
const telefone = require('../lib/telefone');
const log = require('../lib/logger');

/**
 * @param {object} agendamento agendamento da ClinicWeb (com `dataHora` resolvida)
 * @param {{tipo: string, nomeTemplate: string, idioma: string, parametros: string[]}} mensagem
 * @returns {Promise<{status: 'enviado'|'simulado'|'ja_enviado'|'falhou'|'invalido'|'erro'}>}
 */
async function disparar(agendamento, mensagem) {
  const codAgendamento = agendamento.codAgendamento;
  const tipo = mensagem.tipo;
  const contexto = { codAgendamento, tipo };

  const partes = {
    ddi: agendamento?.Paciente?.ddiCelular,
    ddd: agendamento?.Paciente?.dddCelular,
    tel: agendamento?.Paciente?.telCelular,
  };
  const resolvido = telefone.paraE164(partes);

  // 1. RESERVA — a checagem de idempotência acontece aqui, antes de tudo.
  const reserva = db.reservarOuRetentar({
    codAgendamento,
    codPaciente: pacientes.codPacienteDe(agendamento),
    tipo,
    telefone: resolvido.ok ? resolvido.numero : null,
    dataAgendamento: agendamento.dataHora ? agendamento.dataHora.toISO() : null,
  });

  if (!reserva) {
    log.debug('disparo: já registrado, nada a fazer', contexto);
    return { status: 'ja_enviado' };
  }

  // Telefone imprestável: registra como inválido para não tentar todo ciclo.
  if (!resolvido.ok) {
    db.marcarFalha(reserva.id, `telefone_${resolvido.motivo}`, { definitivo: true });
    log.warn('disparo: paciente sem telefone utilizável', {
      ...contexto,
      motivo: resolvido.motivo,
    });
    return { status: 'invalido' };
  }

  // 2. ENVIO
  try {
    const resultado = await cliente.enviarTemplate(resolvido.numero, mensagem, { contexto });

    // 3. DESFECHO
    if (resultado.ok) {
      db.marcarEnviado(reserva.id, {
        idMensagemMeta: resultado.idMensagemMeta,
        simulado: resultado.simulado,
        telefone: resolvido.numero,
      });
      return { status: resultado.simulado ? 'simulado' : 'enviado' };
    }

    db.marcarFalha(reserva.id, resultado.erro, { definitivo: Boolean(resultado.definitivo) });
    return { status: resultado.definitivo ? 'invalido' : 'falhou' };
  } catch (erro) {
    // Nunca deixar a linha presa em 'pendente' por exceção inesperada.
    db.marcarFalha(reserva.id, erro.message);
    log.error('disparo: erro inesperado no envio', { ...contexto, erro: erro.message });
    return { status: 'erro' };
  }
}

module.exports = { disparar };
