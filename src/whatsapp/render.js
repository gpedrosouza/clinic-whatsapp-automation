'use strict';

/**
 * Renderizador de mensagem (v2).
 *
 * PROBLEMA QUE ESTE MÓDULO RESOLVE
 * --------------------------------
 * Em produção, o texto das mensagens NÃO vive no nosso código: quem guarda o
 * texto aprovado é a Meta. O `whatsapp/templates.js` só monta o VETOR de
 * parâmetros ({{1}}..{{n}}) na ordem certa; a Meta encaixa esses valores no
 * template aprovado e entrega ao paciente.
 *
 * Para a demonstração presencial (templates ainda não aprovados) precisamos
 * mostrar, na tela, EXATAMENTE o texto que o paciente veria. Este módulo faz
 * essa reconstrução localmente: pega os mesmos parâmetros de `templates.js` e
 * os encaixa nos textos-rascunho de `docs/08-templates-whatsapp.md`.
 *
 * ⚠️ Importante: estes textos são uma CÓPIA dos rascunhos de docs/08, mantida
 * aqui só para a simulação. A fonte de verdade continua sendo o template
 * aprovado na Meta. Se o texto mudar lá, atualize os moldes abaixo junto.
 */

const templates = require('./templates');

/**
 * Moldes de texto, espelhando docs/08. `{{n}}` é substituído pelo parâmetro
 * de mesma posição (1-based) devolvido por `templates.*`.
 */
const MOLDES = {
  agendamento: {
    titulo: 'Agendamento realizado',
    corpo:
      'Olá, {{1}}! Seu agendamento com {{2}} na {{3}} foi realizado ' +
      'para o dia {{4}} às {{5}}. Estamos à sua espera!',
    rodape: '',
    botoes: [],
  },
  confirmacao: {
    titulo: 'Confirmação de presença',
    corpo:
      'Olá, {{1}}! Você tem um agendamento com {{2}} na {{3}}, ' +
      'no dia {{4}} às {{5}}.\n\nPodemos confirmar a sua presença?',
    rodape: '',
    botoes: ['Confirmar presença', 'Preciso remarcar'],
  },
  lembrete: {
    titulo: 'Lembrete da sua consulta',
    corpo:
      'Oi, {{1}}! Passando para lembrar do seu agendamento com {{2}} ' +
      'na {{3}}, amanhã {{4}} às {{5}}.\nEndereço: {{6}}.\nRecomendações: {{7}}\n\n' +
      'Contamos com a sua presença!',
    rodape: '',
    botoes: [],
  },
};

/** Substitui {{1}}, {{2}}... pelos valores posicionais de `parametros`. */
function interpolar(texto, parametros) {
  return String(texto).replace(/\{\{(\d+)\}\}/g, (_, n) => {
    const valor = parametros[Number(n) - 1];
    return valor === undefined || valor === null ? '' : String(valor);
  });
}

/**
 * Renderiza uma mensagem a partir de um molde + parâmetros já na ordem certa.
 *
 * @param {'agendamento'|'confirmacao'|'lembrete'} chaveMolde
 * @param {{nomeTemplate?: string, tipo?: string, parametros: string[]}} mensagem
 * @returns {{titulo: string, corpo: string, rodape: string, botoes: string[],
 *            nomeTemplate: string|null, tipo: string, parametros: string[]}}
 */
function renderizar(chaveMolde, mensagem) {
  const molde = MOLDES[chaveMolde];
  if (!molde) throw new Error(`render: molde desconhecido "${chaveMolde}"`);

  const p = mensagem.parametros || [];
  return {
    titulo: molde.titulo,
    corpo: interpolar(molde.corpo, p),
    rodape: interpolar(molde.rodape, p),
    botoes: [...molde.botoes],
    nomeTemplate: mensagem.nomeTemplate || null,
    tipo: mensagem.tipo || chaveMolde,
    parametros: p,
  };
}

/** Aviso de agendamento realizado, já renderizado. */
function agendamentoRealizado(agendamento) {
  return renderizar('agendamento', templates.agendamentoRealizado(agendamento));
}

/** Pedido de confirmação de presença, já renderizado. */
function confirmacao(agendamento) {
  return renderizar('confirmacao', templates.confirmacao(agendamento));
}

/** Lembrete/pedido de confirmação de comparecimento, já renderizado. */
function lembrete(agendamento, horasAntes) {
  return renderizar('lembrete', templates.lembrete(agendamento, horasAntes));
}

/**
 * Desenha a mensagem como uma "bolha" de WhatsApp para o terminal — é o que
 * será mostrado à clínica na demonstração.
 *
 * @param {ReturnType<typeof renderizar>} m
 * @returns {string}
 */
function paraTerminal(m) {
  const largura = 58;
  const linha = (txt) => `│ ${String(txt).padEnd(largura)} │`;
  const separador = `├${'─'.repeat(largura + 2)}┤`;
  const borda = (c) => `${c === 'top' ? '┌' : '└'}${'─'.repeat(largura + 2)}${c === 'top' ? '┐' : '┘'}`;

  // Quebra parágrafos em linhas que cabem na largura da bolha.
  const embrulhar = (texto) => {
    const saida = [];
    for (const paragrafo of String(texto).split('\n')) {
      if (paragrafo === '') {
        saida.push('');
        continue;
      }
      let atual = '';
      for (const palavra of paragrafo.split(' ')) {
        if ((atual + ' ' + palavra).trim().length > largura) {
          saida.push(atual.trim());
          atual = palavra;
        } else {
          atual = `${atual} ${palavra}`.trim();
        }
      }
      if (atual) saida.push(atual);
    }
    return saida;
  };

  const partes = [];
  partes.push(borda('top'));
  partes.push(linha(`*${m.titulo}*`));
  partes.push(separador);
  for (const l of embrulhar(m.corpo)) partes.push(linha(l));
  partes.push(separador);
  for (const l of embrulhar(m.rodape)) partes.push(linha(l));
  if (m.botoes.length) {
    partes.push(separador);
    for (const b of m.botoes) partes.push(linha(`[ ${b} ]`));
  }
  partes.push(borda('bottom'));

  return partes.join('\n');
}

/** Versão texto puro (para salvar em arquivo ou colar em documento). */
function paraTextoPuro(m) {
  const linhas = [m.titulo, '', m.corpo, '', m.rodape];
  if (m.botoes.length) {
    linhas.push('', `Botões: ${m.botoes.map((b) => `[${b}]`).join('  ')}`);
  }
  return linhas.join('\n');
}

module.exports = {
  MOLDES,
  interpolar,
  renderizar,
  agendamentoRealizado,
  confirmacao,
  lembrete,
  paraTerminal,
  paraTextoPuro,
};
