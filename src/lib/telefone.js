'use strict';

/**
 * Montagem e validação do telefone no formato E.164 exigido pela Meta.
 *
 * A ClinicWeb guarda o telefone em partes: `ddiCelular` (às vezes ausente),
 * `dddCelular` e `telCelular`. A Meta Cloud API quer um número único, só
 * dígitos, com código do país: 5511999998888.
 *
 * Esta função NUNCA "corrige" um número por conta própria — se algo está
 * fora do padrão ela devolve ok=false com o motivo. Enviar mensagem para um
 * número adivinhado é pior do que não enviar.
 */

const { config } = require('../config');

const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');

/**
 * @param {{ddi?: string|number, ddd?: string|number, tel?: string|number}} partes
 * @param {{ddiPadrao?: string}} [opcoes]
 * @returns {{ok: boolean, numero: string|null, motivo: string|null, sugestao?: string}}
 */
function paraE164(partes, opcoes = {}) {
  const ddiPadrao = soDigitos(opcoes.ddiPadrao ?? config.whatsapp.ddiPadrao) || '55';

  const ddi = soDigitos(partes?.ddi) || ddiPadrao;
  let ddd = soDigitos(partes?.ddd);
  let tel = soDigitos(partes?.tel);

  if (!tel) {
    return { ok: false, numero: null, motivo: 'telefone_vazio' };
  }

  // Cadastro que jogou tudo no campo do telefone (ex.: "11987654321").
  if (!ddd && (tel.length === 10 || tel.length === 11)) {
    ddd = tel.slice(0, 2);
    tel = tel.slice(2);
  }

  if (!ddd) {
    return { ok: false, numero: null, motivo: 'ddd_ausente' };
  }
  if (ddd.length !== 2 || Number.parseInt(ddd, 10) < 11) {
    return { ok: false, numero: null, motivo: `ddd_invalido:${ddd}` };
  }

  // Regras específicas do Brasil. Outros DDIs passam com validação de tamanho.
  if (ddi === '55') {
    if (tel.length === 9 && tel.startsWith('9')) {
      return { ok: true, numero: `${ddi}${ddd}${tel}`, motivo: null };
    }
    if (tel.length === 8) {
      // Pode ser fixo (não recebe WhatsApp) ou celular antigo sem o 9º dígito.
      // Não assumimos: devolvemos a sugestão para conferência humana.
      return {
        ok: false,
        numero: null,
        motivo: 'oito_digitos_fixo_ou_celular_antigo',
        sugestao: `${ddi}${ddd}9${tel}`,
      };
    }
    return { ok: false, numero: null, motivo: `tamanho_invalido:${tel.length}` };
  }

  const completo = `${ddi}${ddd}${tel}`;
  if (completo.length < 10 || completo.length > 15) {
    return { ok: false, numero: null, motivo: `e164_tamanho_invalido:${completo.length}` };
  }
  return { ok: true, numero: completo, motivo: null };
}

/** Atalho para os objetos Paciente devolvidos pela API ClinicWeb. */
function doPaciente(paciente) {
  return paraE164({
    ddi: paciente?.ddiCelular,
    ddd: paciente?.dddCelular,
    tel: paciente?.telCelular,
  });
}

module.exports = { paraE164, doPaciente, soDigitos };
