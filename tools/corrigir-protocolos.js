/* Corrige protocolos repetidos que já existem no banco (ex.: dois registros com ENT-20261105-0021).
 *
 * Regra: em cada grupo de protocolos iguais, o registro MAIS ANTIGO mantém o número; os demais recebem o próximo
 * número livre do mesmo tipo e dia (ENT|RET-AAAAMMDD-NNNN). Nada mais é alterado.
 * Atenção: comprovantes já emitidos para os registros renumerados continuam com o número antigo.
 *
 * Uso (rode primeiro SEM --apply: só mostra o que mudaria):
 *   node tools/corrigir-protocolos.js              # simulação
 *   node tools/corrigir-protocolos.js --apply      # grava (salva a lista antigo -> novo em backups/ antes)
 * Banco: usa DATABASE_URL (ou o padrão do docker-compose).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cprt_aco';

(async () => {
  const pool = new Pool({ connectionString: DB, connectionTimeoutMillis: 5000 });
  try {
    const { rows } = await pool.query('SELECT id, protocolo, op, at FROM registros ORDER BY at ASC, id ASC');
    const grupos = new Map();
    rows.forEach(r => { if (!grupos.has(r.protocolo)) grupos.set(r.protocolo, []); grupos.get(r.protocolo).push(r); });

    // maior número usado por tipo+dia
    const maximo = new Map();
    const partes = p => /^(ENT|RET)-(\d{8})-(\d+)$/.exec(String(p));
    rows.forEach(r => { const m = partes(r.protocolo); if (m) { const k = m[1] + '-' + m[2]; maximo.set(k, Math.max(maximo.get(k) || 0, parseInt(m[3], 10))); } });

    const trocas = [];
    for (const [proto, lista] of grupos) {
      if (lista.length < 2) continue;
      const m = partes(proto);
      const pre = m ? m[1] : (lista[0].op === 'ret' ? 'RET' : 'ENT');
      const dia = m ? m[2] : new Date(lista[0].at).toISOString().slice(0, 10).replace(/-/g, '');
      const k = pre + '-' + dia;
      lista.slice(1).forEach(r => {
        const n = (maximo.get(k) || 0) + 1; maximo.set(k, n);
        trocas.push({ id: r.id, em: r.at.toISOString(), antigo: proto, novo: pre + '-' + dia + '-' + String(n).padStart(4, '0') });
      });
    }

    const repetidos = [...grupos.values()].filter(l => l.length > 1).length;
    console.log('Registros:', rows.length, '| protocolos repetidos (grupos):', repetidos, '| registros a renumerar:', trocas.length);
    trocas.slice(0, 40).forEach(t => console.log('  ' + t.antigo + '  →  ' + t.novo + '   (' + t.em.slice(0, 16).replace('T', ' ') + ')'));
    if (trocas.length > 40) console.log('  … e mais ' + (trocas.length - 40));
    if (!trocas.length) { console.log('Nada a corrigir.'); return; }
    if (!APPLY) { console.log('\nSimulação: nada foi gravado. Rode com --apply para gravar.'); return; }

    fs.mkdirSync(path.join(__dirname, '..', 'backups'), { recursive: true });
    const arq = path.join(__dirname, '..', 'backups', 'protocolos-antes-da-correcao-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json');
    fs.writeFileSync(arq, JSON.stringify(trocas, null, 1));
    console.log('\nLista antigo → novo salva em', arq);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['corrigir-protocolos']);
      for (const t of trocas) await c.query('UPDATE registros SET protocolo = $2 WHERE id = $1', [t.id, t.novo]);
      await c.query('COMMIT');
      console.log('Gravado:', trocas.length, 'registros renumerados.');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    const depois = await pool.query('SELECT count(*) n FROM (SELECT protocolo FROM registros GROUP BY protocolo HAVING count(*) > 1) x');
    console.log('Protocolos ainda repetidos:', depois.rows[0].n);
  } finally { await pool.end(); }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
