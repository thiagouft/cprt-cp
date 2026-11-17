/* Corrige o diâmetro (bitola) das cordoalhas gravado como milhar: "12.700" foi lido como 12700, "15.200" como 15200, 15,701 como 15701.
 * O texto certo é o diâmetro em mm no tamanho nominal de 1 casa (12,7 / 15,2 / 15,7), a mesma regra do app (PainelCalc.diametroCord).
 * Só mexe no campo `bitola` de registros do produto cordoalha (prod = 'cord'); fotos e demais campos não são tocados.
 *
 * Uso (sempre rode primeiro SEM --apply: só mostra o que mudaria):
 *   node tools/corrigir-bitola-cordoalha.js            # simulação
 *   node tools/corrigir-bitola-cordoalha.js --apply    # grava (salva um backup dos registros afetados em backups/ antes)
 * Banco: usa DATABASE_URL (ou o padrão do docker-compose).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const PainelCalc = require(path.join(__dirname, '..', 'public', 'painel-calc.js'));

const APPLY = process.argv.includes('--apply');
const DB = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cprt_aco';

(async () => {
  const pool = new Pool({ connectionString: DB, connectionTimeoutMillis: 5000 });
  try {
    const { rows } = await pool.query("SELECT id, protocolo, at, dados FROM registros WHERE prod = 'cord' ORDER BY at");
    const alvo = [], resumo = new Map();
    for (const r of rows) {
      const antigo = r.dados && r.dados.bitola;
      if (antigo == null || antigo === '') continue;
      const novo = PainelCalc.diametroCord(antigo);
      if (novo == null || String(novo) === String(antigo)) continue;
      alvo.push({ id: r.id, protocolo: r.protocolo, at: r.at, antigo, novo, tipo: typeof antigo });
      const k = antigo + '  →  ' + novo;
      resumo.set(k, (resumo.get(k) || 0) + 1);
    }
    console.log('Registros de cordoalha:', rows.length, '| com diâmetro a corrigir:', alvo.length);
    if (alvo.length) {
      console.log('\nTrocas (antes → depois, nº de registros):');
      [...resumo.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log('  ' + String(n).padStart(4) + '×  ' + k));
      console.log('\nRegistros:');
      alvo.forEach(a => console.log('  ' + a.protocolo + '  ' + new Date(a.at).toLocaleString('pt-BR') + '  ' + a.antigo + ' → ' + a.novo));
    }
    if (!alvo.length) { console.log('Nada a corrigir.'); return; }
    if (!APPLY) { console.log('\nSimulação: nada foi gravado. Rode com --apply para gravar (um backup é salvo antes).'); return; }

    fs.mkdirSync(path.join(__dirname, '..', 'backups'), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const arq = path.join(__dirname, '..', 'backups', 'bitola-cordoalha-antes-' + stamp + '.json');
    fs.writeFileSync(arq, JSON.stringify(alvo, null, 1));
    console.log('\nBackup dos registros afetados salvo em', arq);

    const c = await pool.connect();
    let gravados = 0;
    try {
      await c.query('BEGIN');
      for (const a of alvo) {
        // mantém o tipo que o registro já tinha (texto ou número) e só troca se o valor ainda é o que lemos
        const valor = JSON.stringify(a.tipo === 'number' ? a.novo : String(a.novo));
        const r = await c.query("UPDATE registros SET dados = jsonb_set(dados, '{bitola}', $2::jsonb) WHERE id = $1 AND dados->'bitola' = $3::jsonb", [a.id, valor, JSON.stringify(a.antigo)]);
        gravados += r.rowCount;
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    console.log('Gravado:', gravados, 'de', alvo.length, 'registros corrigidos.');
    const ainda = await pool.query("SELECT count(*) n FROM registros WHERE prod = 'cord' AND dados->>'bitola' ~ '^[0-9]+(\\.[0-9]+)?$' AND (dados->>'bitola')::numeric >= 100");
    console.log('Cordoalhas que ainda têm diâmetro >= 100:', ainda.rows[0].n);
  } finally { await pool.end(); }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
