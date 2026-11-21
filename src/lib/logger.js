'use strict';

/**
 * Log estruturado (uma linha JSON por evento) — facilita leitura no Railway/Render.
 *
 * Cuidado LGPD: não logar corpo de mensagem nem dado clínico. Telefone e nome
 * são mascarados por `mascarar()` antes de entrar no log.
 */

const { agora } = require('./datas');
const { config } = require('../config');

const NIVEIS = { debug: 10, info: 20, warn: 30, error: 40 };
const nivelMinimo = NIVEIS[config.app.logNivel] || NIVEIS.info;

function escrever(nivel, mensagem, extra = {}) {
  if (NIVEIS[nivel] < nivelMinimo) return;

  const linha = {
    ts: agora().toISO(),
    nivel,
    msg: mensagem,
    ...extra,
  };

  const destino = nivel === 'error' || nivel === 'warn' ? console.error : console.log;
  destino(JSON.stringify(linha));
}

/** Mascara um telefone para log: 5511999998888 -> 55119****8888 */
function mascararTelefone(valor) {
  const s = String(valor || '');
  if (s.length < 8) return '***';
  return `${s.slice(0, 5)}****${s.slice(-4)}`;
}

/** Mascara um nome para log: "MARIA DA SILVA" -> "MARIA D." */
function mascararNome(valor) {
  const partes = String(valor || '').trim().split(/\s+/);
  if (partes.length === 0 || partes[0] === '') return '***';
  const [primeiro, ...resto] = partes;
  return resto.length > 0 ? `${primeiro} ${resto[resto.length - 1][0]}.` : primeiro;
}

/** Remove/encobre segredos de um objeto antes de logar. */
function mascarar(obj) {
  const proibidas = /senha|password|token|secret|authorization|otp/i;
  const saida = {};
  for (const [chave, valor] of Object.entries(obj || {})) {
    if (proibidas.test(chave)) {
      saida[chave] = '***';
      // `^to$` é o campo de destinatário da Meta. Ancorado de propósito:
      // um `to$` solto mascararia "codAgendamento".
    } else if (/telefone|celular|whatsapp|^to$|^para$/i.test(chave)) {
      saida[chave] = mascararTelefone(valor);
    } else if (/^nome/i.test(chave)) {
      saida[chave] = mascararNome(valor);
    } else {
      saida[chave] = valor;
    }
  }
  return saida;
}

module.exports = {
  debug: (msg, extra) => escrever('debug', msg, mascarar(extra)),
  info: (msg, extra) => escrever('info', msg, mascarar(extra)),
  warn: (msg, extra) => escrever('warn', msg, mascarar(extra)),
  error: (msg, extra) => escrever('error', msg, mascarar(extra)),
  mascararTelefone,
  mascararNome,
  mascarar,
};
