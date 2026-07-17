# Motor multi-sessão na VPS

O motor (`engine.js`) mantém os WhatsApp conectados, gera o QR (grava no banco) e
envia as mensagens da fila. Ele precisa rodar **sempre ligado** numa máquina Linux.

## 1. Pré-requisitos (Ubuntu/Debian)

```bash
# Node 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Dependências do Chrome/Puppeteer
sudo apt-get install -y \
  ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
  libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 \
  libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 \
  libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libxss1 wget
```

## 2. Subir os arquivos

Envie para a VPS os arquivos: `engine.js`, `package.json`.

```bash
cd /opt/whatsapp-engine     # ou a pasta que preferir
npm install
```

## 3. Variáveis de ambiente (.env na mesma pasta)

```
DATABASE_URL=postgresql://USUARIO:SENHA@HOST/neondb?sslmode=require&channel_binding=require
HEADLESS=true
# Opcional, só se o inject falhar:
# WEB_VERSION_REMOTE_PATH=https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1031490220-alpha.html
```

> Use o MESMO DATABASE_URL configurado na Vercel — é o banco que liga o painel ao motor.

## 4. Rodar sempre ligado (pm2)

```bash
sudo npm install -g pm2
pm2 start engine.js --name whatsapp-engine
pm2 save
pm2 startup        # siga a instrução que ele imprime para iniciar no boot
```

Logs: `pm2 logs whatsapp-engine`

## Como funciona

1. O usuário se cadastra/loga no painel (Vercel) → cria a linha em `sessoes`.
2. O motor detecta a sessão, sobe um Chrome para ela e grava o QR no banco.
3. O painel mostra o QR; o usuário escaneia com o WhatsApp dele.
4. Ao conectar, o status vira `pronto` e o número aparece no painel.
5. Tudo que o usuário enfileira no painel sai pelo número dele, processado pelo motor.

Cada número conectado = um Chrome aberto na VPS. Dimensione a RAM conforme a quantidade
de usuários (regra prática: ~300-500 MB por sessão ativa).
