/* Valida public/painel-calc.js contra os valores calculados pelo Excel (Dash.xlsx).
 * 1) python -X utf8 tests/export_dash.py     (gera tests/fixtures/dash-golden.json)
 * 2) node tests/painel-calc.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const PC = require('../public/painel-calc.js');

const FIX = path.join(__dirname, 'fixtures', 'dash-golden.json');
if (!fs.existsSync(FIX)) { console.error('Fixture ausente. Rode: python -X utf8 tests/export_dash.py'); process.exit(2); }
const { header, rows, golden: G } = JSON.parse(fs.readFileSync(FIX, 'utf8'));

let falhas = 0, ok = 0;
function check(nome, cond, det) { if (cond) ok++; else { falhas++; console.log('  ✗ ' + nome + (det !== undefined ? ' → ' + det : '')); } }
function near(a, b, eps) { return Math.abs((+a || 0) - (+b || 0)) <= (eps || 1e-6); }
function eq(nome, a, b) { check(nome, typeof b === 'number' ? near(a, b) : String(a) === String(b), 'obtido=' + JSON.stringify(a) + ' esperado=' + JSON.stringify(b)); }
function secao(t) { console.log('\n' + t); }

/* ---- linhas do Excel -> registros do sistema ---- */
const ix = n => header.indexOf(n);
const dataHora = r => { const [y, m, d] = String(r[ix('Data')]).slice(0, 10).split('-').map(Number); const [h, mi] = String(r[ix('Hora')]).split(':').map(Number); return new Date(y, m - 1, d, h, mi); };
function paraRegistro(r) {
  const g = n => { const v = r[ix(n)]; return v == null ? '' : v; };
  const prod = { 'Aço pronto': 'aco', 'Barra reta': 'barra', 'Cordoalha': 'cord' }[g('Produto')];
  return {
    id: g('Protocolo'), protocolo: g('Protocolo'), op: g('Operação') === 'Retirada' ? 'ret' : 'mob', at: dataHora(r).toISOString(), controlador: g('Controlador'),
    patio: g('Pátio'), prod, os: g('OS / Ordem de produção'), cod: g('Código etiqueta / barras'), cpt: g('CPT/CPM/DF'), material: g('Material'), descricao: g('Descrição / Marca'),
    corrida: g('Corrida'), feixe: g('Feixe'), lote: g('Lote'), desenho: g('Desenho'), posicao: g('Posição'), cj: g('CJ'), elemento: g('Elemento'), bitola: g('Bitola / Diâmetro (mm)'),
    aco: g('Aço / Classe'), comp: g('Comp. (cm)'), qtd: g('Barras'), m: g('Metros / Metragem'), kg: g('Peso (kg)'), pbruto: g('Peso bruto (kg)'), torcao: g('Torção'),
    resist: g('Resistência'), norma: g('Norma'), datafab: g('Data fabricação'), re: g('RE'), placa: g('Placa'), motorista: g('Motorista'), empresa: g('Empresa'), cracha: g('Crachá'),
    destino: g('Destino'), autorizador: g('Autorizado/Solicitado por'), obs: g('Observações'), tem_nf: g('Nota Fiscal') === 'Sim'
  };
}
const registros = rows.map(paraRegistro);
const HOJE = new Date(2026, 10, 9, 12, 0); // data em que o Excel foi calculado (cache do =HOJE())
const dt = s => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return PC.diaDeChave(s.slice(0, 10)); };
const dtTxt = s => PC.fmtData(PC.diaDeChave(s.slice(0, 10)));
const dhTxt = s => dtTxt(s) + ' ' + (s.length > 10 ? s.slice(11, 16) : '00:00');

/* =============== 1) Paridade com a planilha (modo planilha) =============== */
PC.setModoPlanilha(true);
const L = PC.normalizar(registros);
check('400 linhas importadas', L.length === 400, L.length);

secao('Painel — filtros padrão');
const P = PC.painel(L, {}, HOJE);
const gp = G.painel, ind = gp.indicadores;
eq('data inicial', P.janela.ini, dt(gp.janela[0])); eq('data final', P.janela.fim, dt(gp.janela[1]));
eq('Registros', P.kpis.registros, ind['Registros']); eq('Entradas', P.kpis.entradas, ind['Entradas (qtd)']); eq('Retiradas', P.kpis.retiradas, ind['Retiradas (qtd)']);
eq('Peso total t', P.kpis.pesoT, ind['Peso total (t)']); eq('Peso entrada t', P.kpis.pesoEntT, ind['Peso entrada (t)']); eq('Peso retirada t', P.kpis.pesoRetT, ind['Peso retirada (t)']);
eq('Barras', P.kpis.barras, ind['Barras (unid.)']); eq('Metros', P.kpis.metros, ind['Metros']); eq('Placas distintas', P.kpis.placas, ind['Placas distintas']);
eq('Motoristas distintos', P.kpis.motoristas, ind['Motoristas distintos']); eq('Média kg/registro', P.kpis.mediaKg, ind['Média por registro (kg)']);
eq('Saldo = entradas − retiradas (t)', P.kpis.saldoT, ind['Peso entrada (t)'] - ind['Peso retirada (t)']);
gp.dias.forEach((d, i) => { eq('7 dias ' + dtTxt(d[0]) + ' retirada', P.serie[i].ret, d[1]); eq('7 dias ' + dtTxt(d[0]) + ' entrada', P.serie[i].ent, d[2]); check('7 dias data ' + i, P.serie[i].dia === dt(d[0])); });
gp.patios.forEach(p => { const o = P.porPatio.find(x => x.patio === p[0]); check('pátio ' + p[0], o && near(o.t, p[1]), JSON.stringify(o)); });
gp.bitolas.forEach((b, i) => {
  const o = i < 9 ? P.porBitola[i] : P.totalBitola; const tag = 'bitola ' + b[1];
  eq(tag + ' aço pronto t', o.produtos['Aço pronto'] || 0, b[2]); eq(tag + ' barra reta t', o.produtos['Barra reta'] || 0, b[3]);
  eq(tag + ' lotes', o.lotes, b[4] || 0); eq(tag + ' barras', o.barras, b[5] || 0); eq(tag + ' metros', o.metros, b[6] || 0); eq(tag + ' peso t', o.t, b[7] || 0);
});
check('sem bitolas extras além das 8 + Outras', P.porBitola.length === 9, P.porBitola.length);
gp.controladores.filter(c => c[0]).forEach((c, i) => { eq('controlador #' + (i + 1) + ' peso', P.porControlador[i].t, c[1]); if (c[0] !== 'Felipe da') eq('controlador #' + (i + 1) + ' nome', P.porControlador[i].rotulo, c[0]); });
eq('nome curto pula conector ("Felipe da silva…")', PC.nomeCurto('Felipe da silva da Conceição'), 'Felipe da silva');
gp.ultimos15.forEach((u, i) => {
  const o = P.ultimos[i], tag = 'último #' + (i + 1);
  eq(tag + ' operação', o.operacao, u[0]); eq(tag + ' placa', o.placa, u[1]); eq(tag + ' data', o.data, dtTxt(u[2])); eq(tag + ' hora', o.hora, u[3]); eq(tag + ' pátio', o.patio, u[4]);
  eq(tag + ' produto', o.produto, u[5]); eq(tag + ' bitola', o.bitola, u[6]); eq(tag + ' barras', o.barras, u[7]); eq(tag + ' kg', o.kg, u[8]); eq(tag + ' motorista', o.motorista, u[9]);
  eq(tag + ' controlador', o.controlador, u[10]); eq(tag + ' rua', o.rua, u[11]);
});

secao('Aço pronto — filtros padrão');
const A = PC.acoPronto(L, {}, HOJE), ga = G.aco, ai = ga.indicadores;
eq('data inicial', A.janela.ini, dt(ga.janela[0])); eq('data final', A.janela.fim, dt(ga.janela[1]));
eq('Etiquetas', A.kpis.etiquetas, ai['Etiquetas (registros)']); eq('Entradas', A.kpis.entradas, ai['Entradas']); eq('Retiradas', A.kpis.retiradas, ai['Retiradas']);
eq('Peso t', A.kpis.pesoT, ai['Peso (t)']); eq('Barras', A.kpis.barras, ai['Barras']); eq('Metros', A.kpis.metros, ai['Metros']);
eq('Desenhos', A.kpis.desenhos, ai['Desenhos distintos']); eq('Posições', A.kpis.posicoes, ai['Posições distintas (desenho+posição)']); eq('OS', A.kpis.os, ai['OS distintas']);
eq('CJ', A.kpis.cj, ai['Conjuntos (CJ) distintos']); eq('Elementos', A.kpis.elementos, ai['Elementos distintos']); eq('Média kg/etiqueta', A.kpis.mediaKg, ai['Peso médio por etiqueta (kg)']);
eq('Comp. médio ponderado', A.kpis.compMedio, ai['Comprimento médio ponderado (cm)']); eq('Maior elemento', A.kpis.maiorElemento, ai['Elemento de maior peso']);
ga.elementos.forEach((e, i) => { eq('elemento #' + (i + 1), A.topElementos[i].chave, e[0]); eq('elemento ' + e[0] + ' t', A.topElementos[i].t, e[1]); });
ga.desenhos.filter(d => d[0]).forEach((d, i) => { eq('desenho #' + (i + 1), A.topDesenhos[i].rotulo, d[0]); eq('desenho ' + d[0] + ' t', A.topDesenhos[i].t, d[1]); });
ga.bitolas.forEach((b, i) => { eq('bitola ' + b[1] + ' t', A.porBitola[i].t, b[2]); eq('bitola ' + b[1] + ' barras', A.porBitola[i].barras, b[3]); });
ga.dias.forEach((d, i) => { eq('7 dias AP ' + dtTxt(d[0]) + ' retirada', A.serie[i].ret, d[1]); eq('7 dias AP ' + dtTxt(d[0]) + ' entrada', A.serie[i].ent, d[2]); });
ga.matriz.slice(0, 8).forEach((m, i) => {
  eq('matriz elemento #' + (i + 1), A.matriz[i].elemento, m[0]);
  A.bitolas.forEach((b, j) => eq('matriz ' + m[0] + ' × ' + b, A.matriz[i].celulas[j], m[j + 1]));
  eq('matriz ' + m[0] + ' total', A.matriz[i].total, m[9]);
});
const mt = ga.matriz[8];
A.bitolas.forEach((b, j) => eq('matriz total × ' + b, A.matrizTotais[j], mt[j + 1])); eq('matriz total geral', A.matrizTotal, mt[9]);
ga.onde.forEach((o, i) => {
  const x = A.onde[i], tag = 'onde #' + (i + 1);
  eq(tag + ' operação', x.operacao, o[0]); eq(tag + ' pátio', x.patio, o[1]); eq(tag + ' local', x.local, o[2]); eq(tag + ' etiquetas', x.etiquetas, o[3]);
  // A planilha conta o desenho em branco como se fosse um desenho (UNIQUE inclui ""); aqui ele não conta.
  const doGrupo = rows.filter(r => r[ix('Produto')] === 'Aço pronto' && r[ix('Operação')] === o[0] && r[ix('Pátio')] === o[1] && L[rows.indexOf(r)].local === o[2]);
  const temBranco = doGrupo.some(r => !String(r[ix('Desenho')] || '').trim());
  eq(tag + ' desenhos (planilha conta o branco)', x.desenhos + (temBranco ? 1 : 0), o[4]);
  eq(tag + ' barras', x.barras, o[5]); eq(tag + ' t', x.t, o[6]); eq(tag + ' %', x.pct, o[7]); eq(tag + ' última', x.ultimaTxt, dhTxt(o[8]));
  check(tag + ' principais (começa igual à planilha)', x.principais.startsWith(o[9]), 'obtido=' + x.principais + ' esperado=' + o[9]);
});
ga.resumoDesenhos.forEach((r, i) => {
  const x = A.resumoDesenhos[i], tag = 'resumo ' + r[0];
  eq(tag + ' ordem', x.desenho, r[0]); eq(tag + ' cpt', x.cpt, r[1]); eq(tag + ' elementos', x.elementos, r[2]); eq(tag + ' nOS', x.nOS, r[3]); eq(tag + ' posições', x.posicoes, r[4]);
  eq(tag + ' bitolas', x.bitolas, r[5]); eq(tag + ' etiquetas', x.etiquetas, r[6]); eq(tag + ' barras', x.barras, r[7]); eq(tag + ' metros', x.metros, r[8]); eq(tag + ' t', x.t, r[9]);
  eq(tag + ' %', x.pct, r[10]); eq(tag + ' última', x.ultimaTxt, dhTxt(r[11])); eq(tag + ' OS·obs', x.obs, r[12]); eq(tag + ' locais', x.locais, r[13]);
});
ga.ultimas25.forEach((u, i) => {
  const x = A.ultimas[i], tag = 'etiqueta #' + (i + 1);
  eq(tag + ' data/hora', x.data + ' ' + x.hora, dhTxt(u[0])); eq(tag + ' OS', x.os, u[1]); eq(tag + ' operação', x.operacao, u[2]); eq(tag + ' cpt', x.cpt, u[3]); eq(tag + ' desenho', x.desenho, u[4]);
  eq(tag + ' posição', x.posicao, u[5]); eq(tag + ' cj', x.cj, u[6]); eq(tag + ' elemento', x.elemento, u[7]); eq(tag + ' bitola', x.bitola, u[8]); eq(tag + ' comp', x.comp, u[9]);
  eq(tag + ' barras', x.barras, u[10]); eq(tag + ' kg', x.kg, u[11]); eq(tag + ' local', x.local, u[12]); eq(tag + ' obs', x.obs, u[13]);
});
ga.localPadronizado.forEach((v, i) => { if (L[i].local !== v) check('local linha ' + (i + 2) + ' (' + registros[i].destino + ')', false, 'obtido=' + L[i].local + ' esperado=' + v); else ok++; });

/* =============== 2) Correções de grafia (modo normal) =============== */
secao('Nome da Rua — correções sobre a planilha');
PC.setModoPlanilha(false);
const casos = { 'Patio de ferragens lll': 'Pátio de Ferragens III', 'Pátio de ferragens Ill': 'Pátio de Ferragens III', 'Padio de Ferragens 3': 'Pátio de Ferragens III', 'Patio ferragens IV': 'Pátio de Ferragens IV',
  'Arcelormital': 'ARCELORMITTAL', 'ArcelorMittal': 'ARCELORMITTAL', 'Marabá': 'Marabá', '': '(sem local)', 'CPRT': 'CPRT', 'Pátio de ferragens3': 'Pátio de Ferragens III',
  'Pátio de ferragens IV,Rua C.': 'Pátio de Ferragens IV, RUA C.', 'Pátio de ferragens IV, Rua C.': 'Pátio de Ferragens IV, RUA C.' };
Object.keys(casos).forEach(k => eq('rua "' + k + '"', PC.ruaPadrao(k), casos[k]));

/* =============== 3) Filtros — conferência independente (força bruta sobre as linhas do Excel) =============== */
secao('Filtros combinados (conferência independente)');
const kgIx = ix('Peso (kg)'), opIx = ix('Operação'), prIx = ix('Produto'), paIx = ix('Pátio'), baIx = ix('Barras');
const diaDe = r => String(r[ix('Data')]).slice(0, 10);
const bruto = pred => { const s = rows.filter(pred); return { n: s.length, kg: s.reduce((a, r) => a + (+r[kgIx] || 0), 0), bar: s.reduce((a, r) => a + (+r[baIx] || 0), 0), ent: s.filter(r => r[opIx] === 'Entrada').reduce((a, r) => a + (+r[kgIx] || 0), 0), ret: s.filter(r => r[opIx] === 'Retirada').reduce((a, r) => a + (+r[kgIx] || 0), 0) }; };
const txt = r => r.map(v => String(v == null ? '' : v)).join(' | ').toLowerCase();
function cenario(nome, f, pred, hoje) {
  const p = PC.painel(PC.normalizar(registros), f, hoje || HOJE), b = bruto(pred);
  eq(nome + ' · registros', p.kpis.registros, b.n); eq(nome + ' · peso t', p.kpis.pesoT, b.kg / 1000); eq(nome + ' · barras', p.kpis.barras, b.bar); eq(nome + ' · saldo t', p.kpis.saldoT, (b.ent - b.ret) / 1000);
  return p;
}
cenario('pátio Marabá', { patio: 'Marabá' }, r => r[paIx] === 'Marabá');
cenario('retirada + barra reta', { operacao: 'Retirada', produto: 'Barra reta' }, r => r[opIx] === 'Retirada' && r[prIx] === 'Barra reta');
cenario('retirada + aço pronto', { operacao: 'Retirada', produto: 'Aço pronto' }, r => r[opIx] === 'Retirada' && r[prIx] === 'Aço pronto');
cenario('busca "cleber" (todos os campos)', { busca: 'cleber' }, r => txt(r).includes('cleber'));
cenario('busca com acento/maiúscula "SÃO FÉLIX"', { busca: 'SÃO FÉLIX' }, r => r[paIx] === 'São Félix');
cenario('busca "07/11/2026" (data)', { busca: '07/11/2026' }, r => diaDe(r) === '2026-11-07');
cenario('busca em campo Controlador "matheus"', { campo: 'Controlador', busca: 'matheus' }, r => String(r[ix('Controlador')]).toLowerCase().includes('matheus'));
cenario('busca em campo Placa "TZF7H99"', { campo: 'Placa', busca: 'tzf7h99' }, r => String(r[ix('Placa')]).toLowerCase() === 'tzf7h99');
cenario('período De/Até 05 a 06/11', { de: '2026-11-05', ate: '2026-11-06' }, r => diaDe(r) >= '2026-11-05' && diaDe(r) <= '2026-11-06');
cenario('período só "De" 06/11 (até = máx. da base)', { de: '2026-11-06' }, r => diaDe(r) >= '2026-11-06');
cenario('período 7 dias (hoje 09/11)', { periodo: '7 dias' }, r => diaDe(r) >= '2026-11-03' && diaDe(r) <= '2026-11-09');
cenario('período Hoje (09/11) = vazio', { periodo: 'Hoje' }, r => diaDe(r) === '2026-11-09');
cenario('período 30 dias (hoje 09/12)', { periodo: '30 dias' }, r => diaDe(r) >= '2026-11-10' && diaDe(r) <= '2026-12-09', new Date(2026, 11, 9, 9, 0));
const inv = PC.painel(PC.normalizar(registros), { de: '2026-11-07', ate: '2026-11-05' }, HOJE);
check('datas invertidas são corrigidas', inv.janela.trocado && inv.kpis.registros === bruto(r => diaDe(r) >= '2026-11-05' && diaDe(r) <= '2026-11-07').n);
const sem = PC.painel(PC.normalizar(registros), { busca: 'zzzxxx' }, HOJE);
check('sem resultados não quebra', sem.kpis.registros === 0 && sem.ultimos.length === 0 && sem.kpis.mediaKg === 0);
const vazio = PC.painel([], {}, HOJE), vazioAp = PC.acoPronto([], {}, HOJE);
check('base vazia não quebra', vazio.kpis.registros === 0 && vazioAp.kpis.etiquetas === 0);

secao('Aço pronto — filtros e saldo');
const apR = registros.filter(r => r.prod === 'aco');
const nL = PC.normalizar(registros);
function cenAp(nome, f, pred) {
  const a = PC.acoPronto(nL, f, HOJE), s = apR.filter(pred), kg = s.reduce((x, r) => x + r.kg, 0);
  eq(nome + ' · etiquetas', a.kpis.etiquetas, s.length); eq(nome + ' · peso t', a.kpis.pesoT, kg / 1000);
  const ent = s.filter(r => r.op === 'mob').reduce((x, r) => x + r.kg, 0), ret = s.filter(r => r.op === 'ret').reduce((x, r) => x + r.kg, 0);
  eq(nome + ' · saldo t', a.kpis.saldoT, (ent - ret) / 1000);
  eq(nome + ' · Σ saldo por local', a.saldoLocal.reduce((x, o) => x + o.saldoT, 0), (ent - ret) / 1000);
  const ad = PC.acoPronto(nL, f, HOJE, { topDesenhos: 9999 });
  eq(nome + ' · Σ saldo por desenho + sem desenho', ad.resumoDesenhos.reduce((x, o) => x + o.saldoT, 0) + ad.semDesenho.saldoT, (ent - ret) / 1000);
  return a;
}
cenAp('elemento LAJES', { elemento: 'LAJES' }, r => r.elemento === 'LAJES');
cenAp('bitola 16', { bitola: 16 }, r => +r.bitola === 16);
cenAp('retirada', { operacao: 'Retirada' }, r => r.op === 'ret');
cenAp('Marabá + CPRT', { patio: 'Marabá', local: 'CPRT' }, r => r.patio === 'Marabá' && PC.ruaPadrao(r.destino) === 'CPRT');
cenAp('local Pátio de Ferragens III', { local: 'Pátio de Ferragens III' }, r => PC.ruaPadrao(r.destino) === 'Pátio de Ferragens III');
cenAp('desenho 258', { desenho: '258' }, r => String(r.desenho) === '258');
cenAp('CPT CPT002', { cpt: 'CPT002' }, r => r.cpt === 'CPT002');
cenAp('busca "lajes" campo Elemento', { campo: 'Elemento', busca: 'lajes' }, r => String(r.elemento).toLowerCase().includes('lajes'));
cenAp('período De 06/11', { de: '2026-11-06' }, r => r.at >= new Date(2026, 10, 6).toISOString());
const op = PC.acoPronto(nL, {}, HOJE).opcoes;
check('opções de filtro (elementos/locais) preenchidas', op.elementos.length > 5 && op.locais.length > 5 && op.bitolas.length > 3 && op.desenhos.length > 20, JSON.stringify([op.elementos.length, op.locais.length]));

/* =============== 4) Cordoalha =============== */
secao('Cordoalha (produto extra do sistema)');
const cord = registros.concat([
  { id: 'c1', protocolo: 'ENT-X-1', op: 'mob', at: new Date(2026, 10, 7, 10, 0).toISOString(), controlador: 'Teste Silva Souza', patio: 'Marabá', prod: 'cord', ordem: 'OP9', bitola: 12.7, kg: 5000, m: 3500, qtd: '', placa: 'AAA1A11', motorista: 'JOSE', destino: 'CPRT' },
  { id: 'c2', protocolo: 'RET-X-1', op: 'ret', at: new Date(2026, 10, 7, 11, 0).toISOString(), controlador: 'Teste Silva Souza', patio: 'Marabá', prod: 'cord', ordem: 'OP9', bitola: 15.2, kg: 2000, m: 1000, qtd: '', placa: 'AAA1A11', motorista: 'JOSE', destino: 'CPRT' }
]);
const pc = PC.painel(PC.normalizar(cord), {}, HOJE);
check('opção de produto Cordoalha existe', pc.opcoes.produtos.includes('Cordoalha'), JSON.stringify(pc.opcoes.produtos));
check('bitolas 12,7 e 15,2 ganham linha própria', pc.porBitola.some(b => b.bitola === 12.7) && pc.porBitola.some(b => b.bitola === 15.2));
eq('peso cordoalha 12,7 (t)', pc.porBitola.find(b => b.bitola === 12.7).produtos['Cordoalha'], 5);
eq('registros com cordoalha', pc.kpis.registros, 402); eq('barras ignoram cordoalha', pc.kpis.barras, P.kpis.barras);
const so = PC.painel(PC.normalizar(cord), { produto: 'Cordoalha' }, HOJE);
eq('filtro produto Cordoalha · registros', so.kpis.registros, 2); eq('filtro produto Cordoalha · saldo t', so.kpis.saldoT, 3);
check('cordoalha fora do Aço pronto', PC.acoPronto(PC.normalizar(cord), {}, HOJE).kpis.etiquetas === 247);

console.log('\n' + (falhas ? '✗ ' + falhas + ' falha(s), ' + ok + ' ok' : '✓ ' + ok + ' verificações ok'));
process.exit(falhas ? 1 : 0);
