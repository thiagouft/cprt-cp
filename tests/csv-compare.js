/* Confere um CSV exportado do sistema ("Exportar tudo") com o motor do Painel.
 *   node tests/csv-compare.js controle-aco-2026-11-09.csv
 * Mostra os totais do Painel e aponta problemas de dados (acentos corrompidos, pátios duplicados). */
'use strict';
const fs = require('fs');
const PC = require('../public/painel-calc.js');
const arq = process.argv[2] || 'controle-aco-2026-11-09.csv';
let txt = fs.readFileSync(arq, 'utf8').replace(/^﻿/, '');
function parse(t) { // CSV com ; e aspas
  const out = []; let row = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ';') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur.replace(/\r$/, '')); out.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); out.push(row); }
  return out.filter(r => r.length > 1);
}
const T = parse(txt), H = T[0], rows = T.slice(1), ix = n => H.indexOf(n);
const br = s => { s = String(s || '').trim(); return s === '' ? '' : parseFloat(s.replace(/\./g, '').replace(',', '.')); };
const regs = rows.map(r => {
  const g = n => r[ix(n)] || '', [d, m, y] = g('Data').split('/').map(Number), [h, mi] = g('Hora').split(':').map(Number);
  const prod = { 'Aço pronto': 'aco', 'Barra reta': 'barra', 'Cordoalha': 'cord' }[g('Produto')] || 'aco';
  return { id: g('Protocolo') + '|' + g('Data') + g('Hora') + g('Peso (kg)'), protocolo: g('Protocolo'), op: g('Operação') === 'Retirada' ? 'ret' : 'mob', at: new Date(y, m - 1, d, h, mi).toISOString(),
    controlador: g('Controlador'), patio: g('Pátio'), prod, os: g('OS / Ordem de produção'), ordem: g('OS / Ordem de produção'), cpt: g('CPT/CPM/DF'), desenho: g('Desenho'), posicao: g('Posição'), cj: g('CJ'),
    elemento: g('Elemento'), bitola: br(g('Bitola / Diâmetro (mm)')), comp: br(g('Comp. (cm)')), qtd: br(g('Barras')), m: br(g('Metros / Metragem')), kg: br(g('Peso (kg)')),
    placa: g('Placa'), motorista: g('Motorista'), empresa: g('Empresa'), destino: g('Nome da Rua') || g('Destino'), obs: g('Observações') };
});
const L = PC.normalizar(regs), P = PC.painel(L, {}), A = PC.acoPronto(L, {});
const f = (n, d = 2) => n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
console.log('Arquivo:', arq, '|', regs.length, 'registros |', P.janela.iniTxt, 'a', P.janela.fimTxt);
console.log('PAINEL  registros', P.kpis.registros, '| entradas', P.kpis.entradas, f(P.kpis.pesoEntT) + ' t | retiradas', P.kpis.retiradas, f(P.kpis.pesoRetT) + ' t | peso', f(P.kpis.pesoT) + ' t | barras', f(P.kpis.barras, 0), '| saldo', f(P.kpis.saldoT) + ' t');
console.log('AÇO PRONTO  etiquetas', A.kpis.etiquetas, '|', f(A.kpis.pesoT) + ' t | desenhos', A.kpis.desenhos, '| posições', A.kpis.posicoes, '| OS', A.kpis.os, '| saldo', f(A.kpis.saldoT) + ' t');
const cont = (arr, k) => arr.reduce((m, x) => (m[x[k]] = (m[x[k]] || 0) + 1, m), {});
console.log('\nPátios na base:', JSON.stringify(cont(L, 'patio')));
console.log('Pátios no Painel (peso t):', P.porPatio.map(p => p.patio + ' ' + f(p.t)).join(' | '));
const ruim = c => rows.filter(r => /\?\?/.test(r[ix(c)])).length;
console.log('\nLinhas com "??" (acento perdido):', ['Pátio', 'Controlador', 'Nome da Rua', 'Empresa', 'Observações', 'Elemento'].map(c => c + ' ' + ruim(c)).join(' | '));
if (ruim('Pátio')) console.log('⚠ Os acentos foram perdidos ao gravar/importar: "São Félix" virou "S??o F??lix". Corrija a origem (UTF-8) e reimporte.');
