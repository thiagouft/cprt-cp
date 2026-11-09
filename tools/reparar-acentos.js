/* Repara textos com acento perdido ("S??o F??lix" -> "São Félix") nos registros do banco.
 *
 * Causa: uma carga de dados que passou por um canal que não era UTF-8 trocou cada caractere acentuado (2 bytes) por "??".
 * Como recuperar: o texto certo é aprendido (1) do Dash.xlsx exportado por tests/export_dash.py, quando existir,
 * (2) de um dicionário de palavras do domínio e (3) de regras do português para o que sobrar.
 *
 * Uso (sempre rode primeiro SEM --apply: só mostra o que mudaria):
 *   node tools/reparar-acentos.js                    # simulação
 *   node tools/reparar-acentos.js --apply            # grava (faz backup antes em backups/)
 * Banco: usa DATABASE_URL (ou o padrão do docker-compose).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cprt_aco';
const GOLDEN = path.join(__dirname, '..', 'tests', 'fixtures', 'dash-golden.json');

const nonAscii = /[^\x00-\x7f]/g;
const dano = s => String(s).replace(nonAscii, '??');          // como o texto fica depois do estrago
const temDano = s => typeof s === 'string' && s.indexOf('??') > -1;

/* ---- 1) dicionário aprendido do Excel (texto certo) e palavras do domínio ---- */
const votos = new Map();            // forma danificada -> Map(correto -> votos)
function aprende(correto) {
  if (typeof correto !== 'string' || !nonAscii.test(correto)) { nonAscii.lastIndex = 0; return; }
  nonAscii.lastIndex = 0;
  const add = c => { const d = dano(c); if (!votos.has(d)) votos.set(d, new Map()); const m = votos.get(d); m.set(c, (m.get(c) || 0) + 1); };
  add(correto);
  correto.split(/([\s\-\/·,.;:()]+)/).forEach(t => { if (nonAscii.test(t)) add(t); nonAscii.lastIndex = 0; });
}
if (fs.existsSync(GOLDEN)) {
  const g = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  g.rows.forEach(r => r.forEach(v => { if (typeof v === 'string') aprende(v); }));
}
// palavras e nomes que já aparecem no sistema (maiúsculas e minúsculas)
['São Félix', 'Marabá', 'Pátio', 'Pátio de Ferragens', 'Consórcio', 'CONSÓRCIO', 'Conceição', 'CONCEIÇÃO', 'César', 'Sílvio', 'Antônio', 'João', 'José', 'Maria',
  'ARMAÇÃO', 'Armação', 'ARM.', 'LIGAÇÃO', 'LIGAÇ', 'MÓDULO', 'REVISÃO', 'ARMAÇÕES', 'ESTRUTURA', 'Ferragens', 'Estação', 'Rodrigues', 'Gonçalves', 'Araújo', 'Antonio', 'Jesus',
  'Observações', 'Descrição', 'Transversina', 'TRANSVERSINA', 'Código', 'Nº', 'ÁGUA', 'Água', 'SÃO', 'FÉLIX', 'MARABÁ', 'PÁTIO', 'CENTRAL DE ARMAÇÃO', 'Central de armação']
  .forEach(aprende);
const melhor = d => { const m = votos.get(d); if (!m) return null; return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]; };

/* ---- 3) regras do português para o que o dicionário não resolve ---- */
function regra(tok) {
  const up = tok === tok.toUpperCase() && /[A-Z]/.test(tok);
  let t = tok;
  const R = up ? [[/\?\?\?\?ES\b/g, 'ÇÕES'], [/\?\?\?\?O\b/g, 'ÇÃO'], [/\?\?O\b/g, 'ÃO'], [/\?\?ES\b/g, 'ÕES'], [/\?\?\?\?/g, 'ÇÃ'], [/I\?\?\b/g, 'IÇ'], [/\?\?\b/g, 'Á']]
    : [[/\?\?\?\?es\b/g, 'ções'], [/\?\?\?\?o\b/g, 'ção'], [/\?\?o\b/g, 'ão'], [/\?\?es\b/g, 'ões'], [/\?\?\?\?/g, 'çã'], [/i\?\?\b/g, 'iç'], [/\?\?\b/g, 'á']];
  R.forEach(([re, to]) => { t = t.replace(re, to); });
  return t.indexOf('??') > -1 ? null : t;
}
const naoResolvidos = new Map();
function conserta(s) {
  if (!temDano(s)) return s;
  const inteiro = melhor(s.toLowerCase() === s ? s : s);   // cadeia completa
  if (inteiro) return inteiro;
  return s.split(/([\s\-\/·,.;:()]+)/).map(tok => {
    if (!temDano(tok)) return tok;
    const m = melhor(tok); if (m) return m;
    const r = regra(tok); if (r) return r;
    naoResolvidos.set(tok, (naoResolvidos.get(tok) || 0) + 1);
    return tok;
  }).join('');
}
function consertaDeep(v) {
  if (typeof v === 'string') return conserta(v);
  if (Array.isArray(v)) return v.map(consertaDeep);
  if (v && typeof v === 'object') { const o = {}; Object.keys(v).forEach(k => { o[k] = consertaDeep(v[k]); }); return o; }
  return v;
}

(async () => {
  const pool = new Pool({ connectionString: DB, connectionTimeoutMillis: 5000 });
  try {
    const { rows } = await pool.query('SELECT id, protocolo, op, at, controlador, patio, prod, dados, photos, usuario_id, created_at FROM registros ORDER BY at');
    const mudancas = new Map(); const alvo = [];
    for (const r of rows) {
      const novo = { controlador: conserta(r.controlador), patio: conserta(r.patio), protocolo: conserta(r.protocolo), dados: consertaDeep(r.dados) };
      const alterou = novo.controlador !== r.controlador || novo.patio !== r.patio || novo.protocolo !== r.protocolo || JSON.stringify(novo.dados) !== JSON.stringify(r.dados);
      if (alterou) alvo.push({ id: r.id, ...novo });
      const regs = (a, b) => { if (a !== b && temDano(String(a))) { const k = a + '  →  ' + b; mudancas.set(k, (mudancas.get(k) || 0) + 1); } };
      regs(r.controlador, novo.controlador); regs(r.patio, novo.patio);
      Object.keys(r.dados || {}).forEach(k => regs(r.dados[k], novo.dados[k]));
    }
    console.log('Registros no banco:', rows.length, '| com texto a corrigir:', alvo.length);
    console.log('\nTrocas (antes → depois, nº de ocorrências):');
    [...mudancas.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log('  ' + String(n).padStart(4) + '×  ' + k));
    if (naoResolvidos.size) { console.log('\n⚠ Sem correção segura (ficam como estão — revise à mão):'); [...naoResolvidos.entries()].forEach(([k, n]) => console.log('  ' + n + '×  ' + k)); }
    if (!APPLY) { console.log('\nSimulação: nada foi gravado. Rode com --apply para gravar (um backup é salvo antes).'); return; }

    fs.mkdirSync(path.join(__dirname, '..', 'backups'), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const arq = path.join(__dirname, '..', 'backups', 'registros-antes-do-reparo-' + stamp + '.json');
    fs.writeFileSync(arq, JSON.stringify(rows));
    console.log('\nBackup salvo em', arq);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const a of alvo) await c.query('UPDATE registros SET controlador=$2, patio=$3, protocolo=$4, dados=$5 WHERE id=$1', [a.id, a.controlador, a.patio, a.protocolo, JSON.stringify(a.dados)]);
      await c.query('COMMIT');
      console.log('Gravado:', alvo.length, 'registros corrigidos.');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    const ainda = await pool.query("SELECT count(*) n FROM registros WHERE patio LIKE '%??%' OR controlador LIKE '%??%' OR dados::text LIKE '%??%'");
    console.log('Registros que ainda têm "??":', ainda.rows[0].n);
  } finally { await pool.end(); }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
