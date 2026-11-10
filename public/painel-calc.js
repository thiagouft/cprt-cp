/* Painel — motor de cálculo (puro, sem DOM).
 * Replica as regras das abas "Cálculos" e "Cálculos AP" do Dash.xlsx sobre os registros do sistema.
 * Funciona no navegador (window.PainelCalc) e no Node (module.exports) para testes.
 *
 * Fluxo: normalizar(registros) -> linhas tipadas -> painel(linhas, filtros) / acoPronto(linhas, filtros)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PainelCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- constantes ---------- */
  var COLUNAS = ['Protocolo', 'Operação', 'Pátio', 'Produto', 'Data', 'Hora', 'Controlador', 'OS / Ordem de produção',
    'Código etiqueta / barras', 'CPT/CPM/DF', 'Material', 'Descrição / Marca', 'Corrida', 'Feixe', 'Lote', 'Desenho', 'Posição',
    'CJ', 'Elemento', 'Bitola / Diâmetro (mm)', 'Aço / Classe', 'Comp. (cm)', 'Barras', 'Metros / Metragem', 'Peso (kg)',
    'Peso bruto (kg)', 'Torção', 'Resistência', 'Norma', 'Data fabricação', 'RE', 'Placa', 'Motorista', 'Empresa', 'Crachá',
    'Localização', 'Autorizado/Solicitado por', 'Observações', 'Nota Fiscal'];
  var BITOLAS = [6.3, 8, 10, 12.5, 16, 20, 25, 32];
  var PATIOS = ['Marabá', 'São Félix'];
  var PRODUTOS = { aco: 'Aço pronto', barra: 'Barra reta', cord: 'Cordoalha' };
  var OPERACOES = { ret: 'Retirada', mob: 'Entrada' };
  var PERIODOS = ['Hoje', '7 dias', '30 dias', 'Todo o período'];
  var DIA = 86400000;

  /* ---------- utilitários ---------- */
  function str(v) { return v == null ? '' : String(v); }
  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    var s = str(v).trim().replace(/\s/g, '');
    if (!s) return 0;
    if (s.indexOf(',') > -1) s = s.replace(/\./g, '').replace(',', '.');
    var n = parseFloat(s);
    return isFinite(n) ? n : 0;
  }
  function numOuNull(v) {
    if (v == null || str(v).trim() === '') return null;
    var n = num(v);
    return n;
  }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function dkeyDe(d) { return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function diaNum(d) { return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DIA); } // dia local -> nº do dia
  function diaDeChave(k) { // 'YYYY-MM-DD' -> nº do dia
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ''); if (!m) return null;
    return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DIA);
  }
  function chaveDeDia(n) { var d = new Date(n * DIA); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()); }
  function fmtData(n) { var d = new Date(n * DIA); return p2(d.getUTCDate()) + '/' + p2(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear(); }
  function fmtHora(min) { return p2(Math.floor(min / 60)) + ':' + p2(min % 60); }
  function fmtNum(n) { return n == null ? '' : String(n).replace('.', ','); } // 12.5 -> "12,5" (como o Excel pt-BR)
  function sobe(s) { return str(s).trim().toUpperCase(); }
  function dobra(s) { // minúsculas e sem acento (busca tolerante)
    var t = str(s).toLowerCase();
    try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) { /* ambiente sem normalize */ }
    return t;
  }
  function cmpTxt(a, b) { return str(a).localeCompare(str(b), 'pt-BR', { sensitivity: 'base' }); }
  function somar(arr, f) { var s = 0; for (var i = 0; i < arr.length; i++) s += f(arr[i]); return s; }
  function distintos(arr, f) { // UNIQUE do Excel (sem diferenciar maiúsculas), ignora vazios
    var m = {}, out = [];
    for (var i = 0; i < arr.length; i++) {
      var v = str(f(arr[i])).trim(); if (!v) continue;
      var k = v.toUpperCase(); if (!m[k]) { m[k] = 1; out.push(v); }
    }
    return out;
  }
  function ordenaMisto(vals) { // números primeiro (crescente), depois texto
    return vals.slice().sort(function (a, b) {
      var na = parseFloat(String(a).replace(',', '.')), nb = parseFloat(String(b).replace(',', '.'));
      var ia = isFinite(na) && /^[\d.,]+$/.test(String(a).trim()), ib = isFinite(nb) && /^[\d.,]+$/.test(String(b).trim());
      if (ia && ib) return na - nb || cmpTxt(a, b);
      if (ia) return -1; if (ib) return 1;
      return cmpTxt(a, b);
    });
  }
  function ordenaEstavel(arr, cmp) { // Array.sort pode não ser estável em motores antigos
    return arr.map(function (v, i) { return [v, i]; }).sort(function (x, y) { return cmp(x[0], y[0]) || x[1] - y[1]; }).map(function (x) { return x[0]; });
  }

  /* ---------- Localização padronizada (aba Cálculos AP, coluna BU) ---------- */
  var ROMANOS = { '1': 'I', '2': 'II', '3': 'III', '4': 'IV', '5': 'V' };
  var APELIDOS = { 'ARCELORMITAL': 'ARCELORMITTAL' };
  var modoPlanilha = false; // true = reproduz a planilha exatamente (sem correções de grafia); usado nos testes
  function setModoPlanilha(v) { modoPlanilha = !!v; }
  function ruaPadrao(destino) {
    var k = str(destino).trim().toUpperCase().replace(/Á/g, 'A').replace(modoPlanilha ? /LLL/g : /\bLLL\b/g, 'III');
    if (!modoPlanilha) k = k.replace(/\bILL\b/g, 'III');
    if (!modoPlanilha) k = k.replace(/\s*,\s*/g, ', '); // "IV,RUA C." e "IV, RUA C." são a mesma rua
    k = k.replace(/\s+/g, ' ').trim();
    if (!k) return '(sem local)';
    if (k.indexOf('FERRAGENS') > -1) {
      var suf = k.slice(k.lastIndexOf('FERRAGENS') + 9).trim();
      suf = ROMANOS[suf] || suf;
      return 'Pátio de Ferragens' + (suf ? ' ' + suf : '');
    }
    if (k === 'MARABA') return 'Marabá';
    return (!modoPlanilha && APELIDOS[k]) || k;
  }

  /* ---------- normalização dos registros do sistema ---------- */
  function normalizar(registros) {
    var out = [];
    for (var i = 0; i < registros.length; i++) out.push(linha(registros[i]));
    atribuiCargas(out);
    return out;
  }

  /* ---------- Cargas ----------
   * Carga = conjunto de etiquetas da mesma carreta. Registros feitos pelo modo carga trazem o campo `carga` (registrada).
   * Para os demais (lançamentos individuais e registros antigos) a carga é ESTIMADA: mesma placa, operação e pátio,
   * com no máximo GAP_CARGA minutos entre uma etiqueta e a seguinte. */
  var GAP_CARGA = 30; // nos dados reais, 30 min dá cargas de 10 a 16 etiquetas em média; intervalos maiores juntam viagens diferentes
  function atribuiCargas(linhas) {
    var grupos = {}, ordem = [], i, L, k;
    for (i = 0; i < linhas.length; i++) {
      L = linhas[i];
      if (L.carga) { L.cargaId = 'C:' + L.carga; L.cargaReg = true; continue; }
      L.cargaReg = false;
      if (!sobe(L.placa)) { L.cargaId = 'I:' + i; continue; } // sem placa: não dá para agrupar
      k = sobe(L.placa) + '|' + L.operacao + '|' + L.patio;
      if (!grupos[k]) { grupos[k] = []; ordem.push(k); }
      grupos[k].push(L);
    }
    ordem.forEach(function (key) {
      var g = ordenaEstavel(grupos[key], function (a, b) { return a.ts - b.ts; }), ult = null, id = null;
      g.forEach(function (x) {
        if (ult == null || x.ts - ult > GAP_CARGA) id = 'E:' + key + '|' + x.ts;
        x.cargaId = id; ult = x.ts;
      });
    });
  }
  function resumoCargas(rows, limite) {
    var mp = {}, ordem = [], i, L, g;
    for (i = 0; i < rows.length; i++) {
      L = rows[i]; g = mp[L.cargaId];
      if (!g) {
        g = mp[L.cargaId] = { id: L.cargaId, registrada: !!L.cargaReg, placa: L.placa, operacao: L.operacao, patio: L.patio, ini: L.ts, fim: L.ts, etiquetas: 0, kg: 0, motorista: L.motorista, local: L.local, produtos: {} };
        ordem.push(L.cargaId);
      }
      g.etiquetas++; g.kg += L.kg; g.produtos[L.produto] = 1;
      if (L.ts < g.ini) g.ini = L.ts;
      if (L.ts > g.fim) g.fim = L.ts;
    }
    var lista = ordem.map(function (k) { return mp[k]; }), maior = 0, reg = 0;
    lista.forEach(function (c) { if (c.etiquetas > maior) maior = c.etiquetas; if (c.registrada) reg++; });
    var txt = function (ts) { return fmtData(Math.floor(ts / 1440)) + ' ' + fmtHora(ts % 1440); };
    var top = ordenaEstavel(lista, function (a, b) { return b.fim - a.fim; }).slice(0, limite || 15).map(function (c) {
      return { id: c.id, registrada: c.registrada, placa: c.placa, operacao: c.operacao, patio: c.patio, iniTxt: txt(c.ini), fimTxt: txt(c.fim), etiquetas: c.etiquetas, t: c.kg / 1000, motorista: c.motorista, local: c.local, produtos: Object.keys(c.produtos).join(' + ') };
    });
    return { total: lista.length, registradas: reg, estimadas: lista.length - reg, maior: maior, media: lista.length ? rows.length / lista.length : 0, lista: top };
  }
  function linha(r) {
    var d = new Date(r.at), cord = r.prod === 'cord';
    var dia = diaNum(d), min = d.getHours() * 60 + d.getMinutes();
    var produto = PRODUTOS[r.prod] || PRODUTOS.aco;
    var bit = numOuNull(r.bitola);
    var L = {
      id: r.id, protocolo: str(r.protocolo), operacao: OPERACOES[r.op] || str(r.op), patio: str(r.patio), produto: produto,
      dia: dia, min: min, ts: dia * 1440 + min, controlador: str(r.controlador),
      os: str(cord ? r.ordem : r.os), cod: str(r.cod), cpt: str(r.cpt), material: str(r.material), descricao: str(r.descricao || r.marca),
      corrida: str(r.corrida), feixe: str(r.feixe), lote: str(r.lote), desenho: str(r.desenho), posicao: str(r.posicao), cj: str(r.cj),
      elemento: str(r.elemento), bitola: bit, aco: str(r.aco), comp: numOuNull(r.comp), barras: cord ? 0 : num(r.qtd),
      metros: num(r.m), kg: num(r.kg), pbruto: numOuNull(r.pbruto), torcao: str(r.torcao), resist: str(r.resist), norma: str(r.norma),
      datafab: str(r.datafab), re: str(r.re), placa: str(r.placa), motorista: str(r.motorista), empresa: str(r.empresa), cracha: str(r.cracha),
      destino: str(r.destino), autorizador: str(r.autorizador), obs: str(r.obs),
      nf: (r.tem_nf || r.cargaNf || (r.photos && r.photos.notafiscal && r.photos.notafiscal.data) || r.nf === 'Sim') ? 'Sim' : 'Não'
    };
    L.local = ruaPadrao(L.destino);
    L.carga = str(r.carga);
    L.campos = [L.protocolo, L.operacao, L.patio, L.produto, fmtData(dia), fmtHora(min), L.controlador, L.os, L.cod, L.cpt, L.material,
      L.descricao, L.corrida, L.feixe, L.lote, L.desenho, L.posicao, L.cj, L.elemento, bit == null ? '' : fmtNum(bit), L.aco,
      L.comp == null ? '' : fmtNum(L.comp), cord ? '' : fmtNum(L.barras), fmtNum(L.metros), fmtNum(L.kg), L.pbruto == null ? '' : fmtNum(L.pbruto),
      L.torcao, L.resist, L.norma, L.datafab, L.re, L.placa, L.motorista, L.empresa, L.cracha, L.destino, L.autorizador, L.obs, L.nf].map(dobra);
    L.texto = L.campos.join(' | ');
    return L;
  }

  /* ---------- filtros ---------- */
  function limites(linhas, f, hoje) {
    var h = diaNum(hoje || new Date()), min = null, max = null, i;
    for (i = 0; i < linhas.length; i++) { if (min == null || linhas[i].dia < min) min = linhas[i].dia; if (max == null || linhas[i].dia > max) max = linhas[i].dia; }
    var per = f.periodo || 'Todo o período', todo = per === 'Todo o período';
    var ini = diaDeChave(f.de), fim = diaDeChave(f.ate);
    if (ini == null) ini = per === 'Hoje' ? h : per === '7 dias' ? h - 6 : per === '30 dias' ? h - 29 : (min == null ? h : min);
    if (fim == null) fim = todo ? (max == null ? h : max) : h;
    var trocado = false;
    if (ini > fim) { var t = ini; ini = fim; fim = t; trocado = true; }
    return { ini: ini, fim: fim, trocado: trocado, hoje: h };
  }
  function buscaOk(L, campo, termo) {
    if (!termo) return true;
    var t = dobra(termo.trim());
    if (!t) return true;
    if (!campo || campo === 'Todos os campos') return L.texto.indexOf(t) > -1;
    var i = COLUNAS.indexOf(campo);
    if (i < 0 && (campo === 'Destino' || campo === 'Nome da Rua')) i = COLUNAS.indexOf('Localização'); // nomes antigos da coluna
    return i > -1 && L.campos[i].indexOf(t) > -1;
  }
  function igual(a, b) { return sobe(a) === sobe(b); }
  function todos(v, rotulo) { return v == null || v === '' || v === rotulo; }

  /* ---------- agregações comuns ---------- */
  function totais(rows) {
    var ent = { n: 0, barras: 0, kg: 0, metros: 0 }, ret = { n: 0, barras: 0, kg: 0, metros: 0 }, i, x, t;
    for (i = 0; i < rows.length; i++) {
      x = rows[i]; t = x.operacao === 'Entrada' ? ent : x.operacao === 'Retirada' ? ret : null; if (!t) continue;
      t.n++; t.barras += x.barras; t.kg += x.kg; t.metros += x.metros;
    }
    return {
      ent: ent, ret: ret,
      saldo: { n: ent.n - ret.n, barras: ent.barras - ret.barras, kg: ent.kg - ret.kg, metros: ent.metros - ret.metros }
    };
  }
  function serieDias(rows, fim, janela, ini) {
    var de = janela === 'periodo' ? Math.max(ini, fim - 365) : fim - 6, out = [], mapa = {}, i, d;
    for (d = de; d <= fim; d++) { var o = { dia: d, chave: chaveDeDia(d), rotulo: fmtData(d), ret: 0, ent: 0, nRet: 0, nEnt: 0 }; out.push(o); mapa[d] = o; }
    for (i = 0; i < rows.length; i++) {
      var r = rows[i], o2 = mapa[r.dia]; if (!o2) continue;
      if (r.operacao === 'Retirada') { o2.ret += r.kg / 1000; o2.nRet++; } else if (r.operacao === 'Entrada') { o2.ent += r.kg / 1000; o2.nEnt++; }
    }
    return out;
  }
  function listaBitolas(rows) { // lista fixa do Excel + qualquer outra bitola presente (ex.: cordoalha 12,7 / 15,2)
    var s = BITOLAS.slice(), i;
    for (i = 0; i < rows.length; i++) { var b = rows[i].bitola; if (b != null && b > 0 && s.indexOf(b) < 0) s.push(b); }
    return s.sort(function (a, b) { return a - b; });
  }
  function nomeCurto(nome) { // "Nilton César de Sousa" -> "Nilton César"; pula conectores (da, de, do...)
    var p = str(nome).trim().split(/\s+/).filter(Boolean);
    if (p.length <= 1) return p.join(' ');
    if (/^(d[aeo]s?|e)$/i.test(p[1]) && p.length > 2) return p[0] + ' ' + p[1] + ' ' + p[2];
    return p[0] + ' ' + p[1];
  }

  /* ---------- PAINEL ---------- */
  function filtroPainel(linhas, f, hoje) {
    f = f || {};
    var lim = limites(linhas, f, hoje), base = [], fin = [], i, L, ok;
    for (i = 0; i < linhas.length; i++) {
      L = linhas[i];
      ok = (todos(f.patio, 'Todos os pátios') || igual(L.patio, f.patio)) &&
        (todos(f.operacao, 'Todas') || igual(L.operacao, f.operacao)) &&
        (todos(f.produto, 'Todos') || igual(L.produto, f.produto)) &&
        buscaOk(L, f.campo, f.busca);
      if (ok) { base.push(L); if (L.dia >= lim.ini && L.dia <= lim.fim) fin.push(L); }
    }
    return { lim: lim, base: base, fin: fin };
  }

  function painel(linhas, f, hoje, opc) {
    opc = opc || {};
    var m = filtroPainel(linhas, f, hoje), E = m.fin, lim = m.lim, t = totais(E), i, L;
    var placas = distintos(E, function (x) { return x.placa; }).length;
    var motoristas = distintos(E, function (x) { return sobe(x.motorista); }).length;
    var kg = somar(E, function (x) { return x.kg; });

    var kpis = {
      registros: E.length, entradas: t.ent.n, retiradas: t.ret.n, pesoT: kg / 1000, pesoEntT: t.ent.kg / 1000, pesoRetT: t.ret.kg / 1000,
      saldoT: (t.ent.kg - t.ret.kg) / 1000, barras: somar(E, function (x) { return x.barras; }), metros: somar(E, function (x) { return x.metros; }),
      placas: placas, motoristas: motoristas, mediaKg: E.length ? kg / E.length : 0
    };
    var cg = resumoCargas(E, opc.ultimasCargas || 15);
    kpis.cargas = cg.total; kpis.cargasRegistradas = cg.registradas; kpis.cargasEstimadas = cg.estimadas;
    kpis.etiquetasPorCarga = cg.media; kpis.maiorCarga = cg.maior;

    // por pátio (com entradas/retiradas/saldo)
    var patios = PATIOS.slice();
    for (i = 0; i < linhas.length; i++) if (linhas[i].patio && patios.indexOf(linhas[i].patio) < 0) patios.push(linhas[i].patio);
    var porPatio = patios.map(function (p) {
      var rs = E.filter(function (x) { return x.patio === p; }), tt = totais(rs);
      return { patio: p, t: somar(rs, function (x) { return x.kg; }) / 1000, entT: tt.ent.kg / 1000, retT: tt.ret.kg / 1000, saldoT: (tt.ent.kg - tt.ret.kg) / 1000, registros: rs.length };
    });

    // por bitola x produto
    var prods = [], bits = listaBitolas(E);
    for (i = 0; i < E.length; i++) if (prods.indexOf(E[i].produto) < 0) prods.push(E[i].produto);
    ['Aço pronto', 'Barra reta', 'Cordoalha'].forEach(function (p) { if (prods.indexOf(p) < 0 && (p !== 'Cordoalha')) prods.push(p); });
    prods = ['Aço pronto', 'Barra reta', 'Cordoalha'].filter(function (p) { return prods.indexOf(p) > -1; });
    function linhaBitola(rs, rotulo, bitola) {
      var o = { bitola: bitola, rotulo: rotulo, lotes: rs.length, barras: somar(rs, function (x) { return x.barras; }), metros: somar(rs, function (x) { return x.metros; }), t: somar(rs, function (x) { return x.kg; }) / 1000, produtos: {} };
      prods.forEach(function (p) { o.produtos[p] = somar(rs.filter(function (x) { return x.produto === p; }), function (x) { return x.kg; }) / 1000; });
      return o;
    }
    var porBitola = bits.map(function (b) { return linhaBitola(E.filter(function (x) { return x.bitola === b; }), fmtNum(b) + ' mm', b); });
    var outras = E.filter(function (x) { return !(x.bitola > 0); });
    porBitola.push(linhaBitola(outras, 'Outras', null));
    var totalBitola = linhaBitola(E, 'Total', null);

    // por controlador (top 6)
    var ctl = {}, ordem = [];
    for (i = 0; i < E.length; i++) { L = E[i]; if (!L.controlador) continue; var k = sobe(L.controlador); if (!ctl[k]) { ctl[k] = { nome: L.controlador, kg: 0, n: 0 }; ordem.push(k); } ctl[k].kg += L.kg; ctl[k].n++; }
    var porControlador = ordenaEstavel(ordem.map(function (k) { return ctl[k]; }), function (a, b) { return b.kg - a.kg; }).slice(0, opc.topControladores || 6)
      .map(function (c) { return { nome: c.nome, rotulo: nomeCurto(c.nome), t: c.kg / 1000, registros: c.n }; });

    // últimos N registros
    var ult = ordenaEstavel(E, function (a, b) { return b.ts - a.ts; }).slice(0, opc.ultimos || 15).map(function (x) {
      return { protocolo: x.protocolo, operacao: x.operacao, placa: x.placa, data: fmtData(x.dia), hora: fmtHora(x.min), patio: x.patio, produto: x.produto, bitola: x.bitola, barras: x.barras, kg: x.kg, motorista: x.motorista, controlador: x.controlador, rua: x.destino, local: x.local };
    });

    return {
      janela: { ini: lim.ini, fim: lim.fim, iniTxt: fmtData(lim.ini), fimTxt: fmtData(lim.fim), trocado: lim.trocado },
      kpis: kpis, porPatio: porPatio, produtos: prods, porBitola: porBitola, totalBitola: totalBitola, porControlador: porControlador,
      serie: serieDias(E, lim.fim, opc.janela || 7, lim.ini), ultimos: ult, cargas: cg.lista,
      opcoes: opcoesPainel(linhas), totalBase: linhas.length
    };
  }
  function opcoesPainel(linhas) {
    var pat = PATIOS.slice(), prod = [], i;
    for (i = 0; i < linhas.length; i++) {
      if (linhas[i].patio && pat.indexOf(linhas[i].patio) < 0) pat.push(linhas[i].patio);
      if (prod.indexOf(linhas[i].produto) < 0) prod.push(linhas[i].produto);
    }
    return {
      patios: ['Todos os pátios'].concat(pat.sort(cmpTxt)), operacoes: ['Todas', 'Entrada', 'Retirada'],
      produtos: ['Todos'].concat(['Aço pronto', 'Barra reta', 'Cordoalha'].filter(function (p) { return prod.indexOf(p) > -1; })),
      periodos: PERIODOS.slice(), campos: ['Todos os campos'].concat(COLUNAS)
    };
  }

  /* ---------- AÇO PRONTO ---------- */
  function acoPronto(linhas, f, hoje, opc) {
    f = f || {}; opc = opc || {};
    var lim = limites(linhas, f, hoje), ap = linhas.filter(function (x) { return x.produto === 'Aço pronto'; }), i, L;
    var E = ap.filter(function (L2) {
      return (todos(f.patio, 'Todos os pátios') || igual(L2.patio, f.patio)) &&
        (todos(f.operacao, 'Todas') || igual(L2.operacao, f.operacao)) &&
        (todos(f.elemento, 'Todos') || igual(L2.elemento, f.elemento)) &&
        (todos(f.desenho, 'Todos') || igual(L2.desenho, f.desenho)) &&
        (todos(f.cpt, 'Todos') || igual(L2.cpt, f.cpt)) &&
        (todos(f.bitola, 'Todas') || L2.bitola === num(f.bitola)) &&
        (todos(f.local, 'Todos') || L2.local === f.local) &&
        buscaOk(L2, f.campo, f.busca) && L2.dia >= lim.ini && L2.dia <= lim.fim;
    });
    var t = totais(E), kg = somar(E, function (x) { return x.kg; }), barras = somar(E, function (x) { return x.barras; });
    var elementos = distintos(E, function (x) { return x.elemento; });
    function porChave(chaveFn, rotuloFn) { // soma por chave, mais pesado primeiro
      var mp = {}, ordem = [];
      E.forEach(function (x) { var k = chaveFn(x); if (!k) return; var ku = k.toUpperCase(); if (!mp[ku]) { mp[ku] = { chave: k, rows: [] }; ordem.push(ku); } mp[ku].rows.push(x); });
      return ordenaEstavel(ordem.map(function (ku) { return mp[ku]; }), function (a, b) {
        return somar(b.rows, function (x) { return x.kg; }) - somar(a.rows, function (x) { return x.kg; });
      }).map(function (g) {
        var tt = totais(g.rows);
        return {
          chave: g.chave, rotulo: rotuloFn ? rotuloFn(g.chave) : g.chave, etiquetas: g.rows.length, barras: somar(g.rows, function (x) { return x.barras; }),
          t: somar(g.rows, function (x) { return x.kg; }) / 1000, entT: tt.ent.kg / 1000, retT: tt.ret.kg / 1000, saldoT: (tt.ent.kg - tt.ret.kg) / 1000,
          entBarras: tt.ent.barras, retBarras: tt.ret.barras, saldoBarras: tt.ent.barras - tt.ret.barras
        };
      });
    }
    var kpis = {
      etiquetas: E.length, entradas: t.ent.n, retiradas: t.ret.n, pesoT: kg / 1000, barras: barras, metros: somar(E, function (x) { return x.metros; }),
      desenhos: distintos(E, function (x) { return x.desenho; }).length,
      posicoes: distintos(E.filter(function (x) { return x.desenho; }), function (x) { return x.desenho + '|' + x.posicao; }).length,
      os: distintos(E, function (x) { return x.os; }).length, cj: distintos(E, function (x) { return x.cj; }).length, elementos: elementos.length,
      mediaKg: E.length ? kg / E.length : 0, compMedio: barras ? somar(E, function (x) { return (x.comp || 0) * x.barras; }) / barras : 0,
      saldoT: (t.ent.kg - t.ret.kg) / 1000, saldoBarras: t.ent.barras - t.ret.barras, saldoEtiquetas: t.ent.n - t.ret.n
    };
    var cgA = resumoCargas(E, 1);
    kpis.cargas = cgA.total; kpis.etiquetasPorCarga = cgA.media;
    var porElemento = porChave(function (x) { return x.elemento; });
    kpis.maiorElemento = porElemento.length ? porElemento[0].chave : '-';
    var porDesenho = porChave(function (x) { return x.desenho; }, function (d) { return 'Des. ' + d; });
    var bits = listaBitolas(E);
    var porBitola = bits.map(function (b) {
      var rs = E.filter(function (x) { return x.bitola === b; }), tt = totais(rs);
      return { bitola: b, rotulo: fmtNum(b) + ' mm', t: somar(rs, function (x) { return x.kg; }) / 1000, barras: somar(rs, function (x) { return x.barras; }), entT: tt.ent.kg / 1000, retT: tt.ret.kg / 1000, saldoT: (tt.ent.kg - tt.ret.kg) / 1000 };
    });

    // matriz elemento x bitola (8 maiores elementos)
    var top8 = porElemento.slice(0, 8), matriz = top8.map(function (el) {
      var cel = bits.map(function (b) { return somar(E.filter(function (x) { return igual(x.elemento, el.chave) && x.bitola === b; }), function (x) { return x.kg; }) / 1000; });
      return { elemento: el.chave, celulas: cel, total: cel.reduce(function (a, b) { return a + b; }, 0) };
    });
    var totM = bits.map(function (b, j) { return matriz.reduce(function (a, r) { return a + r.celulas[j]; }, 0); });
    var totG = totM.reduce(function (a, b) { return a + b; }, 0);
    matriz.forEach(function (r) { r.pct = totG ? r.total / totG : 0; });

    // onde está o aço: Operação | Pátio | Local
    var gr = {}, gk = [];
    E.forEach(function (x) { var k = x.operacao + '|' + x.patio + '|' + x.local; if (!gr[k]) { gr[k] = []; gk.push(k); } gr[k].push(x); });
    var onde = gk.map(function (k) {
      var rs = gr[k], p = k.split('|'), w = {}, ws = [];
      rs.forEach(function (x) { var d = x.desenho; if (!d) return; var du = d.toUpperCase(); if (!w[du]) { w[du] = { d: d, kg: 0 }; ws.push(du); } w[du].kg += x.kg; });
      var top = ordenaEstavel(ws.map(function (du) { return w[du]; }), function (a, b) { return b.kg - a.kg; }).slice(0, 6).map(function (o) { return o.d; });
      return {
        operacao: p[0], patio: p[1], local: p[2], etiquetas: rs.length, desenhos: distintos(rs, function (x) { return x.desenho; }).length,
        barras: somar(rs, function (x) { return x.barras; }), t: somar(rs, function (x) { return x.kg; }) / 1000,
        ultima: Math.max.apply(null, rs.map(function (x) { return x.ts; })), principais: top.join(' / ')
      };
    });
    var totOnde = somar(onde, function (o) { return o.t; });
    onde = ordenaEstavel(onde, function (a, b) { return cmpTxt(a.operacao, b.operacao) || b.t - a.t; });
    onde.forEach(function (o) { o.pct = totOnde ? o.t / totOnde : 0; o.ultimaTxt = fmtData(Math.floor(o.ultima / 1440)) + ' ' + fmtHora(o.ultima % 1440); });

    // saldo por Pátio | Local (entrada - retirada)
    var gs = {}, gsk = [];
    E.forEach(function (x) { var k = x.patio + '|' + x.local; if (!gs[k]) { gs[k] = []; gsk.push(k); } gs[k].push(x); });
    var saldoLocal = ordenaEstavel(gsk.map(function (k) {
      var rs = gs[k], p = k.split('|'), tt = totais(rs);
      return {
        patio: p[0], local: p[1], entEtiquetas: tt.ent.n, retEtiquetas: tt.ret.n, saldoEtiquetas: tt.ent.n - tt.ret.n,
        entBarras: tt.ent.barras, retBarras: tt.ret.barras, saldoBarras: tt.ent.barras - tt.ret.barras,
        entT: tt.ent.kg / 1000, retT: tt.ret.kg / 1000, saldoT: (tt.ent.kg - tt.ret.kg) / 1000
      };
    }), function (a, b) { return b.saldoT - a.saldoT; });

    // resumo por desenho (top 25 por peso)
    function fj(rs, f2) { return ordenaMisto(distintos(rs, f2)).join(' / '); }
    var grupoDes = {}, ordDes = [];
    E.forEach(function (x) { if (!x.desenho) return; var du = x.desenho.toUpperCase(); if (!grupoDes[du]) { grupoDes[du] = []; ordDes.push(du); } grupoDes[du].push(x); });
    var todosDesenhos = ordDes.map(function (du) {
      var rs = grupoDes[du], tt = totais(rs), cp = ordenaMisto(distintos(rs, function (x) { return x.cpt; }));
      var ult = Math.max.apply(null, rs.map(function (x) { return x.ts; }));
      var recente = ordenaEstavel(rs, function (a, b) { return b.ts - a.ts; })[0];
      return {
        desenho: rs[0].desenho, cpt: cp.length ? cp[0] + (cp.length > 1 ? ' +' + (cp.length - 1) : '') : '', elementos: fj(rs, function (x) { return x.elemento; }),
        nOS: distintos(rs, function (x) { return x.os; }).length, posicoes: distintos(rs, function (x) { return x.posicao; }).length,
        bitolas: ordenaMisto(distintos(rs, function (x) { return x.bitola == null ? '' : fmtNum(x.bitola); })).join(' / '),
        etiquetas: rs.length, barras: somar(rs, function (x) { return x.barras; }), metros: somar(rs, function (x) { return x.metros; }),
        t: somar(rs, function (x) { return x.kg; }) / 1000, entT: tt.ent.kg / 1000, retT: tt.ret.kg / 1000, saldoT: (tt.ent.kg - tt.ret.kg) / 1000,
        entBarras: tt.ent.barras, retBarras: tt.ret.barras, saldoBarras: tt.ent.barras - tt.ret.barras,
        ultima: ult, ultimaTxt: fmtData(Math.floor(ult / 1440)) + ' ' + fmtHora(ult % 1440),
        obs: 'OS ' + fj(rs, function (x) { return x.os; }) + '  ·  ' + (recente ? recente.obs : ''),
        locais: fj(rs, function (x) { return x.patio + ' · ' + x.local; })
      };
    });
    // % do peso: sobre o total dos desenhos preenchidos (como na planilha); linhas sem desenho ficam de fora e são reportadas à parte
    var totRes = somar(todosDesenhos, function (r) { return r.t; });
    var semDesenho = E.filter(function (x) { return !x.desenho; });
    var resumo = ordenaEstavel(todosDesenhos, function (a, b) { return b.t - a.t; }).slice(0, opc.topDesenhos || 25);
    resumo.forEach(function (r) { r.pct = totRes ? r.t / totRes : 0; });
    var semDesenhoTot = totais(semDesenho);

    var ultimas = ordenaEstavel(E, function (a, b) { return b.ts - a.ts; }).slice(0, opc.ultimas || 25).map(function (x) {
      return { protocolo: x.protocolo, data: fmtData(x.dia), hora: fmtHora(x.min), ts: x.ts, os: x.os, operacao: x.operacao, cpt: x.cpt, desenho: x.desenho, posicao: x.posicao, cj: x.cj, elemento: x.elemento, bitola: x.bitola, comp: x.comp, barras: x.barras, kg: x.kg, local: x.patio + ' · ' + x.local, obs: x.obs };
    });

    return {
      janela: { ini: lim.ini, fim: lim.fim, iniTxt: fmtData(lim.ini), fimTxt: fmtData(lim.fim), trocado: lim.trocado },
      kpis: kpis, porElemento: porElemento, topElementos: porElemento.slice(0, 8), topDesenhos: porDesenho.slice(0, 10), porBitola: porBitola,
      bitolas: bits, serie: serieDias(E, lim.fim, opc.janela || 7, lim.ini), matriz: matriz, matrizTotais: totM, matrizTotal: totG,
      onde: onde, saldoLocal: saldoLocal, resumoDesenhos: resumo,
      semDesenho: { etiquetas: semDesenho.length, t: somar(semDesenho, function (x) { return x.kg; }) / 1000, saldoT: (semDesenhoTot.ent.kg - semDesenhoTot.ret.kg) / 1000 }, ultimas: ultimas, opcoes: opcoesAco(ap), totalAcoPronto: ap.length
    };
  }
  function opcoesAco(ap) {
    function uniq(f2) { return ordenaMisto(distintos(ap, f2)); }
    var pat = PATIOS.slice();
    ap.forEach(function (x) { if (x.patio && pat.indexOf(x.patio) < 0) pat.push(x.patio); });
    return {
      patios: ['Todos os pátios'].concat(pat.sort(cmpTxt)), operacoes: ['Todas', 'Entrada', 'Retirada'], periodos: PERIODOS.slice(),
      elementos: ['Todos'].concat(uniq(function (x) { return x.elemento; })), desenhos: ['Todos'].concat(uniq(function (x) { return x.desenho; })),
      cpts: ['Todos'].concat(uniq(function (x) { return x.cpt; })),
      bitolas: ['Todas'].concat(ap.map(function (x) { return x.bitola; }).filter(function (b, i, a) { return b != null && b > 0 && a.indexOf(b) === i; }).sort(function (a, b) { return a - b; })),
      locais: ['Todos'].concat(uniq(function (x) { return x.local; })), campos: ['Todos os campos'].concat(COLUNAS)
    };
  }

  /* ---------- Etiqueta repetida (aviso no lançamento) ----------
   * Devolve uma chave que identifica a etiqueta física, ou '' quando não há dados suficientes para comparar.
   * A operação entra na chave: a mesma etiqueta pode entrar e depois sair, mas não entrar duas vezes. */
  function chaveEtiqueta(r) {
    var op = str(r.op), prod = str(r.prod || 'aco'), cod = str(r.cod).replace(/[^0-9A-Za-z]/g, '');
    var kg = Math.round(num(r.kg) * 100) / 100;
    var k = function (a) { return a.map(function (x) { return str(x).trim().toUpperCase(); }).join('|'); };
    if (prod === 'barra') {
      if (cod) return k(['B', op, cod, kg]);
      if (str(r.corrida).trim() && str(r.feixe).trim() && kg) return k(['B', op, r.corrida, r.feixe, kg]);
      return '';
    }
    if (prod === 'cord') {
      if (cod) return k(['C', op, cod]);
      if (str(r.material).trim() && str(r.ordem).trim() && kg) return k(['C', op, r.material, r.ordem, kg]);
      return '';
    }
    // Aço pronto: o "código da etiqueta" NÃO é único (nos dados reais um mesmo código aparece em dezenas de etiquetas de desenhos e pesos
    // diferentes), então só é repetida quando TODOS os dados batem, inclusive o CPT/CPM/DF (cada CPT é uma etiqueta/lote diferente, mesmo
    // com desenho, posição, quantidade e peso iguais) e o peso. Sem peso não há como comparar.
    if (!kg) return '';
    if (cod || (str(r.os).trim() && str(r.desenho).trim() && str(r.posicao).trim())) {
      return k(['A', op, cod, r.cpt, r.os, r.desenho, r.posicao, r.cj, num(r.bitola), num(r.comp), num(r.qtd), kg]);
    }
    return '';
  }

  return {
    chaveEtiqueta: chaveEtiqueta,
    COLUNAS: COLUNAS, BITOLAS: BITOLAS, PERIODOS: PERIODOS, normalizar: normalizar, linha: linha, painel: painel, acoPronto: acoPronto,
    ruaPadrao: ruaPadrao, setModoPlanilha: setModoPlanilha, nomeCurto: nomeCurto, fmtNum: fmtNum, fmtData: fmtData, fmtHora: fmtHora, diaDeChave: diaDeChave, chaveDeDia: chaveDeDia
  };
});
