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

## Painel
Menu **Painel** com duas visões, calculadas em tempo real sobre todos os registros do banco (mesmas colunas do Histórico e do CSV):
- **Painel geral:** registros, entradas, retiradas, peso, barras, saldo no pátio, peso por dia, por pátio, por controlador, por bitola e produto (aço pronto, barra reta e cordoalha) e últimos registros.
- **Aço pronto:** onde está o aço por pátio e Localização, saldo (entradas − retiradas) por local e por desenho, peso por elemento/desenho/bitola, matriz elemento × bitola, resumo por desenho e últimas etiquetas.

**Cargas:** o Painel mostra quantas cargas (carretas) passaram, as etiquetas por carga e a tabela das cargas mais recentes. Cargas feitas no modo carga são *registradas*; para registros antigos e lançamentos individuais a carga é *estimada* (mesma placa, operação e pátio, com até 30 minutos entre uma etiqueta e a seguinte).

Filtros: busca de texto (em todos os campos ou em uma coluna), pátio, operação, produto, período (Hoje, 7 dias, 30 dias, todo o período) e datas De/Até livres.

**Permissão:** o Painel só aparece para quem tem a permissão "Painel" (Usuários → *Permitir Painel*). Administradores têm acesso sempre; usuário comum não, por padrão. O servidor também bloqueia `GET /api/painel/base` sem a permissão.

O cálculo fica em `public/painel-calc.js` (sem dependência de tela) e reproduz as regras do `Dash.xlsx`. Para validar contra a planilha:
```bash
python -X utf8 tests/export_dash.py   # gera tests/fixtures/dash-golden.json (fora do git)
npm test
```

## Carga com várias etiquetas
Uma carreta costuma trazer 10 a 15 etiquetas com a mesma placa, crachá e nota. Depois de salvar a primeira etiqueta, use **"Próxima etiqueta da mesma carga"**: placa, crachá, nota, motorista, empresa, localização e autorizador são reaproveitados e só a foto da etiqueta é pedida. **"Encerrar carga"** mostra o resumo. Vale para entrada e para retirada, e aço pronto e barra reta podem vir na mesma carga.

O lançamento individual continua igual (**"Novo registro"**). Cada etiqueta continua sendo **um registro** (mesmos campos, protocolo e CSV); as etiquetas da mesma carga só ganham os campos opcionais `carga` e `cargaSeq`.

- **Etiqueta repetida:** antes de salvar, o sistema avisa se a mesma etiqueta já foi registrada na mesma operação (o controlador pode confirmar mesmo assim).
- **Fotos guardadas uma vez:** placa, crachá e nota ficam gravados só no 1º registro da carga; as demais etiquetas guardam só a foto da etiqueta e o campo `cargaFotosDe`, que aponta para o 1º registro. O servidor devolve as quatro fotos normalmente (detalhe do Histórico e comprovante). Se o 1º registro da carga for excluído, as fotos da carga passam automaticamente para a etiqueta seguinte. Cargas feitas antes dessa mudança continuam com as fotos em cada registro.
- **Sem conexão:** o registro fica salvo no aparelho, aparece como pendente no Histórico e é reenviado ao voltar a conexão (ou em "Enviar agora").
- **Retomar uma carga:** se o app fechar no meio, a tela inicial mostra "Há uma carga em andamento" com **Retomar carga** (vale por 12 horas, para o mesmo usuário). Também dá para abrir qualquer registro no Histórico e usar **"Adicionar etiqueta a esta carga"**: se o registro era individual, ele passa a ser a 1ª etiqueta da carga.

## Protocolo
O número do protocolo (`ENT|RET-AAAAMMDD-NNNN`) é garantido pelo servidor. O aparelho propõe o número (para funcionar sem internet); ao gravar, o servidor mantém o número se ele estiver livre e, se já existir, usa o próximo número livre do mesmo tipo e dia, e o app mostra um aviso com o número final. Um registro que já existe nunca muda de protocolo.

Protocolos repetidos que já existiam no banco podem ser corrigidos com `node tools/corrigir-protocolos.js` (simulação por padrão; `--apply` grava, mantendo o número no registro mais antigo de cada grupo e salvando a lista antigo → novo em `backups/`).

## Armazenamento no celular
As fotos de cada registro (cerca de 750 KB) ficam no aparelho só até o servidor confirmar o recebimento. Depois disso o registro local é enxugado (fica sem fotos, com miniatura) e os registros com mais de 7 dias já confirmados são apagados do aparelho; o servidor guarda tudo. Nunca são enxugados: registros pendentes de envio, registros que o servidor ainda não conhece e a 1ª etiqueta de uma carga aberta (para retomar sem internet). Ao abrir o app, os registros locais são lidos um por vez, sem as fotos, para não pesar a memória.

## Publicar em Produção
A câmera do celular só abre em conexões seguras **HTTPS** (exceto em `localhost`). 
Em produção, utilize um proxy reverso (Nginx, Caddy ou Cloudflare) com certificado SSL (Let's Encrypt).
