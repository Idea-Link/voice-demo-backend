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
  StartSensitivity,
  EndSensitivity,
  type Blob as GenAIBlob
} from '@google/genai';
import { getSystemInstruction } from '../constants/systemInstruction.js';
import { tokenStore } from './tokenStore.js';

type LiveSession = Awaited<ReturnType<GoogleGenAI['live']['connect']>>;

const OUTPUT_SAMPLE_RATE = 24000;

export class LiveSocketSession {
  private sessionPromise: Promise<LiveSession> | null = null;
  private session: LiveSession | null = null;
  private seqCounter = 0;
  private active = false;
  private sessionId = randomUUID();
  private cleanedUp = false;
  private recordingToken: string;

  // Store bound handlers for cleanup
  private boundMessageHandler: ((raw: Buffer) => void) | null = null;
  private boundCloseHandler: (() => void) | null = null;
  private boundErrorHandler: ((err: Error) => void) | null = null;

  constructor(
    private socket: WebSocket & { OPEN: number },
    private ai: GoogleGenAI,
    private logger: FastifyBaseLogger
  ) {
    // Generate recording token for this session
    this.recordingToken = tokenStore.generateToken(this.sessionId);
  }

  public bind() {
    this.logger.info({ sessionId: this.sessionId }, 'client connected');
    this.sendStatus(ConnectionState.CONNECTING, 'Awaiting client hello');

    this.boundMessageHandler = (raw: Buffer) => {
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
    };

    this.boundCloseHandler = () => {
      this.logger.info({ sessionId: this.sessionId }, 'socket closed by client');
      this.teardown('socket_closed');
    };

    this.boundErrorHandler = (err: Error) => {
      this.logger.error({ err }, 'socket error');
      this.sendError('socket_error', err.message);
      this.teardown('socket_error');
    };

    this.socket.on('message', this.boundMessageHandler);
    this.socket.on('close', this.boundCloseHandler);
    this.socket.on('error', this.boundErrorHandler);
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
    // Note: GEMINI_API_KEY and GENAI_MODEL are validated at server startup

    // Get the appropriate system instruction based on the app route
    const appRoute = message.payload.appRoute;
    const systemInstruction = getSystemInstruction(appRoute);
    
    this.logger.info(
      { sessionId: this.sessionId, appRoute },
      `Initializing session with ${appRoute === '/outbound' ? 'outbound sales' : 'default'} system prompt`
    );

    this.sessionPromise = this.ai.live.connect({
      model: process.env.GENAI_MODEL!, // Validated at server startup
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: systemInstruction,
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
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
            prefixPaddingMs: 100,
            silenceDurationMs: 1000,
          },
        },
      },
      callbacks: {
        onopen: async () => {
          this.logger.info({ sessionId: this.sessionId }, 'genai session opened');
          this.active = true;
          this.send({
            type: SocketMessageType.SERVER_READY,
            payload: { 
              sessionId: this.sessionId,
              recordingToken: this.recordingToken
            },
            timestamp: Date.now()
          });
          this.sendStatus(ConnectionState.CONNECTED, 'Live session ready');
          
          // Trigger the model to start speaking immediately
          try {
            const session = await this.sessionPromise;
            if (session && this.active) {
              session.sendClientContent({
                turns: [{ role: 'user', parts: [{ text: '[Call connected. Begin the conversation.]' }] }],
                turnComplete: true
              });
              this.logger.info({ sessionId: this.sessionId }, 'sent initial trigger to start conversation');
            }
          } catch (error) {
            this.logger.error({ err: error }, 'failed to send initial trigger');
          }
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

    const base64Audio = serverContent.modelTurn?.parts?.[0]?.inlineData?.data;
    if (base64Audio) {
      const isLastChunk = Boolean(serverContent.turnComplete);
      
      this.send({
        type: SocketMessageType.SERVER_AUDIO_CHUNK,
        payload: {
          chunk: base64Audio,
          sampleRate: OUTPUT_SAMPLE_RATE,
          isLastChunk
        },
        timestamp: Date.now(),
        seq: this.nextSeq()
      });
    }

    if (serverContent.interrupted) {
      // Send flush signal to client so it can clear its audio queue immediately
      this.send({
        type: SocketMessageType.SERVER_AUDIO_FLUSH,
        payload: { reason: 'interrupted' },
        timestamp: Date.now()
      });
      this.logger.info({ sessionId: this.sessionId }, 'model response interrupted, sent audio flush');
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

    // Mark connection as closed - token becomes invalid
    tokenStore.markConnectionClosed(this.sessionId);

    // Remove socket event listeners to prevent memory leaks
    if (this.boundMessageHandler) {
      this.socket.off('message', this.boundMessageHandler);
    }
    if (this.boundCloseHandler) {
      this.socket.off('close', this.boundCloseHandler);
    }
    if (this.boundErrorHandler) {
      this.socket.off('error', this.boundErrorHandler);
    }

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

