'use strict';

/**
 * Descoberta da Fase 1 — agendamentos.
 *
 *   npm run testar:agendamentos
 *   node scripts/testar-agendamentos.js --dias 30
 *   node scripts/testar-agendamentos.js --de 2026-07-01 --ate 2026-07-31
 *   node scripts/testar-agendamentos.js --bruto        # mostra PII, cuidado
 *
 * Responde às lacunas de docs/03:
 *  - quais códigos de status existem de verdade (e qual é "Confirmado");
 *  - se o telefone do paciente vem preenchido e forma um E.164 válido;
 *  - se a nossa leitura de data/hora (fuso America/Sao_Paulo) casa com o
 *    campo `dataHoraUTC` devolvido pela API.
 */

const { DateTime } = require('luxon');

const agendamentos = require('../src/clinicweb/agendamentos');
const datas = require('../src/lib/datas');
const telefone = require('../src/lib/telefone');
const { config } = require('../src/config');
const u = require('./_util');

const CAMPOS = [
  'codAgendamento',
  'codEmpresa',
  'codPaciente',
  'data',
  'hora',
  'dataFinal',
  'dataHoraUTC',
  'status',
  'ativo',
  'retorno',
  'intervalo',
  'observacoes',
  'Status.codAgendamentoStatus',
  'Status.descricao',
  'GrupoProcedimento.nome',
  'Profissional.nome',
  'Paciente.codUsuario',
  'Paciente.nome',
  'Paciente.dataNascimento',
  'Paciente.email',
  'Paciente.ddiCelular',
  'Paciente.dddCelular',
  'Paciente.telCelular',
];

async function listarStatus() {
  u.subtitulo('GET /agendamento-status — códigos reais');

  const status = await agendamentos.listarStatus();
  console.log(`${status.length} status retornados:\n`);

  for (const s of status) {
    console.log(
      `  ${String(s.codAgendamentoStatus).padStart(3)}  ${String(s.descricao).padEnd(40)} ativo=${s.agendamentoAtivo} pacienteVeio=${s.pacienteVeio}`,
    );
  }

  const confirmado = status.find((s) => /confirmad/i.test(s.descricao || ''));
  const cancelado = status.filter((s) => /cancel/i.test(s.descricao || ''));

  console.log('\n>> CONFERIR NO .env:');
  console.log(
    `   CLINICWEB_STATUS_CONFIRMADO=${config.clinicweb.status.confirmado}` +
      (confirmado
        ? `  | API diz: ${confirmado.codAgendamentoStatus} ("${confirmado.descricao}") ${
            confirmado.codAgendamentoStatus === config.clinicweb.status.confirmado ? '✔ bate' : '✖ DIVERGE'
          }`
        : '  | API não trouxe nenhum status com "confirmad" na descrição'),
  );
  if (cancelado.length > 0) {
    console.log('   status de cancelamento disponíveis:');
    for (const c of cancelado) console.log(`     ${c.codAgendamentoStatus} = "${c.descricao}"`);
  }
}

async function listarAgenda() {
  const dias = u.opcaoInteiro('dias', config.jobs.pollingJanelaDias);
  const janela = datas.janelaDias(0, dias);
  const startDate = u.opcao('de', janela.startDate);
  const endDate = u.opcao('ate', janela.endDate);

  u.subtitulo(`GET /agendamentos — ${startDate} até ${endDate}`);

  const lista = await agendamentos.listarTodos({ startDate, endDate });
  console.log(`${lista.length} agendamento(s) na janela.`);

  if (lista.length === 0) {
    console.log(
      '\nNenhum agendamento no período. Amplie a janela (--dias 60) ou use\n' +
        '--de/--ate em um intervalo com agenda cadastrada na homologação.',
    );
    return;
  }

  u.subtitulo('primeiro agendamento (payload)');
  u.json(lista[0]);
  if (!u.bruto) console.log('\n(PII mascarada — rode com --bruto para ver os valores literais)');

  u.subtitulo('preenchimento dos campos que a integração usa');
  u.relatorioCampos(lista, CAMPOS);

  u.subtitulo('chaves que a API devolveu (comparar com docs/03)');
  console.log([...u.todasAsChaves(lista[0])].sort().join('\n'));

  relatorioTelefones(lista);
  relatorioDatas(lista);
}

function relatorioTelefones(lista) {
  u.subtitulo('telefone -> E.164 (o que a Meta exige)');

  const motivos = new Map();
  let validos = 0;

  for (const ag of lista) {
    const r = telefone.doPaciente(ag.Paciente || {});
    if (r.ok) validos += 1;
    else motivos.set(r.motivo, (motivos.get(r.motivo) || 0) + 1);
  }

  console.log(`válidos:   ${validos}/${lista.length}`);
  console.log(`inválidos: ${lista.length - validos}`);
  for (const [motivo, qtd] of [...motivos].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(qtd).padStart(4)}  ${motivo}`);
  }

  const exemplo = lista.find((ag) => telefone.doPaciente(ag.Paciente || {}).ok);
  if (exemplo) {
    const r = telefone.doPaciente(exemplo.Paciente);
    console.log(`\nexemplo montado: ${u.bruto ? r.numero : `${r.numero.slice(0, 5)}****${r.numero.slice(-2)}`}`);
  } else {
    console.log(
      '\nATENÇÃO: nenhum telefone válido na amostra. Em homologação isso é comum\n' +
        '(base de teste sem telefone). Repetir a checagem em produção antes do go-live.',
    );
  }
}

function relatorioDatas(lista) {
  u.subtitulo('leitura de data/hora — nossa interpretação x dataHoraUTC da API');
  console.log('Se as duas colunas divergirem, a regra em lib/datas.js precisa mudar.\n');

  let divergentes = 0;

  for (const ag of lista.slice(0, 10)) {
    const nossa = datas.deDataHoraClinicweb(ag);
    const daApi = ag.dataHoraUTC ? DateTime.fromISO(ag.dataHoraUTC).setZone(datas.FUSO) : null;
    const bate = nossa && daApi ? nossa.toMillis() === daApi.toMillis() : null;
    if (bate === false) divergentes += 1;

    console.log(
      `  cod=${String(ag.codAgendamento).padEnd(8)} data=${String(ag.data).slice(0, 10)} hora=${String(ag.hora || '').padEnd(9)}` +
        ` nossa=${nossa ? nossa.toFormat('dd/MM HH:mm') : '—'}` +
        ` api(dataHoraUTC->SP)=${daApi ? daApi.toFormat('dd/MM HH:mm') : '—'}` +
        ` ${bate === null ? '' : bate ? '✔' : '✖ DIVERGE'}`,
    );
  }

  if (divergentes > 0) {
    console.log(
      `\n>> ${divergentes} divergência(s). Provável causa: a clínica está em outro fuso\n` +
        '   ou `dataHoraUTC` já vem convertido. Registrar em docs/03 e ajustar lib/datas.js.',
    );
  } else {
    console.log('\n>> Nenhuma divergência na amostra: a regra de fuso em lib/datas.js está de pé.');
  }
}

async function principal() {
  u.titulo('ClinicWeb — descoberta de agendamentos');
  console.log(`ambiente: ${config.clinicweb.ambiente} | codEmpresa: ${config.clinicweb.codEmpresa}`);

  await listarStatus();
  await listarAgenda();
}

principal().then(() => u.encerrar()).catch(u.encerrar);
