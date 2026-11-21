'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { paraE164, doPaciente } = require('../src/lib/telefone');

test('celular completo vira E.164', () => {
  const r = paraE164({ ddi: '55', ddd: '11', tel: '999998888' });
  assert.deepEqual(r, { ok: true, numero: '5511999998888', motivo: null });
});

test('assume o DDI padrão quando o cadastro não traz', () => {
  const r = paraE164({ ddd: '11', tel: '987654321' });
  assert.equal(r.numero, '5511987654321');
});

test('aceita máscara e separadores no cadastro', () => {
  const r = paraE164({ ddd: '(11)', tel: '99999-8888' });
  assert.equal(r.numero, '5511999998888');
});

test('separa DDD quando o cadastro jogou tudo no campo do telefone', () => {
  const r = paraE164({ tel: '11987654321' });
  assert.equal(r.ok, true);
  assert.equal(r.numero, '5511987654321');
});

test('8 dígitos não é enviado — pode ser fixo ou celular antigo', () => {
  const r = paraE164({ ddd: '11', tel: '33336996' });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'oito_digitos_fixo_ou_celular_antigo');
  assert.equal(r.sugestao, '5511933336996'); // sugestão para conferência humana
});

test('celular sem o 9 na frente é recusado', () => {
  const r = paraE164({ ddd: '11', tel: '812345678' });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /tamanho_invalido|ddd_invalido/);
});

test('telefone vazio ou ausente é recusado sem erro', () => {
  assert.equal(paraE164({ ddd: '11', tel: '' }).motivo, 'telefone_vazio');
  assert.equal(paraE164({}).motivo, 'telefone_vazio');
  assert.equal(paraE164(null).motivo, 'telefone_vazio');
});

test('DDD ausente ou inválido é recusado', () => {
  assert.equal(paraE164({ tel: '99998888' }).motivo, 'ddd_ausente');
  assert.match(paraE164({ ddd: '09', tel: '999998888' }).motivo, /ddd_invalido/);
});

test('DDI estrangeiro passa pela validação de tamanho', () => {
  const r = paraE164({ ddi: '351', ddd: '21', tel: '1234567' });
  assert.equal(r.ok, true);
  assert.equal(r.numero, '351211234567');
});

test('doPaciente lê os campos do objeto Paciente da ClinicWeb', () => {
  const paciente = { nome: 'TESTE PACIENTE', dddCelular: '11', telCelular: '987654321' };
  assert.equal(doPaciente(paciente).numero, '5511987654321');
});

test('doPaciente não estoura com paciente sem telefone', () => {
  assert.equal(doPaciente({ nome: 'MARIA', dddCelular: '', telCelular: '' }).ok, false);
  assert.equal(doPaciente({}).ok, false);
});
