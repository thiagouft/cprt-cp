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
secao('Localização — correções sobre a planilha');
PC.setModoPlanilha(false);
const casos = { 'Patio de ferragens lll': 'Pátio de Ferragens III', 'Pátio de ferragens Ill': 'Pátio de Ferragens III', 'Padio de Ferragens 3': 'Pátio de Ferragens III', 'Patio ferragens IV': 'Pátio de Ferragens IV',
  'Arcelormital': 'ARCELORMITTAL', 'ArcelorMittal': 'ARCELORMITTAL', 'Marabá': 'Marabá', '': '(sem local)', 'CPRT': 'CPRT', 'Pátio de ferragens3': 'Pátio de Ferragens III',
  'Pátio de ferragens IV,Rua C.': 'Pátio de Ferragens IV, RUA C.', 'Pátio de ferragens IV, Rua C.': 'Pátio de Ferragens IV, RUA C.' };
Object.keys(casos).forEach(k => eq('rua "' + k + '"', PC.ruaPadrao(k), casos[k]));

/* =============== 2b) Etiqueta repetida =============== */
secao('Etiqueta repetida — chave de comparação');
{
  const K = PC.chaveEtiqueta;
  const barra = { op: 'mob', prod: 'barra', cod: '27943824542000101837', kg: 1267.43, lote: 'PITL2 1' };
  check('barra reta: mesmo código e peso = mesma chave', K(barra) === K({ ...barra, controlador: 'Outro', placa: 'XXX0X00' }) && K(barra) !== '');
  check('barra reta: peso diferente = chave diferente', K(barra) !== K({ ...barra, kg: 1200 }));
  check('operação diferente = chave diferente (a mesma etiqueta pode sair depois de entrar)', K(barra) !== K({ ...barra, op: 'ret' }));
  check('barra reta sem código nem corrida/feixe = sem chave (não compara)', K({ op: 'mob', prod: 'barra', kg: 500 }) === '');
  check('barra reta sem código usa corrida + feixe + peso', K({ op: 'mob', prod: 'barra', corrida: '27602/82', feixe: '017', kg: 900 }) === K({ op: 'mob', prod: 'barra', corrida: '27602/82', feixe: '017', kg: 900.001 }));
  // Aço pronto: o código da etiqueta é compartilhado por muitas etiquetas, então a comparação usa todos os dados + o peso
  const aco = { op: 'mob', prod: 'aco', cod: '4512077408', cpt: 'CPT29J', os: '8', desenho: '252', posicao: '12', cj: '15', bitola: '12.5', comp: 78, qtd: 100, kg: 48.13 };
  check('aço pronto: CPT diferente = outra etiqueta (mesmo código, desenho, posição, OS, CJ, comprimento, quantidade e peso)', K(aco) !== K({ ...aco, cpt: 'CPT003' }) && K(aco) === K({ ...aco, cpt: 'cpt29j' }));
  check('CPT003 x CPT004 (caso real: 258/10, 552 cm, 100 barras, 871,056 kg, nº 4512077401)', K({ op: 'mob', prod: 'aco', cod: '4512077401', cpt: 'CPT003', os: '7', desenho: '258', posicao: '10', cj: '06', bitola: '16.0', comp: 552, qtd: 100, kg: 871.056 }) !== K({ op: 'mob', prod: 'aco', cod: '4512077401', cpt: 'CPT004', os: '7', desenho: '258', posicao: '10', cj: '06', bitola: '16.0', comp: 552, qtd: 100, kg: 871.056 }));
  check('aço pronto: tudo igual (inclusive o peso) = repetida', K(aco) !== '' && K(aco) === K({ ...aco, controlador: 'Outro', placa: 'XXX0X00', bitola: '12.50', comp: '78', qtd: '100', kg: '48,13' }));
  check('aço pronto: mesmo código, PESO diferente = outra etiqueta', K(aco) !== K({ ...aco, kg: 96.25 }));
  check('aço pronto: mesmo código e peso, quantidade diferente = outra etiqueta', K(aco) !== K({ ...aco, qtd: 200 }));
  check('aço pronto: mesmo código, desenho/posição diferentes = outra etiqueta', K(aco) !== K({ ...aco, desenho: '249' }) && K(aco) !== K({ ...aco, posicao: '11' }));
  check('aço pronto: OS, CJ, bitola ou comprimento diferentes = outra etiqueta', K(aco) !== K({ ...aco, os: '9' }) && K(aco) !== K({ ...aco, cj: '16' }) && K(aco) !== K({ ...aco, bitola: '16.0' }) && K(aco) !== K({ ...aco, comp: 80 }));
  check('aço pronto sem peso = sem chave (não compara)', K({ ...aco, kg: 0 }) === '' && K({ ...aco, kg: undefined }) === '');
  const acoSem = { op: 'mob', prod: 'aco', os: '8', desenho: '231-1', posicao: '20', cj: '13', bitola: '16.0', comp: 362, qtd: 50, kg: 100 };
  check('aço pronto sem código: OS + desenho + posição + CJ + bitola + comprimento + quantidade + peso', K(acoSem) !== '' && K(acoSem) !== K({ ...acoSem, qtd: 51 }) && K(acoSem) === K({ ...acoSem, qtd: '50' }));
  check('aço pronto sem código e sem desenho = sem chave', K({ op: 'mob', prod: 'aco', os: '8', kg: 100 }) === '');
  // base real: com a chave só pelo código, 174 das 236 linhas de aço pronto com código seriam "repetidas"; com todos os dados, o CPT e o peso sobram 31
  {
    const apCod = registros.filter(r => r.prod === 'aco' && String(r.cod || '').trim());
    const cont = {}; apCod.forEach(r => { const k = K(r); cont[k] = (cont[k] || 0) + 1; });
    const extras = Object.keys(cont).reduce((a, k) => a + (cont[k] - 1), 0);
    const soCodigo = {}; apCod.forEach(r => { const k = String(r.cod); soCodigo[k] = (soCodigo[k] || 0) + 1; });
    const antigas = apCod.filter(r => soCodigo[String(r.cod)] > 1).length;
    eq('base real: linhas que a regra antiga (só código) marcaria como repetidas', antigas, 174);
    eq('base real: linhas "a mais" com a regra nova (tudo + CPT + peso)', extras, 31);
  }
  check('cordoalha: código de barras', K({ op: 'mob', prod: 'cord', cod: '1065317351' }) === K({ op: 'mob', prod: 'cord', cod: '1065317351', kg: 1 }));
}

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

/* =============== 3b) Cargas =============== */
secao('Cargas — registradas e estimadas');
{
  // (a) base real: cargas estimadas (nenhum registro tem o campo "carga"), conferidas por uma contagem feita à mão
  const GAP = 30 * 60000, grupos = {};
  registros.forEach(r => { const k = String(r.placa || '').toUpperCase() + '|' + r.op + '|' + r.patio; (grupos[k] = grupos[k] || []).push(new Date(r.at).getTime()); });
  let esperado = 0;
  Object.keys(grupos).forEach(k => { const ts = grupos[k].sort((a, b) => a - b); esperado += k.startsWith('|') ? ts.length : 1 + ts.slice(1).filter((t, i) => t - ts[i] > GAP).length; });
  const pc = PC.painel(PC.normalizar(registros), {}, HOJE, { ultimasCargas: 9999 });
  eq('cargas estimadas na base da planilha', pc.kpis.cargas, esperado);
  eq('nenhuma carga registrada nos dados antigos', pc.kpis.cargasRegistradas, 0); eq('todas estimadas', pc.kpis.cargasEstimadas, esperado);
  eq('Σ etiquetas das cargas = registros', pc.cargas.reduce((a, c) => a + c.etiquetas, 0), pc.kpis.registros);
  eq('Σ peso das cargas = peso total', pc.cargas.reduce((a, c) => a + c.t, 0), pc.kpis.pesoT);
  eq('etiquetas por carga (média)', pc.kpis.etiquetasPorCarga, pc.kpis.registros / esperado);
  check('maior carga >= média', pc.kpis.maiorCarga >= pc.kpis.etiquetasPorCarga);
  eq('Aço pronto também informa as cargas', PC.acoPronto(PC.normalizar(registros), {}, HOJE).kpis.cargas > 0 ? 1 : 0, 1);

  // (b) casos sintéticos
  const at = (h, m) => new Date(2026, 10, 7, h, m).toISOString();
  const R = (id, hh, mm, extra) => ({ id, protocolo: 'ENT-X-' + id, op: 'mob', at: at(hh, mm), controlador: 'C', patio: 'Marabá', prod: 'aco', os: '1', desenho: 'D', posicao: id, cj: '1', elemento: 'PILAR', bitola: '16.0', aco: 'CA-50S', comp: 100, qtd: 10, m: 10, kg: 100, placa: 'AAA1A11', motorista: 'M', destino: 'CPRT', ...extra });
  const sint = [];
  for (let i = 1; i <= 15; i++) sint.push(R('a' + i, 8, i, { carga: 'X', placa: 'AAA1A11' }));          // carga registrada X (15 etiquetas)
  for (let i = 1; i <= 3; i++) sint.push(R('b' + i, 9, i, { carga: 'Y', placa: 'BBB1B22', prod: 'barra' })); // carga registrada Y (3)
  sint.push(R('c1', 10, 0, { placa: 'CCC1C33' }), R('c2', 10, 20, { placa: 'CCC1C33' }));                 // individuais, 20 min de intervalo: 1 carga estimada
  sint.push(R('c3', 11, 0, { placa: 'CCC1C33' }));                                                         // 40 min depois: outra carga estimada
  sint.push(R('d1', 10, 0, { placa: '' }), R('d2', 10, 1, { placa: '' }));                                // sem placa: cada um é uma carga
  sint.push(R('e1', 10, 5, { placa: 'CCC1C33', op: 'ret' }));                                              // outra operação: outra carga
  const ps = PC.painel(PC.normalizar(sint), {}, HOJE, { ultimasCargas: 9999 });
  eq('sintético: total de cargas (2 registradas + 5 estimadas)', ps.kpis.cargas, 7);
  eq('sintético: registradas', ps.kpis.cargasRegistradas, 2); eq('sintético: estimadas', ps.kpis.cargasEstimadas, 5);
  eq('sintético: maior carga', ps.kpis.maiorCarga, 15);
  const cx = ps.cargas.find(c => c.id === 'C:X'), cy = ps.cargas.find(c => c.id === 'C:Y');
  eq('carga X: etiquetas', cx.etiquetas, 15); eq('carga X: peso (t)', cx.t, 1.5); check('carga X é registrada', cx.registrada === true);
  eq('carga Y: produto', cy.produtos, 'Barra reta');
  // filtro por produto: a carga continua contando uma vez, só com as etiquetas que passam no filtro
  const pf = PC.painel(PC.normalizar(sint), { produto: 'Barra reta' }, HOJE, { ultimasCargas: 9999 });
  eq('filtro de produto: cargas', pf.kpis.cargas, 1); eq('filtro de produto: etiquetas da carga', pf.cargas[0].etiquetas, 3);
  // carga registrada não mistura com individual da mesma placa
  const mix = PC.painel(PC.normalizar([R('m1', 8, 0, { carga: 'Z' }), R('m2', 8, 1, { carga: 'Z' }), R('m3', 8, 2, {})]), {}, HOJE);
  eq('registrada + individual da mesma placa = 2 cargas', mix.kpis.cargas, 2);
}

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

/* =============== 5) Aço pronto · modo "Saldo" (estoque por etiqueta) =============== */
secao('Aço pronto · modo Saldo');
{
  const dia = (d, h) => new Date(2026, 10, d, h, 0).toISOString();
  const AP = (id, op, d, h, extra) => Object.assign({ id, protocolo: id, op, at: dia(d, h), controlador: 'T', patio: 'Marabá', prod: 'aco', os: '1', cod: '4512', cpt: 'CPT1', desenho: '250', posicao: '1', cj: '1', elemento: 'LAJES', bitola: 16, aco: 'CA-50S', comp: 100, qtd: 10, m: 10, kg: 100, placa: 'AAA1A11', motorista: 'J', destino: 'CPRT' }, extra || {});
  const L = PC.normalizar([
    AP('e1', 'mob', 1, 8), AP('r1', 'ret', 2, 8),                                   // etiqueta A: entrou e saiu
    AP('e2', 'mob', 1, 9, { posicao: '2', kg: 200 }),                               // etiqueta B: segue no pátio
    AP('e3', 'mob', 1, 10, { posicao: '3', kg: 300 }), AP('r3', 'ret', 2, 9, { posicao: '3', kg: 300 }), AP('e3b', 'mob', 3, 8, { posicao: '3', kg: 300 }), // C: entrou, saiu, entrou de novo
    AP('r9', 'ret', 2, 10, { posicao: '9', kg: 900 }),                              // retirada sem entrada
    AP('e4', 'mob', 1, 11, { posicao: '4', kg: 0 })                                 // entrada sem peso: não dá para identificar
  ]);
  const todos = PC.acoPronto(L, { operacao: 'Todas' }, HOJE), s = PC.acoPronto(L, { operacao: 'Saldo' }, HOJE);
  check('opção "Saldo" existe em Operação', todos.opcoes.operacoes.includes('Saldo'), JSON.stringify(todos.opcoes.operacoes));
  eq('Todas: saldo continua entradas − retiradas (t)', todos.kpis.saldoT, (100 + 200 + 300 + 300 + 0 - 100 - 300 - 900) / 1000);
  eq('Saldo: etiquetas em estoque (B, C reentrada e a sem peso)', s.kpis.etiquetas, 3);
  eq('Saldo: peso em estoque (t)', s.kpis.saldoT, (200 + 300 + 0) / 1000);
  eq('Saldo: não há retiradas na lista', s.kpis.retiradas, 0);
  check('Saldo: a etiqueta que saiu não aparece', !s.ultimas.some(u => u.protocolo === 'e1'));
  check('Saldo: a reentrada aparece, a entrada antiga não', s.ultimas.some(u => u.protocolo === 'e3b') && !s.ultimas.some(u => u.protocolo === 'e3'));
  eq('Saldo: etiquetas casadas', s.estoque.casadas, 2); eq('Saldo: retiradas sem entrada', s.estoque.retiradasSemEntrada, 1); eq('Saldo: entradas sem chave', s.estoque.entradasSemChave, 1);
  check('Saldo respeita os outros filtros (desenho inexistente = vazio)', PC.acoPronto(L, { operacao: 'Saldo', desenho: '999' }, HOJE).kpis.etiquetas === 0);
  check('Saldo: período filtra pela data da entrada', PC.acoPronto(L, { operacao: 'Saldo', de: '2026-11-03', ate: '2026-11-03' }, HOJE).kpis.etiquetas === 1);
  check('modoSaldo só ligado em Saldo', s.modoSaldo === true && todos.modoSaldo === false && !todos.estoque);
  check('Entrada/Retirada continuam filtrando normalmente', PC.acoPronto(L, { operacao: 'Retirada' }, HOJE).kpis.etiquetas === 3 && PC.acoPronto(L, { operacao: 'Entrada' }, HOJE).kpis.etiquetas === 5);
}

/* =============== 6) Diâmetro da cordoalha: "12.700" não é doze mil =============== */
secao('Diâmetro da cordoalha');
{
  const d = PC.diametroCord;
  eq('12,700 (como impresso) → 12,7', d('12,700'), 12.7); eq('"12.700" da IA → 12,7', d('12.700'), 12.7); eq('12700 gravado errado → 12,7', d(12700), 12.7);
  eq('15200 → 15,2', d(15200), 15.2); eq('"15.200" → 15,2', d('15.200'), 15.2);
  eq('15,701 (medida real) → nominal 15,7', d('15,701'), 15.7); eq('15701 → 15,7', d(15701), 15.7); eq('15702 → 15,7', d(15702), 15.7);
  eq('12,7 normal continua', d('12,7'), 12.7); eq('15.2 numérico continua', d(15.2), 15.2); eq('9,5 continua', d('9,5'), 9.5);
  check('vazio, zero e texto → null', d('') === null && d(null) === null && d(0) === null && d('abc') === null);
  const mk = (id, bit, kg) => ({ id, protocolo: id, op: 'mob', at: new Date(2026, 10, 14, 10, 0).toISOString(), controlador: 'T', patio: 'Marabá', prod: 'cord', ordem: 'OP1', bitola: bit, kg, m: 1000, placa: 'AAA1A11', motorista: 'J', destino: 'CPRT' });
  const P = PC.painel(PC.normalizar([mk('a', '12.7', 1000), mk('b', '12700', 2000), mk('c', 15.2, 3000), mk('d', '15200', 4000), mk('e', '15701', 5000), mk('f', '15.7', 6000)]), {}, HOJE);
  const rot = P.porBitola.filter(b => b.produtos['Cordoalha'] > 0).map(b => b.bitola).sort((a, b) => a - b).join(',');
  eq('Painel: só 3 grupos de bitola (12,7 / 15,2 / 15,7)', rot, '12.7,15.2,15.7');
  eq('Painel: peso 12,7 soma os dois (t)', P.porBitola.find(b => b.bitola === 12.7).produtos['Cordoalha'], 3);
  eq('Painel: peso 15,2 soma os dois (t)', P.porBitola.find(b => b.bitola === 15.2).produtos['Cordoalha'], 7);
  eq('Painel: peso 15,7 soma os dois (t)', P.porBitola.find(b => b.bitola === 15.7).produtos['Cordoalha'], 11);
  const aco = PC.normalizar([{ id: 'x', protocolo: 'x', op: 'mob', at: new Date(2026, 10, 14, 10, 0).toISOString(), patio: 'Marabá', prod: 'barra', bitola: '12.5', kg: 10, qtd: 1 }]);
  eq('barra reta não é afetada (12.5 continua 12.5)', aco[0].bitola, 12.5);
}

/* =============== 7) Elemento: LAJE / LAJES, TRAV / TRAVE... =============== */
secao('Elemento padronizado');
{
  const cont = { LAJES: 658, NICHO: 321, 'LIGAÇ': 110, SUPER: 79, SAIDA: 30, TRAVE: 20, TRANS: 12, TRAV: 5, LAJE: 3, 'SAÍDA': 1, 'LIGAÇÃO': 1, FL11NICHO: 1, CABO: 2 };
  const m = PC.mapaElementos(cont), p = v => PC.elementoPadrao(v, m);
  eq('LAJE (etiqueta gasta) → LAJES', p('LAJE'), 'LAJES'); eq('minúsculas e espaços: " laje " → LAJES', p(' laje '), 'LAJES');
  eq('lido pela metade, valor novo: LAJ → LAJES', p('LAJ'), 'LAJES'); eq('LAJES continua', p('LAJES'), 'LAJES');
  eq('TRAV → TRAVE', p('TRAV'), 'TRAVE'); eq('SAÍDA → SAIDA (variante de acento mais usada)', p('SAÍDA'), 'SAIDA');
  eq('nome inteiro: LIGAÇÃO → LIGAÇ', p('LIGAÇÃO'), 'LIGAÇ'); eq('sem acento: LIGACAO → LIGAÇ', p('LIGACAO'), 'LIGAÇ'); eq('SUPERIOR → SUPER', p('SUPERIOR'), 'SUPER');
  eq('ambíguo não mexe: TRA (TRAVE ou TRANS)', p('TRA'), 'TRA'); eq('curto demais não mexe: LA', p('LA'), 'LA');
  eq('elemento diferente não mexe: CABO', p('CABO'), 'CABO'); eq('elemento raro e sem padrão não mexe: FL11NICHO', p('FL11NICHO'), 'FL11NICHO');
  eq('vazio continua vazio', p(''), ''); eq('sem mapa devolve o valor em maiúsculas', PC.elementoPadrao('laje', null), 'LAJE');
  const mk = (id, el, kg) => ({ id, protocolo: id, op: 'mob', at: new Date(2026, 10, 12, 10, 0).toISOString(), controlador: 'T', patio: 'Marabá', prod: 'aco', os: '1', cod: '4512', cpt: 'C' + id, desenho: '258', posicao: id, cj: '1', elemento: el, bitola: 10, aco: 'CA-50S', comp: 250, qtd: 100, m: 250, kg, placa: 'AAA1A11', motorista: 'J', destino: 'CPRT' });
  const regs = []; for (let i = 0; i < 8; i++) regs.push(mk('s' + i, 'LAJES', 100)); regs.push(mk('l1', 'LAJE', 200), mk('l2', 'LAJE', 300));
  const A = PC.acoPronto(PC.normalizar(regs), {}, HOJE);
  eq('Aço pronto: LAJE soma em LAJES (peso t)', A.porElemento.find(e => e.rotulo === 'LAJES').t, 1.3);
  check('Aço pronto: não sobra linha LAJE', !A.porElemento.some(e => e.rotulo === 'LAJE'), JSON.stringify(A.porElemento.map(e => e.rotulo)));
  check('filtro Elemento não lista LAJE', A.opcoes.elementos.indexOf('LAJE') < 0 && A.opcoes.elementos.indexOf('LAJES') > -1, JSON.stringify(A.opcoes.elementos));
  eq('filtrar por LAJES traz as 10 etiquetas', PC.acoPronto(PC.normalizar(regs), { elemento: 'LAJES' }, HOJE).kpis.etiquetas, 10);
}

/* =============== 8) Desenho e Elemento impressos colados ("219-FL11NICHO") =============== */
secao('Desenho e elemento colados');
{
  const cont = { LAJES: 658, NICHO: 321, 'LIGAÇ': 110, LONGA: 33, TRAVE: 20, SUPER: 79, LAJE: 3, FL11NICHO: 1 };
  const m = PC.mapaElementos(cont), s = (d, e) => PC.separaDesenhoElemento(d, e, m);
  const par = (nome, r, d, e) => { eq(nome + ' · desenho', r.desenho, d); eq(nome + ' · elemento', r.elemento, e); };
  par('219-FL11NICHO + vazio', s('219-FL11NICHO', ''), '219-FL11', 'NICHO');
  par('219-FL10NICHO + vazio', s('219-FL10NICHO', ''), '219-FL10', 'NICHO');
  par('desenho e elemento colados nos dois campos (219-FL11NICHO / FL11NICHO)', s('219-FL11NICHO', 'FL11NICHO'), '219-FL11', 'NICHO');
  par('desenho cortado + elemento com o início do desenho (219- / FL11NICHO)', s('219-', 'FL11NICHO'), '219-FL11', 'NICHO');
  par('já correto (219-FL11 / NICHO)', s('219-FL11', 'NICHO'), '219-FL11', 'NICHO');
  par('144FL11LONGA + vazio', s('144FL11LONGA', ''), '144FL11', 'LONGA'); par('144/FL13LONGA + vazio', s('144/FL13LONGA', ''), '144/FL13', 'LONGA');
  par('144FL12LONGA / LONGA', s('144FL12LONGA', 'LONGA'), '144FL12', 'LONGA'); par('elemento incompleto colado: 219-FL10LAJE', s('219-FL10LAJE', ''), '219-FL10', 'LAJES');
  par('desenho normal não muda (258 / LAJE)', s('258', 'LAJE'), '258', 'LAJES'); par('VT.20 não é elemento padrão', s('432', 'VT.20'), '432', 'VT.20');
  par('conflito: outro elemento informado, não mexe', s('219-FL10NICHO', 'LAJES'), '219-FL10NICHO', 'LAJES');
  par('nome sem número antes não separa (TRAVE)', s('TRAVE', ''), 'TRAVE', '');
  par('tudo vazio', s('', ''), '', '');
  const mk = (id, d, e, kg, pos) => ({ id, protocolo: id, op: 'mob', at: new Date(2026, 10, 12, 10, 0).toISOString(), controlador: 'T', patio: 'Marabá', prod: 'aco', os: '12', cod: '4512', cpt: 'DF301R', desenho: d, posicao: pos, cj: '42', elemento: e, bitola: 12.5, aco: 'CA-50S', comp: 158, qtd: 168, m: 265, kg, placa: 'AAA1A11', motorista: 'J', destino: 'CPRT' });
  const regs = []; for (let i = 0; i < 8; i++) regs.push(mk('n' + i, '219-FL11', 'NICHO', 100, String(20 + i)));
  regs.push(mk('g1', '219-FL11NICHO', '', 200, '30'), mk('g2', '219-FL11NICHO', 'FL11NICHO', 300, '31'), mk('g3', '219-', 'FL11NICHO', 400, '32'));
  const A = PC.acoPronto(PC.normalizar(regs), {}, HOJE);
  eq('Aço pronto: só 1 desenho (219-FL11)', A.kpis.desenhos, 1); eq('Aço pronto: só 1 elemento (NICHO)', A.kpis.elementos, 1);
  eq('Aço pronto: NICHO soma tudo (t)', A.porElemento.find(e => e.rotulo === 'NICHO').t, 1.7);
  eq('Aço pronto: desenho 219-FL11 soma tudo (t)', A.resumoDesenhos.find(r => r.desenho === '219-FL11').t, 1.7);
  check('filtro Desenho lista só 219-FL11', A.opcoes.desenhos.join('|') === 'Todos|219-FL11', JSON.stringify(A.opcoes.desenhos));
  eq('filtrar pelo desenho 219-FL11 traz as 11 etiquetas', PC.acoPronto(PC.normalizar(regs), { desenho: '219-FL11' }, HOJE).kpis.etiquetas, 11);
  PC.setModoPlanilha(true);
  eq('modo planilha não separa (reproduz o Excel)', PC.acoPronto(PC.normalizar(regs), {}, HOJE).kpis.desenhos, 3);
  PC.setModoPlanilha(false);
}

/* =============== 9) Desenho com separador variável: 144FL11 = 144/FL11 =============== */
secao('Desenho com separador variável');
{
  const c = { '144/FL1': 1, '144/FL11': 3, '144FL11': 4, '144FL12': 1, '144/FL13': 8, '219-FL10': 29, '219-FL12': 10, '19-FL10': 1, '238FL1': 1, '238FL1-1': 2, '238FL2': 4, '44/FL11': 1, '44FL12': 1, '177-2': 5, 'BFL2-1': 1 };
  const m = PC.mapaDesenhos(c), p = d => PC.desenhoPadrao(d, m);
  eq('separador mais usado do 144 é a barra', m['144'], '/'); eq('do 219 é o hífen', m['219'], '-'); eq('do 238 é nenhum', m['238'], '');
  eq('144FL11 → 144/FL11', p('144FL11'), '144/FL11'); eq('144FL12 → 144/FL12', p('144FL12'), '144/FL12'); eq('144/FL13 continua', p('144/FL13'), '144/FL13');
  eq('hífen no lugar da barra: 144-FL11 → 144/FL11', p('144-FL11'), '144/FL11'); eq('minúsculas: 144fl11 → 144/FL11', p('144fl11'), '144/FL11');
  eq('valor novo do 219: 219/FL10 → 219-FL10', p('219/FL10'), '219-FL10'); eq('219FL10 → 219-FL10', p('219FL10'), '219-FL10');
  eq('desenho sem variação não muda (238FL1-1)', p('238FL1-1'), '238FL1-1'); eq('238FL2 continua', p('238FL2'), '238FL2');
  eq('outro formato não muda (177-2)', p('177-2'), '177-2'); eq('letras antes do FL não mudam (BFL2-1)', p('BFL2-1'), 'BFL2-1');
  eq('número-base desconhecido não muda', p('555FL1'), '555FL1'); eq('vazio', p(''), '');
  eq('empate: prefere separador a nenhum (44)', PC.mapaDesenhos({ '44/FL11': 1, '44FL12': 1 })['44'], '/');
  eq('empate entre hífen e barra: hífen', PC.mapaDesenhos({ '7-FL1': 2, '7/FL2': 2 })['7'], '-');
  const mk = (id, d, e, kg) => ({ id, protocolo: id, op: 'mob', at: new Date(2026, 10, 12, 10, 0).toISOString(), controlador: 'T', patio: 'Marabá', prod: 'aco', os: '1', cod: '4512', cpt: 'C' + id, desenho: d, posicao: id, cj: '1', elemento: e, bitola: 10, aco: 'CA-50S', comp: 100, qtd: 10, m: 10, kg, placa: 'AAA1A11', motorista: 'J', destino: 'CPRT' });
  const regs = [];
  for (let i = 0; i < 8; i++) regs.push(mk('a' + i, '144/FL11', 'LONGA', 100));
  regs.push(mk('b1', '144FL11', 'LONGA', 200), mk('b2', '144FL11LONGA', '', 300), mk('b3', '144-FL11', 'LONGA', 400));
  const A = PC.acoPronto(PC.normalizar(regs), {}, HOJE);
  eq('Aço pronto: um só desenho (144/FL11)', A.kpis.desenhos, 1);
  eq('Aço pronto: soma de todas as variações (t)', A.resumoDesenhos.find(r => r.desenho === '144/FL11').t, 1.7);
  check('filtro Desenho lista só 144/FL11', A.opcoes.desenhos.join('|') === 'Todos|144/FL11', JSON.stringify(A.opcoes.desenhos));
  eq('filtrar por 144/FL11 traz as 11 etiquetas', PC.acoPronto(PC.normalizar(regs), { desenho: '144/FL11' }, HOJE).kpis.etiquetas, 11);
  PC.setModoPlanilha(true);
  eq('modo planilha não unifica (reproduz o Excel)', PC.acoPronto(PC.normalizar(regs), {}, HOJE).kpis.desenhos, 4);
  PC.setModoPlanilha(false);
}

/* =============== 10) Sugestão de desenho quando a impressão come um caractere =============== */
secao('Sugestão de desenho');
{
  const conhecidos = [{ d: '144/FL11', n: 7 }, { d: '144/FL12', n: 2 }, { d: '144/FL13', n: 8 }, { d: '144/FL1', n: 1 }, { d: '219-FL10', n: 29 }, { d: '219-FL12', n: 10 }, { d: '177-2', n: 5 }, { d: '177-3', n: 5 }, { d: '258', n: 12 }];
  const s = v => PC.desenhosParecidos(v, conhecidos);
  eq('144FL1 (dígito comido) sugere 144/FL13, 144/FL11 e 144/FL12', s('144FL1').join(' | '), '144/FL13 | 144/FL11 | 144/FL12');
  eq('144/FL1 (já gravado, 1 registro) também sugere', s('144/FL1').join(' | '), '144/FL13 | 144/FL11 | 144/FL12');
  eq('44FL12 (falta o 1 do começo) sugere 144/FL12', s('44FL12').join(' | '), '144/FL12');
  eq('219-FL1 sugere 219-FL10 e 219-FL12', s('219-FL1').join(' | '), '219-FL10 | 219-FL12');
  check('desenho correto e conhecido não sugere nada', s('144/FL11').length === 0 && s('219-FL10').length === 0 && s('258').length === 0);
  check('ignora separador: 144FL11 já existe como 144/FL11', s('144FL11').length === 0);
  check('desenho totalmente novo não sugere', s('555-FL3').length === 0);
  check('troca de um dígito não é "comido": 219-FL13 não sugere', s('219-FL13').length === 0);
  check('curto demais, vazio e sem lista não sugere', s('14').length === 0 && s('').length === 0 && PC.desenhosParecidos('144FL1', [], 4).length === 0 && PC.desenhosParecidos('144FL1', null, 4).length === 0);
  eq('limite de sugestões', PC.desenhosParecidos('144FL1', conhecidos, 1).join(','), '144/FL13');
  check('só sugere desenhos usados 2+ vezes (não sugere 144/FL1 com 1 registro)', s('144FL').indexOf('144/FL1') < 0, JSON.stringify(s('144FL')));
}

console.log('\n' + (falhas ? '✗ ' + falhas + ' falha(s), ' + ok + ' ok' : '✓ ' + ok + ' verificações ok'));
process.exit(falhas ? 1 : 0);
