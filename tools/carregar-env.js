/* Lê o .env da raiz do projeto (mesma regra do server.js), para os scripts de tools/ usarem o mesmo DATABASE_URL do servidor.
 * Variáveis já definidas no ambiente têm prioridade. */
'use strict';
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const i = t.indexOf('=');
    if (i > 0) {
      const k = t.slice(0, i).trim(), v = t.slice(i + 1).trim().replace(/^['"](.*)['"]$/, '$1');
      if (!process.env[k]) process.env[k] = v;
    }
  });
}
