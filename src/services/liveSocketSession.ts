import type { FastifyBaseLogger } from 'fastify';
import { randomUUID } from 'crypto';
import type { WebSocket } from 'ws';
import {
  ClientAudioChunkMessage,
  ClientHelloMessage,
  ClientSocketMessage,
  ConnectionState,
  HeartbeatMessage,
  ServerErrorMessage,
  ServerSocketMessage,
  SocketMessageType,
} from '../types/conversation.js';
import {
  GoogleGenAI,
  LiveServerMessage,
  Modality,
  ThinkingLevel,
  type Blob as GenAIBlob
} from '@google/genai';
import { SYSTEM_INSTRUCTION } from '../constants/systemInstruction.js';

type LiveSession = Awaited<ReturnType<GoogleGenAI['live']['connect']>>;

const OUTPUT_SAMPLE_RATE = 24000;

export class LiveSocketSession {
  private sessionPromise: Promise<LiveSession> | null = null;
  private session: LiveSession | null = null;
  private seqCounter = 0;
  private active = false;
  private sessionId = randomUUID();
  private cleanedUp = false;

  constructor(
    private socket: WebSocket & { OPEN: number },
    private ai: GoogleGenAI,
    private logger: FastifyBaseLogger
  ) {}

  public bind() {
    this.logger.info({ sessionId: this.sessionId }, 'client connected');
    this.sendStatus(ConnectionState.CONNECTING, 'Awaiting client hello');

    this.socket.on('message', (raw: Buffer) => {
      try {
        const parsed = this.parseIncoming(raw);
        this.handleIncoming(parsed);
      } catch (error) {
        this.logger.error(
          { err: error },
          'Failed to parse incoming websocket payload'
        );
        this.sendError('bad_payload', (error as Error).message);
      }
    });

    this.socket.on('close', () => {
      this.logger.info({ sessionId: this.sessionId }, 'socket closed by client');
      this.teardown('socket_closed');
    });

    this.socket.on('error', (err: Error) => {
      this.logger.error({ err }, 'socket error');
      this.sendError('socket_error', err.message);
      this.teardown('socket_error');
    });
  }

  private parseIncoming(raw: Buffer): ClientSocketMessage {
    const data = raw.toString('utf-8');
    const parsed = JSON.parse(data);
    if (!parsed?.type) {
      throw new Error('socket payload missing type');
    }
    return parsed;
  }

  private handleIncoming(message: ClientSocketMessage) {
    switch (message.type) {
      case SocketMessageType.CLIENT_HELLO:
        this.handleHello(message);
        break;
      case SocketMessageType.CLIENT_AUDIO_CHUNK:
        this.forwardAudioChunk(message);
        break;
      case SocketMessageType.CLIENT_END:
        this.logger.info({ sessionId: this.sessionId }, 'client ended session');
        this.teardown('client_end');
        break;
      case SocketMessageType.HEARTBEAT:
        this.respondHeartbeat(message);
        break;
      default:
        this.sendError('unsupported_message', 'Unsupported client message type');
    }
  }

  private respondHeartbeat(message: HeartbeatMessage) {
    this.send({
      type: SocketMessageType.HEARTBEAT,
      payload: { kind: message.payload.kind === 'ping' ? 'pong' : 'ping' },
      timestamp: Date.now()
    });
  }

  private async handleHello(message: ClientHelloMessage) {
    if (this.sessionPromise) {
      return;
    }
    if (!process.env.GEMINI_API_KEY || !process.env.GENAI_MODEL) {
      this.sendError('missing_api_key', 'GEMINI_API_KEY or GENAI_MODEL is not configured');
      this.teardown('config_error');
      return;
    }

    this.sessionPromise = this.ai.live.connect({
      model: process.env.GENAI_MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: SYSTEM_INSTRUCTION,
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } }
        },
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: ThinkingLevel.HIGH
        },
        proactivity: {
          proactiveAudio: true
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      callbacks: {
        onopen: () => {
          this.logger.info({ sessionId: this.sessionId }, 'genai session opened');
          this.active = true;
          this.send({
            type: SocketMessageType.SERVER_READY,
            payload: { sessionId: this.sessionId },
            timestamp: Date.now()
          });
          this.sendStatus(ConnectionState.CONNECTED, 'Live session ready');
        },
        onmessage: (event) => this.handleGenAiMessage(event),
        onerror: (event) => {
          this.logger.error({ event }, 'genai session error');
          this.sendError('model_error', JSON.stringify(event));
          this.teardown('model_error');
        },
        onclose: () => {
          this.logger.info({ sessionId: this.sessionId }, 'genai session closed');
          this.sendStatus(ConnectionState.DISCONNECTED, 'Model closed session');
          this.teardown('model_closed');
        }
      }
    });

    try {
      this.session = await this.sessionPromise;
    } catch (error) {
      this.logger.error({ err: error }, 'failed to create genai session');
      this.sendError('model_connect_failed', (error as Error).message);
      this.teardown('model_connect_failed');
    }
  }

  private forwardAudioChunk(message: ClientAudioChunkMessage) {
    if (!this.sessionPromise) {
      this.sendError('session_not_ready', 'Session not yet initialized');
      return;
    }
    const blob = this.toAudioBlob(
      message.payload.chunk,
      message.payload.sampleRate
    );
    this.sessionPromise
      .then((session) => {
        if (!this.active) return;
        session.sendRealtimeInput({ media: blob });
      })
      .catch((error) => {
        this.logger.error({ err: error }, 'failed to forward audio chunk');
        this.sendError('forward_failed', (error as Error).message);
      });
  }

  private handleGenAiMessage(event: LiveServerMessage) {
    const { serverContent } = event;
    if (!serverContent) return;

    const inputText = serverContent.inputTranscription?.text;
    if (serverContent.turnComplete && inputText) {
      this.send({
        type: SocketMessageType.SERVER_TRANSCRIPT,
        payload: { role: 'user', text: inputText, final: true },
        timestamp: Date.now()
      });
    }

    const outputText = serverContent.outputTranscription?.text;
    if (serverContent.turnComplete && outputText) {
      this.send({
        type: SocketMessageType.SERVER_TRANSCRIPT,
        payload: { role: 'model', text: outputText, final: true },
        timestamp: Date.now()
      });
    }

    const base64Audio = serverContent.modelTurn?.parts?.[0]?.inlineData?.data;
    if (base64Audio) {
      this.send({
        type: SocketMessageType.SERVER_AUDIO_CHUNK,
        payload: {
          chunk: base64Audio,
          sampleRate: OUTPUT_SAMPLE_RATE,
          isLastChunk: Boolean(serverContent.turnComplete)
        },
        timestamp: Date.now(),
        seq: this.nextSeq()
      });
    }

    if (serverContent.interrupted) {
      this.sendStatus(ConnectionState.CONNECTED, 'Model interrupted response');
    }
  }

  private toAudioBlob(base64Chunk: string, sampleRate: number): GenAIBlob {
    // GenAI expects base64-encoded PCM payloads
    return {
      data: base64Chunk,
      mimeType: `audio/pcm;rate=${sampleRate}`
    };
  }

  private sendStatus(state: ConnectionState, detail?: string) {
    this.send({
      type: SocketMessageType.SERVER_STATUS,
      payload: { state, detail },
      timestamp: Date.now()
    });
  }

  private sendError(code: string, message: string) {
    const payload: ServerErrorMessage = {
      type: SocketMessageType.SERVER_ERROR,
      payload: { code, message },
      timestamp: Date.now()
    };
    this.send(payload);
  }

  private send(message: ServerSocketMessage) {
    if (this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  private nextSeq() {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  private teardown(reason: string) {
    if (this.cleanedUp) {
      return;
    }
    this.cleanedUp = true;

    this.sendStatus(ConnectionState.DISCONNECTED, reason);

    if (this.session) {
      try {
        this.session.close();
      } catch (error) {
        this.logger.warn({ err: error }, 'failed to close genai session');
      }
    }
    this.active = false;
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.close(1000, reason);
    }
  }
}

