'use strict';

/**
 * Valida SÓ o acesso: POST /auth/login no ambiente configurado.
 *
 *   npm run testar:login
 *
 * Não imprime o token (só tamanho e validade).
 */

const { config } = require('../src/config');
const auth = require('../src/clinicweb/auth');
const datas = require('../src/lib/datas');
const u = require('./_util');

async function principal() {
  u.titulo('ClinicWeb — teste de login');

  console.log(`ambiente:   ${config.clinicweb.ambiente}`);
  console.log(`baseUrl:    ${config.clinicweb.baseUrl}`);
  console.log(`usuario:    ${config.clinicweb.usuario ? 'definido' : 'AUSENTE'}`);
  console.log(`senha:      ${config.clinicweb.senha ? 'definida' : 'AUSENTE'}`);
  console.log(`otp:        ${config.clinicweb.otp ? 'definido' : 'não usado'}`);
  console.log(`codEmpresa: ${config.clinicweb.codEmpresa || 'AUSENTE'}`);
  console.log(`fuso:       ${datas.FUSO} (agora: ${datas.agora().toFormat('dd/MM/yyyy HH:mm')})`);

  const token = await auth.login();

  u.subtitulo('resultado');
  console.log(`token recebido: sim (${token.length} caracteres)`);

  const partes = token.split('.');
  if (partes.length === 3) {
    const payload = JSON.parse(Buffer.from(partes[1], 'base64').toString('utf8'));
    console.log(`claims presentes: ${Object.keys(payload).join(', ')}`);
    if (payload.exp) {
      const expira = datas.agora().plus({ seconds: payload.exp - Math.floor(Date.now() / 1000) });
      console.log(`expira em: ${expira.toFormat('dd/MM/yyyy HH:mm')} (${Math.round((payload.exp * 1000 - Date.now()) / 60000)} min)`);
    } else {
      console.log('ATENÇÃO: o JWT não traz "exp" — a renovação usará a validade padrão de 30 min.');
    }
  }
}

principal().then(() => u.encerrar()).catch(u.encerrar);
