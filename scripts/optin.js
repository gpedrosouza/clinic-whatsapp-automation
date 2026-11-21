'use strict';

/**
 * Auditoria do consentimento de Marketing (LGPD).
 *
 *   node scripts/optin.js listar
 *   node scripts/optin.js listar ativo
 *   node scripts/optin.js verificar 3823
 *   node scripts/optin.js revogar 3823 --motivo "pedido por telefone"
 *
 * A COLETA é feita só pelo WhatsApp (decisão da Sessão 4): o paciente responde
 * uma das palavras de OPTIN_PALAVRAS e o webhook registra. Por isso não existe
 * comando "ativar" aqui — consentimento tem que vir do titular, não de um
 * comando nosso.
 *
 * A revogação manual EXISTE de propósito: a LGPD obriga a atender o pedido de
 * descadastro por qualquer canal (telefone, balcão, e-mail), não só por
 * WhatsApp.
 */

const db = require('../src/db/db');
const u = require('./_util');

function formatarLinha(l) {
  const marca = l.status === 'ativo' ? '✔' : '✖';
  const quando = l.status === 'ativo' ? l.consentidoEm : l.revogadoEm;
  return (
    `  ${marca} paciente=${String(l.codPaciente).padEnd(8)} canal=${String(l.canal).padEnd(9)}` +
    ` ${String(l.status).padEnd(9)} ${String(quando ?? '').slice(0, 19)}` +
    `\n      base: ${l.baseLegal ?? '—'}` +
    (l.evidencia ? `\n      evidência: "${l.evidencia}"` : '')
  );
}

function listar() {
  const status = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;
  const linhas = db.listarOptIn(status);

  u.subtitulo(`consentimentos${status ? ` (${status})` : ''}: ${linhas.length}`);

  if (linhas.length === 0) {
    console.log('  nenhum registro.\n');
    console.log('  Enquanto ninguém tiver opt-in ativo, as campanhas de aniversário');
    console.log('  e retorno não disparam para ninguém — é o comportamento correto.');
    return;
  }

  for (const l of linhas) console.log(formatarLinha(l));
}

function verificar() {
  const codPaciente = Number.parseInt(process.argv[3], 10);
  if (Number.isNaN(codPaciente)) throw new Error('informe o codPaciente');

  const ativo = db.temOptInAtivo(codPaciente);
  u.subtitulo(`paciente ${codPaciente}`);
  console.log(`  pode receber Marketing: ${ativo ? 'SIM' : 'NÃO'}`);

  const linha = db.listarOptIn().find((l) => Number(l.codPaciente) === codPaciente);
  if (linha) console.log(formatarLinha(linha));
}

function revogar() {
  const codPaciente = Number.parseInt(process.argv[3], 10);
  if (Number.isNaN(codPaciente)) throw new Error('informe o codPaciente');

  const motivo = u.opcao('motivo', 'revogado manualmente pela clínica');
  const revogados = db.revogarOptIn({ codPaciente, motivo });

  u.subtitulo(`revogação — paciente ${codPaciente}`);
  console.log(
    revogados > 0
      ? `  ✔ consentimento revogado (${revogados} registro).`
      : '  nada a revogar: paciente não tinha consentimento ativo.',
  );
}

const COMANDOS = { listar, verificar, revogar };

async function principal() {
  const comando = process.argv[2];

  if (!COMANDOS[comando]) {
    console.error(`Uso: node scripts/optin.js <${Object.keys(COMANDOS).join('|')}> [args]`);
    console.error('\nExemplos:');
    console.error('  node scripts/optin.js listar');
    console.error('  node scripts/optin.js listar revogado');
    console.error('  node scripts/optin.js verificar 3823');
    console.error('  node scripts/optin.js revogar 3823 --motivo "pedido por telefone"');
    process.exit(2);
  }

  u.titulo('Opt-in de Marketing');
  db.conectar();
  COMANDOS[comando]();
}

principal().then(() => u.encerrar()).catch(u.encerrar);
