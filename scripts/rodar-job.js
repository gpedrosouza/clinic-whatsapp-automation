'use strict';

/**
 * Roda UM ciclo de um job, à mão, sem esperar o cron.
 *
 *   node scripts/rodar-job.js polling
 *   node scripts/rodar-job.js lembrete
 *
 * Respeita todas as travas do .env (WHATSAPP_MODO_SECO, janela de horário,
 * idempotência). Com MODO_SECO=true nada sai de verdade — dá para exercitar
 * o fluxo inteiro contra homologação sem incomodar paciente nenhum.
 */

const { config } = require('../src/config');
const db = require('../src/db/db');
const datas = require('../src/lib/datas');
const u = require('./_util');

const JOBS = {
  polling: () => require('../src/jobs/polling'),
  lembrete: () => require('../src/jobs/lembrete'),
  campanhas: () => require('../src/jobs/campanhas'),
};

async function principal() {
  const nome = process.argv[2];

  if (!JOBS[nome]) {
    console.error(`Uso: node scripts/rodar-job.js <${Object.keys(JOBS).join('|')}>`);
    process.exit(2);
  }

  u.titulo(`Executando um ciclo de: ${nome}`);
  console.log(`ambiente ClinicWeb: ${config.clinicweb.ambiente}`);
  console.log(`modo seco (WhatsApp): ${config.whatsapp.modoSeco}`);
  console.log(`escrita na ClinicWeb: ${config.clinicweb.permitirEscrita}`);
  console.log(`número de teste: ${config.whatsapp.numeroTeste || '(nenhum)'}`);
  console.log(`janela de envio: ${config.jobs.envioHoraInicio}-${config.jobs.envioHoraFim}`);
  console.log(`agora: ${datas.agora().toFormat('dd/MM/yyyy HH:mm')} (${datas.FUSO})`);

  db.conectar();

  const job = JOBS[nome]();
  const resultado = await job.ciclo();

  u.subtitulo('resultado do ciclo');
  console.log(JSON.stringify(resultado, null, 2));

  u.subtitulo('estado do banco');
  console.log(JSON.stringify(db.resumo(), null, 2));

  // Ciclo que morreu na API não pode sair como sucesso.
  if (resultado.pulado === 'erro_api') {
    throw new Error('o ciclo não rodou: falha ao consultar a ClinicWeb (veja o log acima)');
  }
}

principal().then(() => u.encerrar()).catch(u.encerrar);
