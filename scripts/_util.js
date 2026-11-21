'use strict';

/**
 * Utilidades dos scripts de descoberta (Fase 1).
 *
 * Cuidado LGPD: por padrão os scripts MASCARAM nome, CPF, e-mail e telefone.
 * Use `--bruto` quando precisar ver o payload literal (e não cole essa saída
 * em ticket, chat ou issue).
 */

const CHAVES_PII = /^(nome|nomeSocial|cpf|email|dddCelular|telCelular|ddiCelular|dddResidencial|telResidencial|logradouro|numero|bairro|cep|obs|observacoes|registroHospitalar)$/i;

const argumentos = process.argv.slice(2);

/** `--bruto` desliga o mascaramento. */
const bruto = argumentos.includes('--bruto');

/** Lê `--chave valor` da linha de comando. */
function opcao(nome, padrao = undefined) {
  const i = argumentos.indexOf(`--${nome}`);
  if (i === -1 || i === argumentos.length - 1) return padrao;
  return argumentos[i + 1];
}

function opcaoInteiro(nome, padrao) {
  const v = opcao(nome);
  if (v === undefined) return padrao;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? padrao : n;
}

function mascararValor(valor) {
  const s = String(valor ?? '');
  if (s === '' || s === 'null') return s;
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}${'*'.repeat(Math.max(2, s.length - 4))}${s.slice(-2)}`;
}

/** Mascara recursivamente os campos de PII, preservando a ESTRUTURA. */
function mascarar(valor) {
  if (bruto) return valor;
  if (Array.isArray(valor)) return valor.map(mascarar);
  if (valor && typeof valor === 'object') {
    const saida = {};
    for (const [chave, v] of Object.entries(valor)) {
      saida[chave] = CHAVES_PII.test(chave) && v !== null ? mascararValor(v) : mascarar(v);
    }
    return saida;
  }
  return valor;
}

function titulo(texto) {
  console.log(`\n${'='.repeat(72)}\n${texto}\n${'='.repeat(72)}`);
}

function subtitulo(texto) {
  console.log(`\n--- ${texto} ---`);
}

function json(valor) {
  console.log(JSON.stringify(mascarar(valor), null, 2));
}

/** Caminho "a.b.c" dentro de um objeto. */
function valorEm(obj, caminho) {
  return caminho.split('.').reduce((atual, parte) => (atual == null ? undefined : atual[parte]), obj);
}

/**
 * Relatório de preenchimento: para cada caminho, quantos itens vieram com
 * valor útil (não undefined, não null, não string vazia).
 *
 * É a entrega principal da Fase 1 — mostra o que a API REALMENTE devolve.
 */
function relatorioCampos(itens, caminhos) {
  const total = itens.length;
  console.log(`\ncampo${' '.repeat(30)}preenchidos  exemplo`);
  console.log('-'.repeat(72));

  for (const caminho of caminhos) {
    const valores = itens.map((i) => valorEm(i, caminho));
    const preenchidos = valores.filter((v) => v !== undefined && v !== null && v !== '');
    const exemplo = preenchidos.length > 0 ? mascararValor(preenchidos[0]) : '—';
    const rotulo = caminho.padEnd(34).slice(0, 34);
    console.log(`${rotulo} ${String(preenchidos.length).padStart(4)}/${String(total).padEnd(6)} ${exemplo}`);
  }
}

/** Procura, em todas as chaves, algo que pareça consentimento/opt-in. */
function chavesSuspeitasDeOptIn(obj, prefixo = '', achados = new Set()) {
  const padrao = /sms|email_?ok|aceit|consent|permite|autoriz|whats|contato|marketing|opt/i;
  if (!obj || typeof obj !== 'object') return achados;

  for (const [chave, valor] of Object.entries(obj)) {
    const caminho = prefixo ? `${prefixo}.${chave}` : chave;
    if (padrao.test(chave)) achados.add(`${caminho} = ${JSON.stringify(valor)}`);
    if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
      chavesSuspeitasDeOptIn(valor, caminho, achados);
    }
  }
  return achados;
}

/** Lista plana de todas as chaves de um objeto (para conferir com o doc 03). */
function todasAsChaves(obj, prefixo = '', saida = new Set()) {
  if (!obj || typeof obj !== 'object') return saida;
  for (const [chave, valor] of Object.entries(obj)) {
    const caminho = prefixo ? `${prefixo}.${chave}` : chave;
    saida.add(caminho);
    if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
      todasAsChaves(valor, caminho, saida);
    }
  }
  return saida;
}

/** Encerramento padronizado: erro vira mensagem legível + exit 1. */
function encerrar(erro) {
  if (!erro) {
    console.log('\nOK — script concluído.\n');
    process.exit(0);
  }
  console.error(`\nFALHOU: ${erro.message}`);
  if (erro.status) console.error(`HTTP ${erro.status}`);
  const corpo = erro.original?.response?.data;
  if (corpo) console.error(`corpo: ${JSON.stringify(corpo).slice(0, 500)}`);
  process.exit(1);
}

module.exports = {
  bruto,
  opcao,
  opcaoInteiro,
  titulo,
  subtitulo,
  json,
  mascarar,
  mascararValor,
  relatorioCampos,
  chavesSuspeitasDeOptIn,
  todasAsChaves,
  encerrar,
  valorEm,
};
