import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import * as dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { LiveSocketSession } from './services/liveSocketSession.js';
import { tokenStore } from './services/tokenStore.js';
import type { WebSocket } from 'ws';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

dotenv.config();

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info'
  }
});

if (process.env.NODE_ENV === 'dev') {
  await app.register(cors, {
    origin: process.env.FRONTEND_URL ?? '*',
    credentials: true
  });
} else if (process.env.NODE_ENV === 'production') {
  await app.register(cors, {
    origin: 'https://voicedemo.idealink.tech',
    credentials: true
  });
}
  
await app.register(websocket);
await app.register(multipart);

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

const genAi = new GoogleGenAI({ 
  apiKey: apiKey ?? '',
  httpOptions: { apiVersion: 'v1alpha' }
});

app.get('/health', async () => ({
  status: 'ok',
  time: new Date().toISOString()
}));

app.get('/ws', { websocket: true }, (socket: WebSocket) => {
  const session = new LiveSocketSession(socket, genAi, app.log);
  session.bind();
});

app.post('/api/recordings', async (request, reply) => {
  try {
    // Validate recording token
    const token = request.headers['x-recording-token'] as string;
    
    if (!token) {
      app.log.warn('Recording upload attempted without token');
      return reply.code(401).send({ error: 'Missing recording token' });
    }

    const tokenResult = tokenStore.validateAndUseToken(token);
    
    if (!tokenResult.valid) {
      app.log.warn({ token: token.substring(0, 10) + '...' }, 'Recording upload with invalid/used/expired token');
      return reply.code(403).send({ error: 'Invalid, expired, or already used recording token' });
    }

    const data = await request.file({
      limits: {
        fileSize: 100 * 1024 * 1024, // 100MB max
      }
    });
    
    if (!data) {
      return reply.code(400).send({ error: 'No file uploaded' });
    }

    const getFieldValue = (field: any): string | undefined => {
      if (!field) return undefined;
      if (Array.isArray(field)) {
        return field[0]?.value;
      }
      return field.value;
    };

    // Get form fields
    const timestamp = getFieldValue(data.fields.timestamp) || new Date().toISOString();

    // Ensure recordings directory exists
    const recordingsDir = './recordings';
    await mkdir(recordingsDir, { recursive: true });

    // Generate filename with timestamp
    const date = new Date(timestamp);
    const dateStr = date.toISOString().replace(/[:.]/g, '-').split('.')[0];
    const filename = `conversation-${dateStr}.webm`;
    const filepath = join(recordingsDir, filename);

    // Save the file
    const buffer = await data.toBuffer();
    await writeFile(filepath, buffer);

    app.log.info({
      sessionId: tokenResult.sessionId,
      timestamp,
      filename,
      size: buffer.length,
      mimetype: data.mimetype
    }, 'Recording saved');

    return reply.code(200).send({
      success: true,
      filename,
      size: buffer.length
    });
  } catch (error) {
    app.log.error({ err: error }, 'Failed to save recording');
    return reply.code(500).send({ error: 'Failed to save recording' });
  }
});

app.listen({ port: PORT, host: HOST }).catch((err) => {
  app.log.error({ err }, 'Failed to start backend server');
  process.exit(1);
});

