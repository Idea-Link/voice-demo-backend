import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import * as dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { LiveSocketSession } from './services/liveSocketSession.js';
import type { WebSocket } from 'ws';

dotenv.config();

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info'
  }
});

await app.register(websocket);

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  app.log.warn('GEMINI_API_KEY is not set. Please set it in the environment variables.');
  process.exit(1);
}

const model = process.env.GENAI_MODEL ?? '';
if (!model) {
  app.log.warn('GENAI_MODEL is not set. Please set it in the environment variables.');
  process.exit(1);
}

const genAi = new GoogleGenAI({ apiKey: apiKey ?? '' });

app.get('/health', async () => ({
  status: 'ok',
  time: new Date().toISOString()
}));

app.get('/ws', { websocket: true }, (socket: WebSocket) => {
  const session = new LiveSocketSession(socket, genAi, app.log);
  session.bind();
});

app.listen({ port: PORT, host: HOST }).catch((err) => {
  app.log.error({ err }, 'Failed to start backend server');
  process.exit(1);
});

