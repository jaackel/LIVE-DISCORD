# Live Sitevision

Salas de vídeo sem login: a pessoa digita nome + sala, abre câmera e/ou compartilha a tela.
LiveKit (SFU open source) + app Node que emite tokens e serve a página.

## Rodar
    cp .env.example .env   # preencha NODE_IP, chave e segredo (openssl rand -hex 24)
    docker compose up -d --build
App em `127.0.0.1:8086`; sinalização do LiveKit é repassada pelo app em `/rtc`.

## Publicar (live.sitevision.com.br)
- Tunnel Cloudflare: hostname → `http://localhost:8086` (leva só HTTP/WebSocket).
- **A mídia não passa pelo tunnel.** Liberar no firewall: `7881/tcp` e `7882/udp`
  (`ufw allow 7881/tcp; ufw allow 7882/udp`). `NODE_IP` deve ser o IP público.

## Qualidade da tela
Econômica 720p/15fps/1,5 Mbps · Equilibrada 1080p/30/5 Mbps · Máxima 4K/60/20 Mbps.
Troca durante a transmissão. Codec H.264 (encoder por hardware => menos CPU).
Cada espectador consome a banda do preset do servidor (upload do servidor é o limite).

## Acesso
Sem login: quem souber o nome da sala entra. Use nomes de sala difíceis de adivinhar.
