'use strict';

/**
 * Descoberta da Fase 1 — pacientes (base da campanha de aniversário).
 *
 *   npm run testar:pacientes
 *   node scripts/testar-pacientes.js --dia 10 --mes 6
 *   node scripts/testar-pacientes.js --query maria
 *   node scripts/testar-pacientes.js --bruto
 *
 * Responde às lacunas de docs/03:
 *  - `query` é realmente obrigatório? (se for, filtrar SÓ por aniversário não
 *    funciona e a campanha precisa de outra estratégia);
 *  - o filtro diaAniversario/mesAniversario funciona e retorna quem deveria;
 *  - a listagem traz telefone utilizável?
 *  - existe QUALQUER campo de opt-in/consentimento na API?
 */

const pacientes = require('../src/clinicweb/pacientes');
const telefone = require('../src/lib/telefone');
const datas = require('../src/lib/datas');
const { config } = require('../src/config');
const u = require('./_util');

const CAMPOS = [
  'idUsuario',
  'idPaciente',
  'nome',
  'dataNascimento',
  'sexo',
  'cpf',
  'email',
  'ativo',
  'vivo',
  'statusCod',
  'statusDesc',
  'ddiCelular',
  'dddCelular',
  'telCelular',
  'dddResidencial',
  'telResidencial',
];

/**
 * Executa um cenário e reporta sucesso/erro sem derrubar o script — a graça
 * daqui é justamente descobrir QUAIS combinações de filtro a API aceita.
 * Falhas são acumuladas para o script terminar com exit != 0 se nada passar.
 */
const falhas = [];

async function cenario(nome, fn) {
  u.subtitulo(nome);
  try {
    const resultado = await fn();
    return { ok: true, resultado };
  } catch (erro) {
    console.log(`ERRO: ${erro.message}`);
    const corpo = erro.original?.response?.data;
    if (corpo) console.log(`corpo: ${JSON.stringify(corpo).slice(0, 300)}`);
    falhas.push({ nome, erro });
    return { ok: false, erro };
  }
}

function relatorioTelefones(lista) {
  const motivos = new Map();
  let validos = 0;

  for (const p of lista) {
    const r = telefone.doPaciente(p);
    if (r.ok) validos += 1;
    else motivos.set(r.motivo, (motivos.get(r.motivo) || 0) + 1);
  }

  console.log(`\ntelefone -> E.164: ${validos}/${lista.length} válidos`);
  for (const [motivo, qtd] of [...motivos].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(qtd).padStart(4)}  ${motivo}`);
  }
}

async function principal() {
  u.titulo('ClinicWeb — descoberta de pacientes');
  console.log(`ambiente: ${config.clinicweb.ambiente} | codEmpresa: ${config.clinicweb.codEmpresa}`);

  const hoje = datas.agora();
  const dia = u.opcaoInteiro('dia', hoje.day);
  const mes = u.opcaoInteiro('mes', hoje.month);
  const termo = u.opcao('query', 'a');

  // Cenário 1 — o que a campanha de aniversário PRECISA: filtrar só por data.
  const soAniversario = await cenario(
    `1) GET /pacientes com SÓ diaAniversario=${dia} & mesAniversario=${mes} (sem query)`,
    () => pacientes.listar({ diaAniversario: dia, mesAniversario: mes, limit: 50 }),
  );
  if (soAniversario.ok) {
    console.log(`>> FUNCIONA sem "query": ${soAniversario.resultado.length} paciente(s).`);
    console.log('   A campanha de aniversário pode usar o filtro direto.');
  } else {
    console.log('>> NÃO funciona sem "query". A campanha de aniversário precisa de plano B');
    console.log('   (ex.: varrer a base paginando e filtrar dataNascimento localmente).');
    console.log('   REGISTRAR ISSO em docs/03 — muda a Fase 2b.');
  }

  // Cenário 2 — aniversário + query (combinação documentada).
  const comQuery = await cenario(
    `2) GET /pacientes com query="${termo}" + diaAniversario=${dia} & mesAniversario=${mes}`,
    () => pacientes.listar({ query: termo, diaAniversario: dia, mesAniversario: mes, limit: 50 }),
  );
  if (comQuery.ok) console.log(`>> ${comQuery.resultado.length} paciente(s).`);

  // Cenário 3 — busca simples, só para ver a forma do registro.
  const simples = await cenario(`3) GET /pacientes com query="${termo}" (forma do registro)`, () =>
    pacientes.listar({ query: termo, limit: 20 }),
  );

  const amostra = [
    ...(soAniversario.ok ? soAniversario.resultado : []),
    ...(comQuery.ok ? comQuery.resultado : []),
    ...(simples.ok ? simples.resultado : []),
  ];

  if (amostra.length === 0) {
    console.log('\nNenhum paciente retornado em nenhum cenário — nada a analisar.');
    console.log('Tente outro --query, ou confirme se o codEmpresa tem base em homologação.');

    // Se TODOS os cenários deram erro, o problema é de acesso, não de base vazia.
    if (falhas.length === 3) {
      throw falhas[0].erro;
    }
    return;
  }

  u.subtitulo('primeiro paciente (payload)');
  u.json(amostra[0]);
  if (!u.bruto) console.log('\n(PII mascarada — rode com --bruto para ver os valores literais)');

  u.subtitulo('preenchimento dos campos');
  u.relatorioCampos(amostra, CAMPOS);
  relatorioTelefones(amostra);

  u.subtitulo('chaves devolvidas pela listagem');
  console.log([...u.todasAsChaves(amostra[0])].sort().join('\n'));

  // Cenário 4 — detalhe: é a única rota que documenta ddiCelular.
  const id = amostra[0].idPaciente ?? amostra[0].idUsuario;
  const detalhe = await cenario(`4) GET /pacientes/busca?idPaciente=${id} (detalhe cadastral)`, () =>
    pacientes.buscar(id),
  );

  if (detalhe.ok && detalhe.resultado) {
    const d = detalhe.resultado;
    console.log(`ddiCelular presente: ${d.ddiCelular ? `sim ("${d.ddiCelular}")` : 'não'}`);
    console.log(`dddCelular presente: ${d.dddCelular ? 'sim' : 'não'}`);
    console.log(`telCelular presente: ${d.telCelular ? 'sim' : 'não'}`);
    u.subtitulo('chaves do detalhe');
    console.log([...u.todasAsChaves(d)].sort().join('\n'));
  }

  // Cenário 5 — existe algum campo de consentimento?
  u.subtitulo('5) varredura por campo de opt-in / consentimento');
  const achados = new Set();
  for (const p of amostra.slice(0, 5)) u.chavesSuspeitasDeOptIn(p, '', achados);
  if (detalhe.ok && detalhe.resultado) u.chavesSuspeitasDeOptIn(detalhe.resultado, 'busca', achados);

  if (achados.size === 0) {
    console.log('Nenhum campo parecido com opt-in/consentimento. CONFIRMA a decisão do');
    console.log('vault: o opt-in de Marketing (aniversário/retorno) é guardado LOCALMENTE');
    console.log('no SQLite, com base legal e data (docs/02, LGPD).');
  } else {
    console.log('Candidatos encontrados (avaliar se servem como opt-in):');
    for (const a of achados) console.log(`  - ${a}`);
  }
}

principal()
  .then(() => {
    if (falhas.length > 0) {
      u.subtitulo(`${falhas.length} cenário(s) falharam — registrar em docs/03`);
      for (const f of falhas) console.log(`  - ${f.nome}\n    ${f.erro.message}`);
    }
    u.encerrar();
  })
  .catch(u.encerrar);
