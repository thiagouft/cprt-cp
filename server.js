'use strict';
/**
 * Servidor do Controle de Aço CPRT.
 * - Serve o app (pasta public/).
 * - Autenticação de usuários (admin / admin padrão).
 * - Banco de dados PostgreSQL (postgres:17).
 * - POST /api/ler: recebe uma foto, pede à API da Anthropic para ler os dados e devolve JSON.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const PainelCalc = require(path.join(__dirname, 'public', 'painel-calc.js')); // mesma regra de etiqueta repetida do app

// Carregar arquivo .env automaticamente caso exista
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"](.*)['"]$/, '$1');
      if (!process.env[key]) process.env[key] = val;
    }
  });
}

const PORT = Number(process.env.PORT || 3334);
const KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const BASE = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
const TOKEN = process.env.APP_TOKEN || '';
const LIMITE_POR_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 40);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MAX_BODY = 15 * 1024 * 1024; // 15MB para permitir uploads de registros com 3 fotos
const PUBLIC = path.join(__dirname, 'public');
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cprt_aco';

// Configuração do PostgreSQL
const pool = new Pool({
  connectionString: DATABASE_URL,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  console.error('Erro inesperado no cliente PostgreSQL:', err.message);
});

// Funções de Criptografia para Senha
function hashSenha(senha, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
  return { hash, salt };
}

function validaSenha(senha, hashEsperado, salt) {
  try {
    const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hashEsperado));
  } catch (e) {
    return false;
  }
}

// Inicialização do Banco de Dados
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        login VARCHAR(100) UNIQUE NOT NULL,
        senha_hash VARCHAR(255) NOT NULL,
        salt VARCHAR(64) NOT NULL,
        role VARCHAR(50) DEFAULT 'user',
        trocar_senha BOOLEAN DEFAULT FALSE,
        pode_excluir BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS trocar_senha BOOLEAN DEFAULT FALSE;
      ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS pode_excluir BOOLEAN DEFAULT FALSE;
      ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS pode_gerenciar_usuarios BOOLEAN DEFAULT FALSE;
      ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS pode_ver_painel BOOLEAN DEFAULT FALSE;
      UPDATE usuarios SET pode_excluir = TRUE, pode_gerenciar_usuarios = TRUE, pode_ver_painel = TRUE WHERE login = 'admin' OR role = 'admin';

      CREATE TABLE IF NOT EXISTS sessoes (
        token VARCHAR(128) PRIMARY KEY,
        usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS registros (
        id VARCHAR(100) PRIMARY KEY,
        protocolo VARCHAR(100) NOT NULL,
        op VARCHAR(50) NOT NULL,
        at TIMESTAMP WITH TIME ZONE NOT NULL,
        controlador VARCHAR(255),
        patio VARCHAR(100),
        prod VARCHAR(50),
        dados JSONB NOT NULL,
        photos JSONB,
        usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // Criar usuário admin inicial se não existir
    const checkAdmin = await pool.query('SELECT id FROM usuarios WHERE login = $1', ['admin']);
    if (checkAdmin.rows.length === 0) {
      const { hash, salt } = hashSenha('admin');
      await pool.query(
        'INSERT INTO usuarios (nome, login, senha_hash, salt, role) VALUES ($1, $2, $3, $4, $5)',
        ['Administrador', 'admin', hash, salt, 'admin']
      );
      console.log('✓ Usuário padrão criado: login "admin", senha "admin"');
    }
    console.log('✓ Banco de dados PostgreSQL conectado e tabelas sincronizadas.');
  } catch (err) {
    console.warn('Aviso ao inicializar PostgreSQL:', err.message);
  }
}

// Obter usuário autenticado pela requisição
async function getAuthUser(req) {
  const auth = String(req.headers['authorization'] || '');
  let token = '';
  if (auth.startsWith('Bearer ')) token = auth.slice(7).trim();
  else if (req.headers['x-session-token']) token = String(req.headers['x-session-token']).trim();
  if (!token) return null;

  try {
    const r = await pool.query(
      `SELECT u.id, u.nome, u.login, u.role, u.trocar_senha, u.pode_excluir, u.pode_gerenciar_usuarios, u.pode_ver_painel
       FROM sessoes s
       JOIN usuarios u ON u.id = s.usuario_id 
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token]
    );
    return r.rows[0] || null;
  } catch (e) {
    return null;
  }
}

// Prompts para a IA
const PROMPTS = {
  etiqueta: "A imagem é uma etiqueta de material de obra. Primeiro identifique o tipo e devolva na chave tipo: \"aco\" para etiqueta de aço pronto cortado e dobrado (campos Desenho, Posição, Elemento, Comp. Unit., Bitola, Tipo de Aço CA-50, Conteúdo, CJ, O.S., código CPT/CPM); \"barra\" para etiqueta de barra reta de aço de siderúrgica (ex. ArcelorMittal, Gerdau), com marca, bitola em MM, comprimento em m, categoria CA25/CA50/CA60, norma ABNT NBR 7480, Corrida, Feixe, Material e Peso Líquido; \"cordoalha\" para etiqueta de cordoalha de aço de protensão (campos Material, Descrição CORD 7 FIOS, Aço, Diâmetro, Norma, Ordem de Produção, Sentido de Torção, Resistência, Peso Bruto, Peso Líquido, Metragem, Data). Leia só o que estiver legível, não invente, e ignore qualquer faixa ou carimbo de data, hora e endereço sobreposto na foto (mesmo de cabeça para baixo). Os números seguem o padrão brasileiro: ponto separa milhar e vírgula separa decimais (2.912 kg = 2912; 12,700 mm = 12.7; 20,00MM = 20). Devolva números simples, sem unidade. Responda apenas com um objeto JSON. Para aço pronto: os (número da O.S., só dígitos, string), cod (número do código após \"Nº\", só dígitos, string), cpt (código grande em destaque na etiqueta que começa com CPT, CTP, CPM ou DF, ex. CPT25R ou DF301C, pode estar na vertical perto do código de barras, sem espaços, string), desenho (string), posicao (string), elemento (string, ex. PILAR), cj (string), bitola (número em mm, ex. 16.0), aco (string, ex. CA-50S), comp (comprimento unitário em cm, número), qtd (campo Conteúdo, quantidade de barras, número inteiro), obs (texto da observação, ex. PILARES P2,P3,P14 E P15 (x4)). Para barra reta: marca (texto de marca e produto, ex. ArcelorMittal 50 S), bitola (mm, número), comprimento (em metros, número), categoria (ex. CA50), norma (ex. ABNT NBR 7480/2024), corrida (ex. 27602/82), feixe (string, ex. 017), material (só dígitos, string), pliq (peso líquido em kg, número), lote (código impresso perto do fabricante, ex. PITL2 160420261903, se houver), cod (número do código de barras impresso, só dígitos). Para cordoalha: material (só dígitos, string), descricao (string), classe (campo \"Aço\", ex. BL82, string), diametro (mm, número), norma (string), ordem (Ordem de Produção, só dígitos, string), torcao (\"DIREITA\" ou \"ESQUERDA\"), resist (texto, ex. 190 kgf/mm²), pbruto (peso bruto em kg, número), pliq (peso líquido em kg, número), espessura (texto), metragem (em metros, número), re (dígitos do campo RE, só se legível), datafab (dd/mm/aaaa), cod (número do código de barras impresso, só dígitos). Use null para o que não se aplica ao tipo ou não estiver legível.",
  placa: 'A imagem mostra a placa de um veículo brasileiro (padrão Mercosul ou antigo). Ignore qualquer faixa de data e hora sobreposta na parte de baixo. Responda apenas com um objeto JSON {"placa": "ABC1D23"} com 7 caracteres, maiúsculas, sem hífen nem espaço. Use null se não estiver legível. Não invente.',
  cracha: 'A imagem mostra um documento de identificação do motorista: pode ser um crachá de identificação de obra ou empresa, uma CNH (Carteira Nacional de Habilitação) ou um RG (Carteira de Identidade). Ignore qualquer faixa ou carimbo de data, hora e endereço sobreposto na foto. Identifique o tipo de documento e siga rigorosamente estas regras: 1) Se for RG: localize o campo rotulado como "REGISTRO GERAL" (atenção: não pegue CPF nem outros números, pegue exatamente o número do campo REGISTRO GERAL, ex: "019365302001-9") e coloque na chave "registro_geral" e também na chave "cracha". Extraia o nome completo do campo NOME na chave "motorista". Coloque "empresa": null e "tipo_doc": "rg". 2) Se for CNH: localize o campo rotulado como "Nº REGISTRO" ou "5 Nº REGISTRO" (número de registro da CNH em destaque/vermelho, normalmente 11 dígitos; atenção: não pegue CPF nem Doc. Identidade) e coloque na chave "num_registro" e também na chave "cracha". Extraia o nome completo do campo NOME na chave "motorista". Coloque "empresa": null e "tipo_doc": "cnh". 3) Se for Crachá de obra ou empresa: extraia o nome completo na chave "motorista", o nome da empresa ou consórcio na chave "empresa", o número da matrícula ou do crachá na chave "cracha", e "tipo_doc": "cracha". Responda APENAS com um objeto JSON contendo as chaves: tipo_doc ("rg", "cnh" ou "cracha"), motorista (string ou null), empresa (string ou null), cracha (string ou null), registro_geral (string ou null), num_registro (string ou null). Use null para o que não estiver legível ou não constar. Não invente nada.'
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon', '.css': 'text/css; charset=utf-8'
};

const hits = new Map();
function limitado(ip) {
  const agora = Date.now(), lista = (hits.get(ip) || []).filter(t => agora - t < 60000);
  lista.push(agora); hits.set(ip, lista);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => agora - t < 60000)) hits.delete(k);
  return lista.length > LIMITE_POR_MIN;
}
function ipDe(req) {
  if (TRUST_PROXY) { const x = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (x) return x; }
  return req.socket.remoteAddress || '?';
}
function tokenOk(req) {
  if (!TOKEN) return true;
  const a = Buffer.from(String(req.headers['x-app-token'] || '')), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const partes = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(new Error('grande'), { status: 413 })); req.destroy(); } else partes.push(c); });
    req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    req.on('error', reject);
  });
}
function extrairJson(texto) {
  const i = texto.indexOf('{'), f = texto.lastIndexOf('}');
  if (i < 0 || f <= i) throw new Error('sem JSON');
  return JSON.parse(texto.slice(i, f + 1));
}

// Leitura de fotos com a Anthropic
async function ler(req, res, user) {
  if (!KEY) return json(res, 503, { erro: 'Servidor sem ANTHROPIC_API_KEY configurada.' });
  if (!user && !tokenOk(req)) return json(res, 401, { erro: 'Acesso não autorizado.' });
  if (limitado(ipDe(req))) return json(res, 429, { erro: 'Muitas leituras em pouco tempo. Aguarde um minuto.' });
  
  let dados;
  try { dados = JSON.parse(await lerCorpo(req)); }
  catch (e) { return json(res, e.status || 400, { erro: e.status === 413 ? 'Imagem grande demais.' : 'Requisição inválida.' }); }

  const prompt = PROMPTS[dados && dados.tipo];
  const img = dados && typeof dados.imagem === 'string' ? dados.imagem : '';
  if (!prompt || !/^[A-Za-z0-9+/=]+$/.test(img) || img.length < 100) return json(res, 400, { erro: 'Requisição inválida.' });

  try {
    const r = await fetch(BASE + '/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 700,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img } },
          { type: 'text', text: prompt }
        ] }]
      }),
      signal: AbortSignal.timeout(45000)
    });
    if (!r.ok) { console.error('Anthropic HTTP', r.status, (await r.text()).slice(0, 300)); return json(res, 502, { erro: 'A leitura falhou no provedor.' }); }
    const out = await r.json();
    const texto = (out.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    let parsed;
    try { parsed = extrairJson(texto); }
    catch (e) {
      // Diagnóstico: o que a IA respondeu no lugar do JSON (foto ruim? recusa? resposta vazia?)
      e.detalhe = 'tipo=' + dados.tipo + ' | stop_reason=' + (out.stop_reason || '?') + ' | foto=' + Math.round(img.length * 0.75 / 1024) + 'KB | resposta=' + JSON.stringify(texto.slice(0, 150));
      throw e;
    }
    if (dados && dados.tipo === 'cracha' && parsed && typeof parsed === 'object') {
      if (parsed.tipo_doc === 'rg' || parsed.registro_geral) {
        parsed.cracha = parsed.registro_geral || parsed.cracha || null;
      } else if (parsed.tipo_doc === 'cnh' || parsed.num_registro) {
        parsed.cracha = parsed.num_registro || parsed.cracha || null;
      }
    }
    return json(res, 200, { dados: parsed });
  } catch (e) {
    console.error('Falha na leitura:', e.message, e.detalhe ? '| ' + e.detalhe : '| tipo=' + (dados && dados.tipo));
    return json(res, 502, { erro: 'Não foi possível ler a foto.' });
  }
}

// Handlers de Autenticação e Usuários
async function authLogin(req, res) {
  let body;
  try { body = JSON.parse(await lerCorpo(req)); } catch (e) { return json(res, 400, { erro: 'Dados inválidos.' }); }
  const login = String(body.login || '').trim().toLowerCase();
  const senha = String(body.senha || '');

  if (!login || !senha) return json(res, 400, { erro: 'Informe login e senha.' });

  try {
    const r = await pool.query('SELECT * FROM usuarios WHERE LOWER(login) = $1', [login]);
    const usuario = r.rows[0];
    if (!usuario || !validaSenha(senha, usuario.senha_hash, usuario.salt)) {
      return json(res, 401, { erro: 'Login ou senha incorretos.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 dias

    await pool.query(
      'INSERT INTO sessoes (token, usuario_id, expires_at) VALUES ($1, $2, $3)',
      [token, usuario.id, expiresAt]
    );

    const podeExcluir = !!usuario.pode_excluir || usuario.role === 'admin' || usuario.login === 'admin';
    const podeGerenciar = !!usuario.pode_gerenciar_usuarios || usuario.role === 'admin' || usuario.login === 'admin';
    const podePainel = podeVerPainel(usuario);
    return json(res, 200, {
      ok: true,
      token,
      trocar_senha: !!usuario.trocar_senha,
      usuario: { id: usuario.id, nome: usuario.nome, login: usuario.login, role: usuario.role, trocar_senha: !!usuario.trocar_senha, pode_excluir: podeExcluir, pode_gerenciar_usuarios: podeGerenciar, pode_ver_painel: podePainel }
    });
  } catch (e) {
    console.error('Erro no login:', e);
    return json(res, 500, { erro: 'Erro interno ao realizar login.' });
  }
}

async function authMudarSenha(req, res, user) {
  if (!user) return json(res, 401, { erro: 'Não autenticado.' });
  let body;
  try { body = JSON.parse(await lerCorpo(req)); } catch (e) { return json(res, 400, { erro: 'Dados inválidos.' }); }
  const novaSenha = String(body.nova_senha || '');

  if (!novaSenha || novaSenha.length < 4) {
    return json(res, 400, { erro: 'A nova senha deve ter no mínimo 4 caracteres.' });
  }

  try {
    const { hash, salt } = hashSenha(novaSenha);
    await pool.query(
      'UPDATE usuarios SET senha_hash = $1, salt = $2, trocar_senha = FALSE WHERE id = $3',
      [hash, salt, user.id]
    );
    return json(res, 200, { ok: true, mensagem: 'Senha alterada com sucesso!' });
  } catch (e) {
    console.error('Erro ao mudar senha:', e);
    return json(res, 500, { erro: 'Erro interno ao alterar senha.' });
  }
}

async function authLogout(req, res) {
  const auth = String(req.headers['authorization'] || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : String(req.headers['x-session-token'] || '').trim();
  if (token) {
    try { await pool.query('DELETE FROM sessoes WHERE token = $1', [token]); } catch (e) {}
  }
  return json(res, 200, { ok: true });
}

async function authMe(req, res, user) {
  if (!user) return json(res, 401, { erro: 'Não autenticado.' });
  const podeExcluir = !!user.pode_excluir || user.role === 'admin' || user.login === 'admin';
  const podeGerenciar = !!user.pode_gerenciar_usuarios || user.role === 'admin' || user.login === 'admin';
  return json(res, 200, {
    ok: true,
    usuario: {
      id: user.id,
      nome: user.nome,
      login: user.login,
      role: user.role,
      trocar_senha: !!user.trocar_senha,
      pode_excluir: podeExcluir,
      pode_gerenciar_usuarios: podeGerenciar,
      pode_ver_painel: podeVerPainel(user)
    }
  });
}

async function listarUsuarios(req, res, user) {
  if (!user) return json(res, 401, { erro: 'Não autenticado.' });
  if (user.role !== 'admin' && user.login !== 'admin' && !user.pode_gerenciar_usuarios) {
    return json(res, 403, { erro: 'Sem permissão para gerenciar usuários.' });
  }
  try {
    const r = await pool.query('SELECT id, nome, login, role, trocar_senha, pode_excluir, pode_gerenciar_usuarios, pode_ver_painel, created_at FROM usuarios ORDER BY id ASC');
    return json(res, 200, { ok: true, usuarios: r.rows });
  } catch (e) {
    return json(res, 500, { erro: 'Erro ao buscar usuários.' });
  }
}

async function criarUsuario(req, res, user) {
  if (!user) return json(res, 401, { erro: 'Não autenticado.' });
  if (user.role !== 'admin' && user.login !== 'admin' && !user.pode_gerenciar_usuarios) {
    return json(res, 403, { erro: 'Apenas administradores podem cadastrar novos usuários.' });
  }
  let body;
  try { body = JSON.parse(await lerCorpo(req)); } catch (e) { return json(res, 400, { erro: 'Dados inválidos.' }); }

  const nome = String(body.nome || '').trim();
  const login = String(body.login || '').trim().toLowerCase();
  const senha = String(body.senha || '');
  const role = body.role === 'admin' ? 'admin' : 'user';
  const podeExcluir = !!body.pode_excluir;
  const podeGerenciar = !!body.pode_gerenciar_usuarios;
  const podePainel = !!body.pode_ver_painel || role === 'admin';

  if (!nome || !login || !senha) {
    return json(res, 400, { erro: 'Preencha Nome, Login e Senha.' });
  }
  if (login.length < 3) return json(res, 400, { erro: 'O login deve ter pelo menos 3 caracteres.' });
  if (senha.length < 4) return json(res, 400, { erro: 'A senha deve ter pelo menos 4 caracteres.' });

  try {
    const existe = await pool.query('SELECT id FROM usuarios WHERE LOWER(login) = $1', [login]);
    if (existe.rows.length > 0) return json(res, 400, { erro: 'Este login já está cadastrado.' });

    const { hash, salt } = hashSenha(senha);
    const r = await pool.query(
      'INSERT INTO usuarios (nome, login, senha_hash, salt, role, trocar_senha, pode_excluir, pode_gerenciar_usuarios, pode_ver_painel) VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7, $8) RETURNING id, nome, login, role, trocar_senha, pode_excluir, pode_gerenciar_usuarios, pode_ver_painel, created_at',
      [nome, login, hash, salt, role, podeExcluir, podeGerenciar, podePainel]
    );

    return json(res, 201, { ok: true, usuario: r.rows[0] });
  } catch (e) {
    console.error('Erro ao criar usuário:', e);
    return json(res, 500, { erro: 'Erro interno ao criar usuário.' });
  }
}

async function atualizarPermissaoUsuario(req, res, user, id) {
  if (!user) return json(res, 401, { erro: 'Não autenticado.' });
  if (user.role !== 'admin' && user.login !== 'admin' && !user.pode_gerenciar_usuarios) {
    return json(res, 403, { erro: 'Apenas administradores podem alterar permissões.' });
  }
  let body;
  try { body = JSON.parse(await lerCorpo(req)); } catch (e) { return json(res, 400, { erro: 'Dados inválidos.' }); }

  try {
    const target = await pool.query('SELECT login FROM usuarios WHERE id = $1', [id]);
    if (target.rows.length === 0) return json(res, 404, { erro: 'Usuário não encontrado.' });
    if (target.rows[0].login === 'admin') {
      return json(res, 400, { erro: 'As permissões do administrador principal não podem ser alteradas.' });
    }

    const updates = [];
    const values = [];
    let idx = 1;

    if (body.pode_excluir !== undefined) {
      updates.push(`pode_excluir = $${idx++}`);
      values.push(!!body.pode_excluir);
    }
    if (body.pode_gerenciar_usuarios !== undefined) {
      updates.push(`pode_gerenciar_usuarios = $${idx++}`);
      values.push(!!body.pode_gerenciar_usuarios);
    }

    if (body.pode_ver_painel !== undefined) {
      updates.push(`pode_ver_painel = $${idx++}`);
      values.push(!!body.pode_ver_painel);
    }

    if (updates.length === 0) return json(res, 400, { erro: 'Nenhuma permissão informada.' });

    values.push(id);
    await pool.query(`UPDATE usuarios SET ${updates.join(', ')} WHERE id = $${idx}`, values);

    return json(res, 200, { ok: true });
  } catch (e) {
    return json(res, 500, { erro: 'Erro ao atualizar permissão.' });
  }
}

async function resetSenhaUsuario(req, res, user, id) {
  if (!user) return json(res, 401, { erro: 'Não autenticado.' });
  if (user.role !== 'admin' && user.login !== 'admin' && !user.pode_gerenciar_usuarios) {
    return json(res, 403, { erro: 'Sem permissão para resetar senhas.' });
  }
  let body = {};
  try { body = JSON.parse(await lerCorpo(req)); } catch (e) {}
  const novaSenha = String(body.nova_senha || '1234').trim();

  if (novaSenha.length < 4) {
    return json(res, 400, { erro: 'A senha provisória deve ter no mínimo 4 caracteres.' });
  }

  try {
    const target = await pool.query('SELECT login, nome FROM usuarios WHERE id = $1', [id]);
    if (target.rows.length === 0) return json(res, 404, { erro: 'Usuário não encontrado.' });

    const { hash, salt } = hashSenha(novaSenha);
    await pool.query(
      'UPDATE usuarios SET senha_hash = $1, salt = $2, trocar_senha = TRUE WHERE id = $3',
      [hash, salt, id]
    );

    // Invalida sessões ativas do usuário resetado para forçar novo login com a nova senha
    await pool.query('DELETE FROM sessoes WHERE usuario_id = $1', [id]);

    return json(res, 200, {
      ok: true,
      mensagem: `Senha de ${target.rows[0].nome} (${target.rows[0].login}) resetada para "${novaSenha}". O usuário deverá trocá-la no próximo acesso.`
    });
  } catch (e) {
    console.error('Erro ao resetar senha:', e);
    return json(res, 500, { erro: 'Erro interno ao resetar senha.' });
  }
}

async function excluirUsuario(req, res, user, id) {
  if (!user) return json(res, 401, { erro: 'Não autenticado.' });
  if (user.role !== 'admin' && user.login !== 'admin' && !user.pode_gerenciar_usuarios) {
    return json(res, 403, { erro: 'Apenas administradores podem excluir usuários.' });
  }
  if (user.id === Number(id)) return json(res, 400, { erro: 'Você não pode excluir o seu próprio usuário.' });

  try {
    const r = await pool.query('SELECT login FROM usuarios WHERE id = $1', [id]);
    if (r.rows.length === 0) return json(res, 404, { erro: 'Usuário não encontrado.' });
    if (r.rows[0].login === 'admin') return json(res, 400, { erro: 'O usuário admin principal não pode ser excluído.' });

    await pool.query('DELETE FROM usuarios WHERE id = $1', [id]);
    return json(res, 200, { ok: true });
  } catch (e) {
    return json(res, 500, { erro: 'Erro ao excluir usuário.' });
  }
}

async function atualizarNomeUsuario(req, res, user, id) {
  if (!user) return json(res, 401, { erro: 'Não autenticado.' });
  // Regra de segurança: Apenas o master (login === 'admin') pode alterar nomes de usuário
  if (user.login !== 'admin') {
    return json(res, 403, { erro: 'Apenas o administrador master pode alterar o nome do usuário.' });
  }

  let body;
  try { body = JSON.parse(await lerCorpo(req)); } catch (e) { return json(res, 400, { erro: 'Dados inválidos.' }); }

  const novoNome = String(body.nome || '').trim();
  if (!novoNome || novoNome.length < 2) {
    return json(res, 400, { erro: 'O nome deve ter no mínimo 2 caracteres.' });
  }

  try {
    const target = await pool.query('SELECT id, login, nome FROM usuarios WHERE id = $1', [id]);
    if (target.rows.length === 0) return json(res, 404, { erro: 'Usuário não encontrado.' });

    await pool.query('UPDATE usuarios SET nome = $1 WHERE id = $2', [novoNome, id]);

    return json(res, 200, {
      ok: true,
      mensagem: `Nome alterado para "${novoNome}" com sucesso!`,
      usuario: { id: Number(id), nome: novoNome }
    });
  } catch (e) {
    console.error('Erro ao atualizar nome:', e);
    return json(res, 500, { erro: 'Erro interno ao atualizar nome do usuário.' });
  }
}

// Handlers de Registros no PostgreSQL

// Filtros comuns da lista e da exportação: ?op=ret|mob &patio= &de=ISO &ate=ISO &q=texto &carga=id
function filtrosRegistros(url) {
  const sp = url.searchParams, where = [], params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace(/\?/g, '$' + params.length)); };
  const op = sp.get('op'); if (op === 'ret' || op === 'mob') add('op = ?', op);
  const patio = sp.get('patio'); if (patio) add('patio = ?', patio.slice(0, 100));
  const de = sp.get('de'); if (de && !isNaN(Date.parse(de))) add('at >= ?::timestamptz', de);
  const ate = sp.get('ate'); if (ate && !isNaN(Date.parse(ate))) add('at <= ?::timestamptz', ate);
  const carga = sp.get('carga'); if (carga) add("(dados->>'carga' = ? OR id = ?)", carga.slice(0, 100));
  const q = (sp.get('q') || '').trim().slice(0, 100);
  if (q) {
    // os mesmos campos que a busca do Histórico sempre usou
    add(`concat_ws(' ', protocolo, patio, dados->>'placa', dados->>'motorista', dados->>'os', dados->>'desenho', dados->>'elemento', dados->>'destino', dados->>'cod', dados->>'cpt', dados->>'empresa', dados->>'material', dados->>'ordem', dados->>'descricao', dados->>'marca', dados->>'corrida', dados->>'feixe', dados->>'lote') ILIKE ?`, '%' + q.replace(/[\\%_]/g, '\\$&') + '%');
  }
  return { where, params };
}

// Lista por demanda (paginada): o Histórico pede poucos registros por vez, com a miniatura, em vez de trazer tudo de uma vez.
// Parâmetros: limite (padrão 40, máx. 200), antes + antesId (cursor devolvido em "proximo") e os filtros acima.
async function listarRegistros(req, res, user) {
  if (!user && !tokenOk(req)) return json(res, 401, { erro: 'Não autenticado.' });
  try {
    const url = new URL(req.url, 'http://x'), sp = url.searchParams;
    const { where, params } = filtrosRegistros(url);
    const limite = Math.min(Math.max(parseInt(sp.get('limite'), 10) || 40, 1), 200);
    const antes = sp.get('antes');
    if (antes && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(antes)) {
      params.push(antes); const a = params.length;
      params.push(String(sp.get('antesId') || '').slice(0, 100)); const b = params.length;
      where.push(`(at, id) < ($${a}::timestamptz, $${b})`);
    }
    // Retorna dados essenciais e a miniatura (thumb) da etiqueta para preencher o quadrado da lista
    const r = await pool.query(`
      SELECT
        id, protocolo, op, at, controlador, patio, prod, dados,
        to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
        (photos IS NOT NULL AND photos != '{}'::jsonb) AS has_photos,
        (photos->'notafiscal'->>'data' IS NOT NULL OR dados->>'cargaNf' = 'true') AS tem_nf,
        COALESCE(dados->>'thumb', photos->'etiqueta'->>'thumb', photos->'etiqueta'->>'data') AS thumb
      FROM registros
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY at DESC, id DESC LIMIT ${limite + 1}
    `, params);
    const temMais = r.rows.length > limite;
    const linhas = r.rows.slice(0, limite);
    const registros = linhas.map(row => {
      const rec = Object.assign({}, row.dados, {
        id: row.id,
        protocolo: row.protocolo,
        op: row.op,
        at: row.at.toISOString(),
        controlador: row.controlador,
        patio: row.patio,
        prod: row.prod,
        has_photos: row.has_photos,
        tem_nf: !!row.tem_nf,
        thumb: row.thumb || (row.dados && row.dados.thumb) || null
      });
      return rec;
    });
    const ult = linhas[linhas.length - 1];
    const saida = { ok: true, registros, temMais, proximo: temMais && ult ? { at: ult.cursor_at, id: ult.id } : null };
    // Maior número de protocolo já usado no dia pedido (o app numera o próximo sem precisar baixar o dia inteiro)
    const dia = sp.get('dia');
    if (dia && /^\d{8}$/.test(dia) && !antes) {
      const m = await pool.query(
        `SELECT left(protocolo, 3) AS pre, max(substring(protocolo from 14)::int) AS n
           FROM registros WHERE protocolo ~ ('^(ENT|RET)-' || $1 || '-[0-9]{1,9}$') GROUP BY 1`, [dia]);
      saida.protocolos = {};
      m.rows.forEach(x => { saida.protocolos[x.pre] = x.n; });
    }
    return json(res, 200, saida);
  } catch (e) {
    console.error('Erro ao listar registros:', e);
    return json(res, 500, { erro: 'Erro ao consultar banco de dados.' });
  }
}

// Exportação (CSV): todos os registros que passam nos filtros, sem fotos nem miniaturas e sem limite.
async function exportarRegistros(req, res, user) {
  if (!user && !tokenOk(req)) return json(res, 401, { erro: 'Não autenticado.' });
  try {
    const { where, params } = filtrosRegistros(new URL(req.url, 'http://x'));
    const r = await pool.query(`
      SELECT id, protocolo, op, at, controlador, patio, prod,
             (dados - 'thumb' - 'photos') AS dados,
             (photos->'notafiscal'->>'data' IS NOT NULL OR dados->>'cargaNf' = 'true') AS tem_nf
      FROM registros
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY at ASC, id ASC
    `, params);
    const registros = r.rows.map(row => Object.assign({}, row.dados, {
      id: row.id, protocolo: row.protocolo, op: row.op, at: row.at.toISOString(),
      controlador: row.controlador, patio: row.patio, prod: row.prod, tem_nf: !!row.tem_nf
    }));
    return json(res, 200, { ok: true, total: registros.length, registros });
  } catch (e) {
    console.error('Erro ao exportar registros:', e);
    return json(res, 500, { erro: 'Erro ao consultar banco de dados.' });
  }
}

// Aviso de etiqueta repetida: compara com TODA a base (mesma regra do painel-calc.js), sem o aparelho precisar baixar a lista.
async function repetidaRegistro(req, res, user) {
  if (!user && !tokenOk(req)) return json(res, 401, { erro: 'Não autenticado.' });
  let r;
  try { r = JSON.parse(await lerCorpo(req)); } catch (e) { return json(res, 400, { erro: 'Dados inválidos.' }); }
  if (!r || typeof r !== 'object') return json(res, 400, { erro: 'Dados inválidos.' });
  try {
    const chave = PainelCalc.chaveEtiqueta(r);
    if (!chave) return json(res, 200, { ok: true, igual: null });
    const prod = r.prod === 'barra' || r.prod === 'cord' ? r.prod : 'aco';
    const params = [String(r.op || ''), prod, String(r.id || '')], alt = [];
    const addAlt = (campo, val) => { if (val != null && String(val).trim() !== '') { params.push(String(val).trim()); alt.push(`dados->>'${campo}' = $${params.length}`); } };
    // pré-filtro barato pelos campos que entram na chave; a decisão final é da chaveEtiqueta
    addAlt('cod', r.cod);
    if (prod === 'barra') addAlt('corrida', r.corrida); else if (prod === 'cord') addAlt('material', r.material); else addAlt('desenho', r.desenho);
    if (!alt.length) return json(res, 200, { ok: true, igual: null });
    const q = await pool.query(
      `SELECT id, protocolo, op, prod, at, controlador, dados FROM registros WHERE op = $1 AND prod = $2 AND id <> $3 AND (${alt.join(' OR ')}) ORDER BY at DESC LIMIT 500`, params);
    for (const row of q.rows) {
      const rec = Object.assign({}, row.dados, { id: row.id, protocolo: row.protocolo, op: row.op, prod: row.prod });
      if (PainelCalc.chaveEtiqueta(rec) === chave) {
        return json(res, 200, { ok: true, igual: { protocolo: row.protocolo, at: row.at.toISOString(), controlador: row.controlador } });
      }
    }
    return json(res, 200, { ok: true, igual: null });
  } catch (e) {
    console.error('Erro ao conferir etiqueta repetida:', e);
    return json(res, 500, { erro: 'Erro ao consultar banco de dados.' });
  }
}

// Localizações já usadas (para as sugestões do campo), das mais frequentes para as menos.
async function listarLocalizacoes(req, res, user) {
  if (!user && !tokenOk(req)) return json(res, 401, { erro: 'Não autenticado.' });
  try {
    const r = await pool.query(`SELECT dados->>'destino' AS nome, count(*)::int AS n FROM registros WHERE coalesce(dados->>'destino','') <> '' GROUP BY 1 ORDER BY n DESC LIMIT 300`);
    return json(res, 200, { ok: true, localizacoes: r.rows });
  } catch (e) {
    console.error('Erro ao listar localizações:', e);
    return json(res, 500, { erro: 'Erro ao consultar banco de dados.' });
  }
}

function podeVerPainel(u) {
  return !!u && (!!u.pode_ver_painel || u.role === 'admin' || u.login === 'admin');
}

// Base completa e enxuta para o Painel: todas as linhas, sem fotos/miniaturas e sem limite.
async function baseDoPainel(req, res, user) {
  if (!user) return json(res, 401, { erro: 'Não autenticado.' });
  if (!podeVerPainel(user)) return json(res, 403, { erro: 'Você não tem permissão para acessar o Painel.' });
  try {
    const r = await pool.query(`
      SELECT id, protocolo, op, at, controlador, patio, prod,
             (dados - 'thumb' - 'photos') AS dados,
             (photos->'notafiscal'->>'data' IS NOT NULL OR dados->>'cargaNf' = 'true') AS tem_nf
      FROM registros
      ORDER BY at ASC
    `);
    const registros = r.rows.map(row => Object.assign({}, row.dados, {
      id: row.id, protocolo: row.protocolo, op: row.op, at: row.at.toISOString(),
      controlador: row.controlador, patio: row.patio, prod: row.prod, tem_nf: !!row.tem_nf
    }));
    return json(res, 200, { ok: true, geradoEm: new Date().toISOString(), total: registros.length, registros });
  } catch (e) {
    console.error('Erro ao montar base do painel:', e);
    return json(res, 500, { erro: 'Erro ao consultar banco de dados.' });
  }
}

async function obterFotosRegistro(req, res, user, id) {
  if (!user && !tokenOk(req)) return json(res, 401, { erro: 'Não autenticado.' });
  try {
    const r = await pool.query("SELECT photos, dados->>'cargaFotosDe' AS ref FROM registros WHERE id = $1", [id]);
    if (!r.rows.length) return json(res, 404, { erro: 'Registro não encontrado.' });
    let photos = r.rows[0].photos || {};
    const ref = r.rows[0].ref;
    // Numa carga, placa, crachá e nota ficam gravados só no 1º registro; os demais apontam para ele (cargaFotosDe).
    if (ref && ref !== id) {
      const falta = ['placa', 'cracha', 'notafiscal'].filter(k => !(photos[k] && photos[k].data));
      if (falta.length) {
        const o = await pool.query('SELECT photos FROM registros WHERE id = $1', [ref]);
        const op = (o.rows[0] && o.rows[0].photos) || {};
        photos = Object.assign({}, photos);
        falta.forEach(k => { if (op[k]) photos[k] = op[k]; });
      }
    }
    return json(res, 200, { ok: true, photos });
  } catch (e) {
    console.error('Erro ao buscar fotos do registro:', e);
    return json(res, 500, { erro: 'Erro ao buscar fotos do registro.' });
  }
}

async function salvarRegistro(req, res, user) {
  if (!user && !tokenOk(req)) return json(res, 401, { erro: 'Não autenticado.' });
  let rec;
  try { rec = JSON.parse(await lerCorpo(req)); } catch (e) { return json(res, 400, { erro: 'Registro inválido.' }); }

  if (!rec || !rec.id || !rec.protocolo || !rec.op) {
    return json(res, 400, { erro: 'Dados essenciais do registro faltando.' });
  }

  const { id, protocolo, op, at, controlador, patio, prod, photos, ...resto } = rec;
  const usuarioId = user ? user.id : null;

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // O número do protocolo é definido aqui: registro novo recebe o número pedido pelo aparelho se ele estiver livre;
    // se já existir, recebe o próximo número livre do mesmo tipo e dia. Registro que já existe nunca muda de protocolo.
    const existente = await c.query('SELECT protocolo FROM registros WHERE id = $1', [id]);
    const protoFinal = existente.rows.length ? existente.rows[0].protocolo : await protocoloLivre(c, protocolo, op, at);
    await c.query(`
      INSERT INTO registros (id, protocolo, op, at, controlador, patio, prod, dados, photos, usuario_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO UPDATE SET
        op = EXCLUDED.op,
        at = EXCLUDED.at,
        controlador = EXCLUDED.controlador,
        patio = EXCLUDED.patio,
        prod = EXCLUDED.prod,
        dados = EXCLUDED.dados,
        photos = EXCLUDED.photos
    `, [id, protoFinal, op, new Date(at || Date.now()), controlador || '', patio || '', prod || 'aco', JSON.stringify(resto), JSON.stringify(photos || {}), usuarioId]);
    await c.query('COMMIT');

    return json(res, 200, { ok: true, id, protocolo: protoFinal });
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (e2) {}
    console.error('Erro ao salvar registro no PostgreSQL:', e);
    return json(res, 500, { erro: 'Erro ao gravar no banco de dados.' });
  } finally {
    c.release();
  }
}

// Protocolo no formato ENT|RET-AAAAMMDD-NNNN, sem repetir número. Quem numera o mesmo tipo e dia é serializado por um lock.
async function protocoloLivre(c, pedido, op, at) {
  const m = /^(ENT|RET)-(\d{8})-(\d+)$/.exec(String(pedido || ''));
  const pre = m ? m[1] : (op === 'ret' ? 'RET' : 'ENT');
  const dia = m ? m[2] : new Date(at || Date.now()).toISOString().slice(0, 10).replace(/-/g, '');
  const base = pre + '-' + dia + '-';
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [base]);
  if (m) {
    const usado = await c.query('SELECT 1 FROM registros WHERE protocolo = $1 LIMIT 1', [pedido]);
    if (!usado.rows.length) return pedido;
  }
  const mx = await c.query("SELECT COALESCE(MAX((regexp_match(protocolo, '-(\\d+)$'))[1]::int), 0) AS mx FROM registros WHERE protocolo LIKE $1", [base + '%']);
  return base + String(mx.rows[0].mx + 1).padStart(4, '0');
}

async function excluirRegistro(req, res, user, id) {
  if (!user && !tokenOk(req)) return json(res, 401, { erro: 'Não autenticado.' });
  if (user && user.role !== 'admin' && user.login !== 'admin' && !user.pode_excluir) {
    return json(res, 403, { erro: 'Você não tem permissão para excluir registros.' });
  }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // Se este registro guarda as fotos de uma carga (placa, crachá, nota), elas passam para a etiqueta seguinte da carga
    // antes da exclusão; assim as demais etiquetas não ficam sem essas fotos.
    const refs = await c.query("SELECT id, photos FROM registros WHERE dados->>'cargaFotosDe' = $1 ORDER BY at ASC, id ASC", [id]);
    if (refs.rows.length) {
      const o = await c.query('SELECT photos FROM registros WHERE id = $1', [id]);
      const op = (o.rows[0] && o.rows[0].photos) || {};
      const heranca = {};
      ['placa', 'cracha', 'notafiscal'].forEach(k => { if (op[k] && op[k].data) heranca[k] = op[k]; });
      const novo = refs.rows[0];
      await c.query("UPDATE registros SET photos = $2, dados = dados - 'cargaFotosDe' WHERE id = $1", [novo.id, JSON.stringify(Object.assign({}, novo.photos || {}, heranca))]);
      await c.query("UPDATE registros SET dados = jsonb_set(dados, '{cargaFotosDe}', to_jsonb($2::text)) WHERE dados->>'cargaFotosDe' = $1 AND id <> $2", [id, novo.id]);
    }
    await c.query('DELETE FROM registros WHERE id = $1', [id]);
    await c.query('COMMIT');
    return json(res, 200, { ok: true });
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (e2) {}
    console.error('Erro ao excluir registro:', e.message);
    return json(res, 500, { erro: 'Erro ao excluir registro.' });
  } finally {
    c.release();
  }
}

function estatico(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const arq = path.normalize(path.join(PUBLIC, rel));
  if (arq !== PUBLIC && !arq.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(arq, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Não encontrado'); }
    const ext = path.extname(arq).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      // html e js sempre revalidam: o index.html novo exige o painel-calc.js novo, e uma cópia velha em cache quebraria o app
      'cache-control': ext === '.html' || ext === '.js' || arq.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'permissions-policy': 'camera=(self), geolocation=()'
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;

  // Status
  if (p === '/api/saude' && req.method === 'GET') {
    return json(res, 200, { ok: true, leitura: !!KEY, acesso: !!TOKEN, modelo: MODEL, banco: !!pool });
  }

  // Autenticação
  if (p === '/api/auth/login' && req.method === 'POST') return authLogin(req, res);
  if (p === '/api/auth/logout' && req.method === 'POST') return authLogout(req, res);

  const user = await getAuthUser(req);

  if (p === '/api/auth/mudar-senha' && req.method === 'POST') return authMudarSenha(req, res, user);
  if (p === '/api/auth/me' && req.method === 'GET') return authMe(req, res, user);

  // Usuários
  if (p === '/api/usuarios' && req.method === 'GET') return listarUsuarios(req, res, user);
  if (p === '/api/usuarios' && req.method === 'POST') return criarUsuario(req, res, user);
  if (p.startsWith('/api/usuarios/') && p.endsWith('/permissao') && req.method === 'POST') {
    const id = p.split('/')[3];
    return atualizarPermissaoUsuario(req, res, user, id);
  }
  if (p.startsWith('/api/usuarios/') && p.endsWith('/reset-senha') && req.method === 'POST') {
    const id = p.split('/')[3];
    return resetSenhaUsuario(req, res, user, id);
  }
  if (p.startsWith('/api/usuarios/') && p.endsWith('/nome') && req.method === 'POST') {
    const id = p.split('/')[3];
    return atualizarNomeUsuario(req, res, user, id);
  }
  if (p.startsWith('/api/usuarios/') && req.method === 'DELETE') {
    const id = p.split('/')[3];
    return excluirUsuario(req, res, user, id);
  }

  // Registros
  if (p === '/api/painel/base' && req.method === 'GET') return baseDoPainel(req, res, user);
  if (p === '/api/registros/exportar' && req.method === 'GET') return exportarRegistros(req, res, user);
  if (p === '/api/registros/repetida' && req.method === 'POST') return repetidaRegistro(req, res, user);
  if (p === '/api/localizacoes' && req.method === 'GET') return listarLocalizacoes(req, res, user);
  if (p === '/api/registros' && req.method === 'GET') return listarRegistros(req, res, user);
  if (p === '/api/registros' && req.method === 'POST') return salvarRegistro(req, res, user);
  if (p.startsWith('/api/registros/') && p.endsWith('/fotos') && req.method === 'GET') {
    const id = p.split('/')[3];
    return obterFotosRegistro(req, res, user, id);
  }
  if (p.startsWith('/api/registros/') && req.method === 'DELETE') {
    const id = p.split('/')[3];
    return excluirRegistro(req, res, user, id);
  }

  // Leitura com IA
  if (p === '/api/ler') {
    return req.method === 'POST' ? ler(req, res, user) : json(res, 405, { erro: 'Método não permitido.' });
  }

  // Arquivos estáticos
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  return estatico(req, res);
});

server.listen(PORT, async () => {
  console.log('Controle de Aço CPRT em http://localhost:' + PORT);
  await initDb();
});
