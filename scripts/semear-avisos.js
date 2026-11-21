'use strict';

/**
 * SEMEADURA DE AVISOS — Opção B.
 *
 * Marca como "já avisado" (statusEnvio='simulado', SEM enviar nada) todos os
 * agendamentos futuros que hoje receberiam o aviso "agendamento_realizado".
 * Assim, ao subir POLLING_JANELA_DIAS (ex.: 90), o backlog atual NÃO dispara o
 * aviso de uma vez — só as marcações NOVAS (feitas depois) recebem o aviso.
 *
 * NÃO envia WhatsApp e NÃO escreve na ClinicWeb: só insere linhas de
 * idempotência no banco local (mensagens_enviadas), com as mesmas primitivas do
 * fluxo real (reservarOuRetentar + marcarEnviado simulado). Confirmação e
 * lembrete seguem normais — só o AVISO do backlog é suprimido.
 *
 * Usa a MESMA busca em blocos e a MESMA regra do job diário (jobs/aviso.js),
 * para semear exatamente o que ele avisaria. Rodar ANTES de AVISO_ATIVO=true.
 *
 * USO (rodar no Console do Railway, que alcança a ClinicWeb):
 *   node scripts/semear-avisos.js                       # DRY-RUN, 730 dias
 *   node scripts/semear-avisos.js --dias 730 --executar # grava a semeadura
 *
 * Reversível: as linhas semeadas têm tipo='agendamento_realizado',
 * statusEnvio='simulado' e idMensagemMeta IS NULL.
 */

const tem = (f) => process.argv.includes(`--${f}`);
const val = (f, d) => {
  const i = process.argv.indexOf(`--${f}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const db = require('../src/db/db');
const agendamentos = require('../src/clinicweb/agendamentos');
const polling = require('../src/jobs/polling');
const templates = require('../src/whatsapp/templates');
const pacientes = require('../src/clinicweb/pacientes');
const telefone = require('../src/lib/telefone');
const { config } = require('../src/config');

const DIAS = Number.parseInt(val('dias', String(config.jobs.avisoJanelaDias)), 10);
const EXECUTAR = tem('executar');

async function principal() {
  db.conectar();
  console.log(`=== SEMEADURA DE AVISOS — horizonte ${DIAS} dias ${EXECUTAR ? '(GRAVANDO)' : '(DRY-RUN)'} ===`);

  let lista;
  try {
    lista = await agendamentos.listarProximosEmBlocos(DIAS);
  } catch (e) {
    console.error('ERRO ao consultar a ClinicWeb (rode no Console do Railway):', e.message);
    process.exitCode = 1;
    return;
  }

  const cont = { total: lista.length, candidatos: 0, semeado: 0, ja_existia: 0 };
  for (const ag of lista) {
    const d = polling.decidir(ag, undefined, {
      dataConfirmada: polling.dataConfirmadaDe(ag),
      comAviso: true,
    });
    if (!(d.ok && d.tipo === templates.TIPO_AGENDAMENTO)) continue;
    cont.candidatos += 1;
    if (!EXECUTAR) continue;

    const resolvido = telefone.paraE164({
      ddi: ag?.Paciente?.ddiCelular,
      ddd: ag?.Paciente?.dddCelular,
      tel: ag?.Paciente?.telCelular,
    });
    const numero = resolvido.ok ? resolvido.numero : null;

    const reserva = db.reservarOuRetentar({
      codAgendamento: ag.codAgendamento,
      codPaciente: pacientes.codPacienteDe(ag),
      tipo: templates.TIPO_AGENDAMENTO,
      telefone: numero,
      dataAgendamento: ag.dataHora ? ag.dataHora.toISO() : null,
    });
    if (!reserva) { cont.ja_existia += 1; continue; }

    db.marcarEnviado(reserva.id, { idMensagemMeta: null, simulado: true, telefone: numero });
    cont.semeado += 1;
  }

  console.log(JSON.stringify(cont, null, 2));
  if (!EXECUTAR) {
    console.log(`\n${cont.candidatos} avisos seriam semeados (= o tamanho da rajada evitada). Acrescente --executar para gravar.`);
  } else {
    console.log(`\nConcluído. ${cont.semeado} semeados, ${cont.ja_existia} já existiam. Agora pode ligar AVISO_ATIVO=true.`);
  }
  db.fechar();
}

principal().catch((e) => {
  console.error('ERRO fatal:', e.message);
  process.exitCode = 1;
});
