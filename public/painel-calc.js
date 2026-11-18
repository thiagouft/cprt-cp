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
  // Massa linear (kg/m) por bitola do aço (mm), a mesma tabela do cadastro. Peso do aço pronto = comprimento × barras × kg/m.
  var KGM = { '5.0': 0.154, '6.3': 0.245, '8.0': 0.395, '10.0': 0.617, '12.5': 0.963, '16.0': 1.578, '20.0': 2.466, '25.0': 3.853, '32.0': 6.313, '40.0': 9.865 };
  function pesoAco(bitola, compCm, qtd) { // devolve { m, kg, kgm } ou null se faltar dado
    var k = KGM[bitola];
    if (!k || !(compCm > 0) || !(qtd > 0)) return null;
    var m = compCm / 100 * qtd;
    return { m: m, kg: m * k, kgm: k };
  }
  // Diâmetro da cordoalha (mm). A etiqueta imprime 3 casas ("12,700"; "15,701"): aqui o ponto NUNCA é separador de milhar.
  // "12.700" lido como milhar virou 12700 (e 15.200 virou 15200). Valores >= 100 voltam a ser mm (/1000) e tudo vai ao tamanho
  // nominal de 1 casa (12,7 / 15,2 / 15,7), para a mesma cordoalha cair sempre no mesmo grupo. Devolve null se não houver valor.
  function diametroCord(v) {
    if (v == null || str(v).trim() === '') return null;
    var n = typeof v === 'number' ? v : parseFloat(str(v).trim().replace(/\s/g, '').replace(',', '.'));
    if (!isFinite(n) || n <= 0) return null;
    if (n >= 100) n = n / 1000;
    return Math.round(n * 10) / 10;
  }
  /* ---------- Elemento (aço pronto): "LAJE" e "LAJES" são o mesmo elemento ----------
   * A etiqueta imprime o elemento em poucas letras (LAJES, NICHO, LIGAÇ...) e, com a etiqueta gasta ou a IA lendo pela metade, aparecem
   * "LAJE", "TRAV", "SAÍDA" ou o nome inteiro ("LIGAÇÃO"). O padrão é aprendido dos próprios registros: um valor raro vira o valor
   * frequente quando (1) é o começo dele, (2) é o nome inteiro de um padrão de 5 letras ou (3) só difere no acento.
   * Só junta quando há um único candidato claro; na dúvida (ex.: "TRA" serve para TRAVE e TRANS) deixa como está. */
  function chaveElem(v) {
    return str(v).trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
  }
  function mapaElementos(contagens) { // contagens: { NOME: nº de registros }  ->  { CHAVE_SEM_ACENTO: NOME PADRÃO }
    var por = {}, chaves = [], mapa = {};
    Object.keys(contagens || {}).forEach(function (nome) {
      var k = chaveElem(nome), n = Number(contagens[nome]) || 0;
      if (!k) return;
      var g = por[k];
      if (!g) { g = por[k] = { k: k, n: 0, nome: '', nomeN: -1 }; chaves.push(k); }
      g.n += n;
      if (n > g.nomeN) { g.nomeN = n; g.nome = str(nome).trim().toUpperCase(); }   // entre variantes de acento fica a mais usada
    });
    chaves.forEach(function (k) { mapa[k] = por[k].nome; });
    var padroes = chaves.map(function (k) { return por[k]; }).filter(function (h) { return h.n >= 5; });   // candidatos a padrão
    chaves.forEach(function (k) { var p = escolhePadrao(k, por[k].n, padroes); if (p) mapa[k] = p; });
    Object.defineProperty(mapa, '__padroes', { value: padroes, enumerable: false });   // para valores novos, que ainda não estão nas contagens
    // nomes (só letras, 4+) que identificam um elemento padrão, do maior para o menor: servem para achar o elemento colado ao desenho
    var padrao = {};
    padroes.forEach(function (h) { padrao[h.nome] = true; });
    // Nomes só de letras (4+) precisam ser um padrão bem usado. Códigos de letras + número (CA-25, VT.20, PMF3) valem mesmo pouco usados,
    // porque o formato já os identifica; lixo como "FL11NICHO" (número no meio) não entra.
    var nomes = chaves.filter(function (k) { return (/^[A-Z]{4,}$/.test(k) && padrao[mapa[k]]) || /^[A-Z]{2,4}[-.]?[0-9]{1,3}$/.test(k); }).sort(function (a, b) { return b.length - a.length; });
    Object.defineProperty(mapa, '__nomes', { value: nomes, enumerable: false });
    return mapa;
  }
  /* ---------- Desenho com separador variável: "144FL11" e "144/FL11" são o mesmo desenho ----------
   * Desenhos no formato <número><separador opcional>FL<número>[-<n>] (144/FL11, 144FL11, 219-FL10). A IA lê o separador ora com barra,
   * ora com hífen, ora sem nada. Dentro do mesmo número-base, vale o separador mais usado nos registros (empate: com separador, "-" antes de "/").
   * Só mexe nesse formato; "177-2", "BFL2-1" e outros desenhos ficam como vieram. */
  var RE_DES_FL = /^(\d+)([\/-]?)(FL\d+(?:-\d+)?)$/i;
  function mapaDesenhos(contagens) { // contagens: { DESENHO: nº de registros }  ->  { BASE: separador padrão }
    var por = {}, mapa = {};
    Object.keys(contagens || {}).forEach(function (d) {
      var m = RE_DES_FL.exec(str(d).trim());
      if (!m) return;
      por[m[1]] = por[m[1]] || {};
      por[m[1]][m[2]] = (por[m[1]][m[2]] || 0) + (Number(contagens[d]) || 0);
    });
    Object.keys(por).forEach(function (b) {
      var s = Object.keys(por[b]).sort(function (x, y) {
        return (por[b][y] - por[b][x]) || ((x === '' ? 1 : 0) - (y === '' ? 1 : 0)) || (x === '-' ? -1 : y === '-' ? 1 : 0);
      });
      mapa[b] = s[0];
    });
    return mapa;
  }
  function desenhoPadrao(desenho, mapa) {
    var d = str(desenho).trim(), m = RE_DES_FL.exec(d);
    if (!m || !mapa || mapa[m[1]] === undefined) return d;
    return m[1] + mapa[m[1]] + m[3].toUpperCase();
  }
  /* ---------- Sugestão de desenho (impressão sobreposta: "144/FL11" lido como "144FL1") ----------
   * Dado o desenho lido e a lista dos desenhos já registrados ([{d, n}]), devolve até 4 desenhos conhecidos que podem ser o certo:
   * o lido é o começo deles (até 2 caracteres a menos) ou lhes falta um caractere. Só sugere se o lido é pouco usado (menos de 2
   * registros) e só sugere desenhos usados 2 vezes ou mais. A comparação ignora "/", "-" e espaços. */
  function chaveDes(v) { return str(v).trim().toUpperCase().replace(/[\s\/-]/g, ''); }
  function faltaUmChar(longo, curto) {
    if (longo.length !== curto.length + 1) return false;
    for (var i = 0; i < longo.length; i++) if (longo.slice(0, i) + longo.slice(i + 1) === curto) return true;
    return false;
  }
  function desenhosParecidos(valor, conhecidos, max) {
    var x = chaveDes(valor);
    if (x.length < 3 || !conhecidos || !conhecidos.length) return [];
    var por = {};
    conhecidos.forEach(function (c) {
      var k = chaveDes(c.d);
      if (!k) return;
      var n = Number(c.n) || 0, g = por[k] || (por[k] = { d: '', n: 0, melhor: -1 });
      g.n += n;
      if (n > g.melhor) { g.melhor = n; g.d = str(c.d).trim(); }
    });
    if (por[x] && por[x].n >= 2) return [];   // desenho conhecido e usado mais de uma vez
    var cand = [];
    Object.keys(por).forEach(function (k) {
      var h = por[k];
      if (k === x || h.n < 2) return;
      if ((k.indexOf(x) === 0 && k.length - x.length <= 2) || faltaUmChar(k, x)) cand.push(h);
    });
    cand.sort(function (a, b) { return b.n - a.n; });
    return cand.slice(0, max || 4).map(function (h) { return h.d; });
  }
  // Procura um elemento padrão no FIM do texto ("219-FL11NICHO" -> prefixo "219-FL11" + NICHO). O que vem antes tem que terminar em número.
  function fimElemento(texto, mapa) {
    var t = str(texto).trim(), k = chaveElem(t), nomes = (mapa && mapa.__nomes) || [], i, n;
    for (i = 0; i < nomes.length; i++) {
      n = nomes[i];
      if (k.length > n.length && k.slice(-n.length) === n && /[0-9]$/.test(t.slice(0, t.length - n.length))) {
        return { prefixo: t.slice(0, t.length - n.length), nome: mapa[n] };
      }
    }
    return null;
  }
  // Etiqueta com Desenho e Elemento impressos colados: a IA leu "219-FL11NICHO" como desenho (ou "FL11NICHO" como elemento).
  // Devolve o desenho e o elemento já separados e com o elemento padronizado. Se houver conflito (outro elemento já informado), não mexe.
  function separaDesenhoElemento(desenho, elemento, mapa) {
    var d = str(desenho).trim(), e = str(elemento).trim().toUpperCase();
    var fd = fimElemento(d, mapa), fe = fimElemento(e, mapa), ep = elementoPadrao(e, mapa);
    if (fd && (!e || ep === fd.nome || (fe && fe.nome === fd.nome))) {       // elemento colado no fim do desenho
      return { desenho: fd.prefixo, elemento: fd.nome };
    }
    if (!fd && fe && d && d.slice(-fe.prefixo.length).toUpperCase() !== fe.prefixo.toUpperCase()) {  // o início do elemento é o fim do desenho
      return { desenho: d + fe.prefixo, elemento: fe.nome };
    }
    if (fe) return { desenho: d, elemento: fe.nome };                         // elemento com prefixo que já está no desenho
    return { desenho: d, elemento: ep };
  }
  function escolhePadrao(k, n, padroes) { // devolve o nome padrão para a chave k (com n registros), ou '' se não há candidato claro
    var cand = [];
    padroes.forEach(function (h) {
      if (h.k === k || h.n < 3 * n) return;                                              // o padrão tem que ser bem mais usado
      if (k.length >= 3 && h.k.length > k.length && h.k.indexOf(k) === 0) cand.push(h);  // lido pela metade (LAJE -> LAJES)
      else if (k.length > 5 && h.k.length === 5 && k.indexOf(h.k) === 0) cand.push(h);   // nome inteiro (LIGAÇÃO -> LIGAÇ)
    });
    if (!cand.length) return '';
    cand.sort(function (a, b) { return b.n - a.n; });
    if (cand.length > 1 && cand[1].n * 2 > cand[0].n) return '';                         // ambíguo: não mexe
    return cand[0].nome;
  }
  function elementoPadrao(valor, mapa) {
    var v = str(valor).trim().toUpperCase();
    if (!v || !mapa) return v;
    var k = chaveElem(v);
    if (mapa[k]) return mapa[k];
    return (mapa.__padroes && escolhePadrao(k, 0, mapa.__padroes)) || v;   // valor que ainda não existia no banco
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
    var out = [], cont = {}, i, e;
    for (i = 0; i < registros.length; i++) {
      e = registros[i];
      if (e && (e.prod || 'aco') === 'aco' && str(e.elemento).trim()) { var nm = str(e.elemento).trim().toUpperCase(); cont[nm] = (cont[nm] || 0) + 1; }
    }
    var mapa = mapaElementos(cont), cd = {}, s;
    if (!modoPlanilha) {   // desenhos já separados do elemento, para achar o separador mais usado de cada número-base
      for (i = 0; i < registros.length; i++) {
        e = registros[i];
        if (e && (e.prod || 'aco') === 'aco') { s = str(separaDesenhoElemento(e.desenho, e.elemento, mapa).desenho).trim(); if (s) cd[s] = (cd[s] || 0) + 1; }
      }
    }
    var mapaDes = mapaDesenhos(cd);
    for (i = 0; i < registros.length; i++) out.push(linha(registros[i], mapa, mapaDes));
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
  function linha(r, mapaElem, mapaDes) {
    var d = new Date(r.at), cord = r.prod === 'cord';
    var dia = diaNum(d), min = d.getHours() * 60 + d.getMinutes();
    var produto = PRODUTOS[r.prod] || PRODUTOS.aco;
    var bit = cord ? diametroCord(r.bitola) : numOuNull(r.bitola);
    var sep = modoPlanilha ? { desenho: str(r.desenho), elemento: str(r.elemento) }   // modo planilha: textos como vieram (reproduz o Excel)
      : (r.prod || 'aco') === 'aco' ? separaDesenhoElemento(r.desenho, r.elemento, mapaElem) : { desenho: str(r.desenho), elemento: elementoPadrao(r.elemento, mapaElem) };
    if (!modoPlanilha) sep.desenho = desenhoPadrao(sep.desenho, mapaDes);
    var L = {
      id: r.id, protocolo: str(r.protocolo), operacao: OPERACOES[r.op] || str(r.op), patio: str(r.patio), produto: produto,
      dia: dia, min: min, ts: dia * 1440 + min, controlador: str(r.controlador),
      os: str(cord ? r.ordem : r.os), cod: str(r.cod), cpt: str(r.cpt), material: str(r.material), descricao: str(r.descricao || r.marca),
      corrida: str(r.corrida), feixe: str(r.feixe), lote: str(r.lote), desenho: sep.desenho, posicao: str(r.posicao), cj: str(r.cj),
      elemento: sep.elemento, bitola: bit, aco: str(r.aco), comp: numOuNull(r.comp), barras: cord ? 0 : num(r.qtd),
      metros: num(r.m), kg: num(r.kg), pbruto: numOuNull(r.pbruto), torcao: str(r.torcao), resist: str(r.resist), norma: str(r.norma),
      datafab: str(r.datafab), re: str(r.re), placa: str(r.placa), motorista: str(r.motorista), empresa: str(r.empresa), cracha: str(r.cracha),
      destino: str(r.destino), autorizador: str(r.autorizador), obs: str(r.obs),
      nf: (r.tem_nf || r.cargaNf || (r.photos && r.photos.notafiscal && r.photos.notafiscal.data) || r.nf === 'Sim') ? 'Sim' : 'Não'
    };
    L.local = ruaPadrao(L.destino);
    L.carga = str(r.carga);
    L.chaveEst = chaveEtiqueta(Object.assign({}, r, { op: '' })); // identifica a etiqueta física, igual para a entrada e a retirada dela
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
    // Operação = Saldo: só o que entrou e ainda não saiu, por etiqueta (todos os produtos; o casamento é feito antes dos demais filtros)
    var modoSaldo = f.operacao === 'Saldo', est = null, fonte = linhas;
    if (modoSaldo) { est = estoquePorEtiqueta(linhas); fonte = est.lista; }
    for (i = 0; i < fonte.length; i++) {
      L = fonte[i];
      ok = (todos(f.patio, 'Todos os pátios') || igual(L.patio, f.patio)) &&
        (modoSaldo || todos(f.operacao, 'Todas') || igual(L.operacao, f.operacao)) &&
        (todos(f.produto, 'Todos') || igual(L.produto, f.produto)) &&
        buscaOk(L, f.campo, f.busca);
      if (ok) { base.push(L); if (L.dia >= lim.ini && L.dia <= lim.fim) fin.push(L); }
    }
    return { lim: lim, base: base, fin: fin, modoSaldo: modoSaldo, est: est };
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
      opcoes: opcoesPainel(linhas), totalBase: linhas.length, modoSaldo: m.modoSaldo, estoque: m.est && m.est.info
    };
  }
  function opcoesPainel(linhas) {
    var pat = PATIOS.slice(), prod = [], i;
    for (i = 0; i < linhas.length; i++) {
      if (linhas[i].patio && pat.indexOf(linhas[i].patio) < 0) pat.push(linhas[i].patio);
      if (prod.indexOf(linhas[i].produto) < 0) prod.push(linhas[i].produto);
    }
    return {
      patios: ['Todos os pátios'].concat(pat.sort(cmpTxt)), operacoes: ['Todas', 'Entrada', 'Retirada', 'Saldo'],
      produtos: ['Todos'].concat(['Aço pronto', 'Barra reta', 'Cordoalha'].filter(function (p) { return prod.indexOf(p) > -1; })),
      periodos: PERIODOS.slice(), campos: ['Todos os campos'].concat(COLUNAS)
    };
  }

  /* ---------- AÇO PRONTO ---------- */
  // Estoque por etiqueta: em ordem cronológica, cada retirada tira do estoque a entrada MAIS ANTIGA da mesma etiqueta (mesmos dados e peso).
  // Fica em estoque o que entrou e ainda não teve retirada correspondente. Entradas sem dados para identificar a etiqueta (sem chave)
  // são mantidas; retiradas sem entrada correspondente (ou sem chave) são ignoradas e contadas no aviso.
  function estoquePorEtiqueta(ap) {
    var ord = ap.slice().sort(function (a, b) { return a.ts - b.ts; }), fila = {}, i, x, q, semChave = 0, orfas = 0, casadas = 0, fora = {};
    for (i = 0; i < ord.length; i++) {
      x = ord[i];
      if (!x.chaveEst) { if (x.operacao === 'Retirada') orfas++; else if (x.operacao === 'Entrada') semChave++; continue; }
      q = fila[x.chaveEst] || (fila[x.chaveEst] = []);
      if (x.operacao === 'Entrada') q.push(x);
      else if (x.operacao === 'Retirada') { if (q.length) { fora[q.shift().id] = true; casadas++; } else orfas++; }
    }
    return {
      lista: ap.filter(function (y) { return y.operacao === 'Entrada' && !fora[y.id]; }),
      info: { casadas: casadas, retiradasSemEntrada: orfas, entradasSemChave: semChave }
    };
  }
  function acoPronto(linhas, f, hoje, opc) {
    f = f || {}; opc = opc || {};
    var lim = limites(linhas, f, hoje), ap = linhas.filter(function (x) { return x.produto === 'Aço pronto'; }), i, L;
    var modoSaldo = f.operacao === 'Saldo', est = null, base = ap;
    if (modoSaldo) { est = estoquePorEtiqueta(ap); base = est.lista; }
    var E = base.filter(function (L2) {
      return (todos(f.patio, 'Todos os pátios') || igual(L2.patio, f.patio)) &&
        (modoSaldo || todos(f.operacao, 'Todas') || igual(L2.operacao, f.operacao)) &&
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
      semDesenho: { etiquetas: semDesenho.length, t: somar(semDesenho, function (x) { return x.kg; }) / 1000, saldoT: (semDesenhoTot.ent.kg - semDesenhoTot.ret.kg) / 1000 }, ultimas: ultimas, opcoes: opcoesAco(ap), totalAcoPronto: ap.length, modoSaldo: modoSaldo, estoque: est && est.info
    };
  }
  function opcoesAco(ap) {
    function uniq(f2) { return ordenaMisto(distintos(ap, f2)); }
    var pat = PATIOS.slice();
    ap.forEach(function (x) { if (x.patio && pat.indexOf(x.patio) < 0) pat.push(x.patio); });
    return {
      patios: ['Todos os pátios'].concat(pat.sort(cmpTxt)), operacoes: ['Todas', 'Entrada', 'Retirada', 'Saldo'], periodos: PERIODOS.slice(),
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
    chaveEtiqueta: chaveEtiqueta, diametroCord: diametroCord, KGM: KGM, pesoAco: pesoAco, mapaElementos: mapaElementos, elementoPadrao: elementoPadrao, separaDesenhoElemento: separaDesenhoElemento, mapaDesenhos: mapaDesenhos, desenhoPadrao: desenhoPadrao, desenhosParecidos: desenhosParecidos,
    COLUNAS: COLUNAS, BITOLAS: BITOLAS, PERIODOS: PERIODOS, normalizar: normalizar, linha: linha, painel: painel, acoPronto: acoPronto,
    ruaPadrao: ruaPadrao, setModoPlanilha: setModoPlanilha, nomeCurto: nomeCurto, fmtNum: fmtNum, fmtData: fmtData, fmtHora: fmtHora, diaDeChave: diaDeChave, chaveDeDia: chaveDeDia
  };
});
