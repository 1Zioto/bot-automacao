# Bot WhatsApp - nucleo com painel

Projeto enxuto para conectar ao WhatsApp Web, mostrar o QR Code em um painel web e servir como base para automatizacao de envio de mensagens.

## Como rodar

```bash
npm install
npm start
```

Ou execute `iniciar.bat` no Windows.

Ao iniciar pela primeira vez, o terminal mostra o QR Code. Escaneie com o WhatsApp em **Aparelhos conectados**. A sessao fica salva em `.wwebjs_auth/`.

O painel tambem fica disponivel em:

```text
http://localhost:3000
```

Usuario padrao: `admin`

A senha fica em `PANEL_PASSWORD` no arquivo `.env`. Copie `.env.example` para `.env` antes de colocar online.

Para usar o painel remoto na Vercel, configure tambem `PANEL_REMOTE_TOKEN`. A pagina hospedada na Vercel vai pedir a URL publica do servidor do bot e esse token.

## Enviar arquivo via API

Endpoint:

```text
POST /enviar-arquivo
```

Use autenticacao Basic igual ao painel (`admin` + `PANEL_PASSWORD`) e envie JSON.

Exemplo com arquivo em base64:

```json
{
  "numero": "5511999999999",
  "arquivo_base64": "JVBERi0xLjQ...",
  "mimetype": "application/pdf",
  "nome_arquivo": "proposta.pdf",
  "legenda": "Segue o arquivo.",
  "como_documento": true
}
```

Exemplo com URL publica:

```json
{
  "numero": "5511999999999",
  "arquivo_url": "https://exemplo.com/proposta.pdf",
  "nome_arquivo": "proposta.pdf",
  "legenda": "Segue o arquivo.",
  "como_documento": true
}
```

Para a API publica do painel na Vercel, consulte:

```text
../vercel-panel/API.md
```

## Estrutura atual

```text
bot/
├── main.js
├── package.json
├── .env.example
├── .gitignore
└── iniciar.bat
```

## Proximo passo

O arquivo `main.js` ja tem a funcao `enviarMensagem(numero, mensagem)`. A proxima etapa pode adicionar fila, planilha de contatos, agendamento ou disparo manual.
