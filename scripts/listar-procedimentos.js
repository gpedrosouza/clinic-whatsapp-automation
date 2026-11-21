'use strict';

/**
 * SONDA SÓ-LEITURA — nomes de procedimento na agenda.
 *
 * Lista, para os agendamentos dos próximos N dias, os campos que podem trazer
 * o nome do procedimento/grupo/especialidade, com contagem por valor. Serve
 * para descobrir em qual campo aparecem "toxina", "botox", "laser fracionado"
 * e "ultraformer" (recomendação específica do lembrete de véspera).
 *
 * NÃO envia nada e NÃO escreve na ClinicWeb. Ignora os dados do paciente.
 *
 * USO (Console do Railway): node scripts/listar-procedimentos.js [dias]
 */

const agendamentos = require('../src/clinicweb/agendamentos');

const DIAS = Number.parseInt(process.argv[2] || '30', 10);
const CHAVE = /proced|grupo|especial|servi|descri|exame|tipo/i;
const IGNORAR = /^(Paciente|paciente)$/;

function coletar(obj, caminho, saida) {
  if (obj === null || obj === undefined) return;
  if (Array.isArray(obj)) {
    obj.forEach((item) => coletar(item, `${caminho}[]`, saida));
    return;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (IGNORAR.test(k)) continue;
      coletar(v, caminho ? `${caminho}.${k}` : k, saida);
    }
    return;
  }
  const ultimo = caminho.split('.').pop();
  if (typeof obj === 'string' && CHAVE.test(caminho) && obj.trim() && /[a-zA-Z]/.test(obj)) {
    const chave = `${caminho} = ${obj.trim()}`;
    saida.set(chave, (saida.get(chave) || 0) + 1);
  } else if (typeof obj === 'number' && /^cod/i.test(ultimo) && CHAVE.test(caminho)) {
    const chave = `${caminho} = ${obj}`;
    saida.set(chave, (saida.get(chave) || 0) + 1);
  }
}

function ehObjeto(v) {
  return v === Object(v);
}

function estrutura(obj, prefixo, saida) {
  if (ehObjeto(obj) === false) return;
  const alvo = Array.isArray(obj) ? obj[0] : obj;
  if (ehObjeto(alvo) === false) return;
  for (const [k, v] of Object.entries(alvo)) {
    if (IGNORAR.test(k)) continue;
    const p = prefixo ? `${prefixo}.${k}` : k;
    saida.add(p);
    estrutura(v, p, saida);
  }
}

async function principal() {
  const lista = await agendamentos.listarProximos(DIAS);
  console.log(`Agendamentos nos próximos ${DIAS} dias: ${lista.length}`);

  const campos = new Set();
  lista.slice(0, 20).forEach((ag) => estrutura(ag, '', campos));
  console.log('\n--- Campos disponíveis (sem dados do paciente) ---');
  console.log([...campos].sort().join('\n'));

  const valores = new Map();
  lista.forEach((ag) => coletar(ag, '', valores));
  console.log('\n--- Valores de procedimento/grupo/especialidade (contagem) ---');
  [...valores.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([k, n]) => console.log(`${String(n).padStart(4)}  ${k}`));

  const alvo = /toxin|botox|laser|fracion|ultraformer|ultra former/i;
  const achados = [...valores.keys()].filter((k) => alvo.test(k));
  console.log('\n--- Ocorrências de toxina/botox/laser/ultraformer ---');
  console.log(achados.length ? achados.join('\n') : '(nenhuma nesta janela — tente mais dias)');
}

principal().catch((e) => {
  console.error('ERRO:', e.message);
  process.exitCode = 1;
});
