# Controle de Aço CPRT

Aplicativo web (PWA) para o controlador registrar material (aço pronto, barra reta e cordoalha, identificados automaticamente pela etiqueta), operações de **retirada** e **entrada** de aço no pátio, com três fotos obrigatórias (etiqueta, placa do caminhão e crachá do motorista). 

As fotos são lidas e interpretadas automaticamente pela IA e preenchem o formulário. Cada registro gera um protocolo, comprovante em HTML, exportação CSV e sincronização centralizada no banco de dados **PostgreSQL**.

---

## Stack
- **Front-end:** HTML5, CSS3 e JavaScript puro (`public/index.html`). Funciona offline como PWA (IndexedDB no aparelho para redundância e cache).
- **Back-end:** Node.js 18+ (`server.js`). Autenticação de usuários, permissões de acesso, persistência e leitura das fotos via API da Anthropic.
- **Banco de Dados:** PostgreSQL 17 gerenciado via Docker Compose (`cprt-postgres`).

---

## Como rodar o projeto

### 1. Iniciar o Banco de Dados (PostgreSQL 17)
```bash
docker compose up -d
```

### 2. Iniciar o Servidor Node.js
```bash
node server.js
```
*(ou `npm start`)*

Acesse no navegador:
👉 **http://localhost:3000** (ou `http://SEU_IP_LOCAL:3000` pelo celular na mesma rede).

---

## Autenticação e Perfis de Acesso
- **Usuário Padrão Inicial:** `admin` / `admin`.
- **Primeiro Acesso:** Novos usuários criados pelo administrador são obrigados a definir uma nova senha pessoal no primeiro login.
- **Permissão de Exclusão:** No cadastro de usuários ou na tela de Gestão de Usuários, o administrador pode habilitar ou revogar se o operador pode ou não excluir registros do banco de dados.

---

## Publicar em Produção
A câmera do celular só abre em conexões seguras **HTTPS** (exceto em `localhost`). 
Em produção, utilize um proxy reverso (Nginx, Caddy ou Cloudflare) com certificado SSL (Let's Encrypt).
