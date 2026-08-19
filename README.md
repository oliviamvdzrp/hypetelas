# TelaFácil

Site de compartilhamento de tela em salas, usando WebRTC para mídia e WebSocket para sinalização.

## Recursos

- Criar sala com código aleatório
- Entrar por link
- Compartilhar tela, janela ou aba pelo seletor nativo do navegador
- Tentar compartilhar áudio do sistema quando o navegador oferecer essa opção
- Microfone
- Participantes em tempo real
- Mais de uma pessoa pode transmitir
- Chat da sala
- Copiar convite
- Interface responsiva em português
- Health check para Render

## Rodar localmente

Requer Node.js 20+.

```bash
npm install
npm start
```

Abra:

http://localhost:10000

## Publicar no Render

1. Suba o projeto para um repositório GitHub.
2. No Render, crie um Web Service e conecte o repositório.
3. Build Command: `npm install`
4. Start Command: `npm start`
5. O serviço deve escutar a porta fornecida pela variável `PORT`.

O Render suporta WebSockets em Web Services.

## Observações

A captura de tela exige HTTPS quando publicada. O áudio do sistema depende do navegador e da fonte escolhida pelo usuário.

Esta versão usa servidores STUN públicos para ajudar na negociação WebRTC. Para melhorar a conectividade em redes restritivas, adicione um servidor TURN próprio no arquivo `public/app.js`.
