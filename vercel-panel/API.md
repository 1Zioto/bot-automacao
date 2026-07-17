# API de envios com anexo

Use esta API para enviar mensagens e anexos pelo numero conectado no painel.

## Endpoint

```bash
POST https://vercel-panel-delta.vercel.app/api/envios?api=1
```

Cabecalho obrigatorio:

```bash
Content-Type: application/json
```

## Enviar mensagem simples

```bash
curl -X POST "https://vercel-panel-delta.vercel.app/api/envios?api=1" \
  -H "Content-Type: application/json" \
  -d '{"token":"SEU_TOKEN","numero":"27981416770","mensagem":"Ola!"}'
```

## Enviar anexo por URL

Recomendado para PDF, imagem, audio, planilha e arquivos maiores.

```bash
curl -X POST "https://vercel-panel-delta.vercel.app/api/envios?api=1" \
  -H "Content-Type: application/json" \
  -d '{"token":"SEU_TOKEN","numero":"27981416770","mensagem":"Segue o arquivo.","arquivo_url":"https://seudominio.com/arquivo.pdf","nome_arquivo":"arquivo.pdf","como_documento":true}'
```

## Enviar imagem com legenda

Use `como_documento:false` para a imagem aparecer como midia no WhatsApp.

```bash
curl -X POST "https://vercel-panel-delta.vercel.app/api/envios?api=1" \
  -H "Content-Type: application/json" \
  -d '{"token":"SEU_TOKEN","numero":"27981416770","mensagem":"Veja a imagem.","arquivo_url":"https://seudominio.com/foto.jpg","nome_arquivo":"foto.jpg","como_documento":false}'
```

## Enviar anexo em base64

Use quando o outro projeto ja tem o arquivo em base64.

```bash
curl -X POST "https://vercel-panel-delta.vercel.app/api/envios?api=1" \
  -H "Content-Type: application/json" \
  -d '{"token":"SEU_TOKEN","numero":"27981416770","mensagem":"Segue o arquivo.","arquivo_base64":"JVBERi0xLjQ...","mimetype":"application/pdf","nome_arquivo":"arquivo.pdf","como_documento":true}'
```

## Campos

| Campo | Obrigatorio | Descricao |
| --- | --- | --- |
| `token` | Sim | Token gerado na tela API do usuario. |
| `numero` | Sim | Telefone de destino com DDD. Pode enviar `27981416770` ou `5527981416770`. |
| `mensagem` | Nao | Texto ou legenda do envio. |
| `arquivo_url` | Nao | URL publica do arquivo. Recomendado para anexos. |
| `arquivo_base64` | Nao | Conteudo do arquivo em base64. |
| `mimetype` | Sim, com base64 | Tipo do arquivo. Ex.: `application/pdf`, `image/jpeg`, `image/png`. |
| `nome_arquivo` | Nao | Nome que aparecera no WhatsApp. |
| `como_documento` | Nao | `true` envia como documento. `false` envia como midia quando possivel. |

Informe pelo menos `mensagem`, `arquivo_url` ou `arquivo_base64`.

## Resposta de sucesso

```json
{
  "ok": true,
  "id": 123
}
```

O `id` e o identificador do envio na fila.

## Consultar status do numero

```bash
curl "https://vercel-panel-delta.vercel.app/api/sessao?api=1&token=SEU_TOKEN"
```

Resposta exemplo:

```json
{
  "status": "pronto",
  "numero_conectado": "5527981416770",
  "atualizado_em": "2026-07-06T15:00:00.000Z"
}
```

## Consultar fila e historico

```bash
curl "https://vercel-panel-delta.vercel.app/api/envios?api=1&token=SEU_TOKEN&limite=50"
```

## Exemplo em JavaScript

```js
const resposta = await fetch('https://vercel-panel-delta.vercel.app/api/envios?api=1', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    token: 'SEU_TOKEN',
    numero: '27981416770',
    mensagem: 'Segue o arquivo.',
    arquivo_url: 'https://seudominio.com/arquivo.pdf',
    nome_arquivo: 'arquivo.pdf',
    como_documento: true
  })
});

const dados = await resposta.json();
console.log(dados);
```

## Erros comuns

```json
{ "erro": "Token de API invalido." }
```

O token esta errado ou foi regenerado.

```json
{ "erro": "Nenhum numero conectado nesta conta." }
```

O usuario ainda nao conectou o WhatsApp no painel.

```json
{ "erro": "Informe numero e mensagem ou arquivo." }
```

Envie `numero` e pelo menos um destes campos: `mensagem`, `arquivo_url` ou `arquivo_base64`.
