# IdeaLink Voice Assistant – Backend

Fastify + @google/genai service that terminates WebSocket connections from the frontend, streams microphone audio to Gemini Live, and relays transcripts/audio chunks back to clients.

## Requirements

- Bun (preferred) or Node.js 18+
- Google Gemini API key with realtime access

## Setup

```bash
cd backend
bun install
cp env.example .env
```

Configure the environment file:

- `GEMINI_API_KEY` – required; obtained from Google AI Studio
- `PORT` – optional (default `4000`)
- `HOST` – optional (default `0.0.0.0`)
- `GENAI_MODEL` – optional (defaults to `gemini-2.5-flash-native-audio-preview-09-2025`)
- `LOG_LEVEL` – optional pino log level (`info`, `debug`, etc.)

## Scripts

| Command | Description |
| ------- | ----------- |
| `bun run dev` | Start Fastify with hot reload via `tsx watch` |
| `bun run build` | Type-check and emit JS to `dist/` |
| `bun run start` | Run the compiled server |
| `bun run lint` | Type-check only |

## Endpoints

- `GET /health` – simple readiness endpoint
- `GET /ws` (WebSocket) – bidirectional audio/transcript streaming channel used by the frontend

## Notes

- The server keeps API keys private and supports multi-client WebSocket sessions with heartbeats and flow control.
- When deploying, front the service with HTTPS/WSS and ensure low-latency media handling.

test4
