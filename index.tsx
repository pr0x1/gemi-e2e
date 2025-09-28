/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// FIX: `LiveSession` is not an exported member and has been removed from the import.
import {
  GoogleGenAI,
  LiveServerMessage,
  Modality,
  Blob
} from '@google/genai';

// --- ELEMENTOS DEL DOM ---
const toggleButton = document.getElementById('toggle-button') as HTMLButtonElement;
const buttonText = toggleButton.querySelector('span') as HTMLSpanElement;
const chatContainer = document.getElementById('chat-container') as HTMLDivElement;
const statusDiv = document.getElementById('status') as HTMLDivElement;

// --- ESTADO DE LA APLICACIÓN ---
let isRecording = false;
// FIX: The type `LiveSession` is not exported, so the promise is now typed with `any`.
let sessionPromise: Promise<any> | null = null;
let mediaStream: MediaStream | null = null;
let inputAudioContext: AudioContext | null = null;
let outputAudioContext: AudioContext | null = null;
let scriptProcessor: ScriptProcessorNode | null = null;
let nextStartTime = 0;
const outputSources = new Set<AudioBufferSourceNode>();

// Transcripciones parciales
let currentInputTranscription = '';
let currentOutputTranscription = '';

// --- INICIALIZACIÓN DE LA API ---
// Se asume que API_KEY está configurada en el entorno de ejecución
const ai = new GoogleGenAI({apiKey: process.env.API_KEY});

// --- FUNCIONES DE AUDIO ---

// Codifica audio PCM a Base64
function encode(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Decodifica Base64 a bytes
function decode(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// Crea un Blob para enviar a la API
function createBlob(data: Float32Array): Blob {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] * 32768;
  }
  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
}

// Decodifica los bytes de audio recibidos para poder reproducirlos
async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}


// --- LÓGICA DE LA INTERFAZ ---

function addChatMessage(text: string, sender: 'user' | 'model') {
  if (!text.trim()) return;
  const messageElement = document.createElement('div');
  messageElement.classList.add('message', `${sender}-message`);
  messageElement.textContent = text;
  chatContainer.appendChild(messageElement);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function updateButton(recording: boolean, error: boolean = false) {
  isRecording = recording;
  toggleButton.classList.toggle('recording', recording);
  buttonText.textContent = recording ? 'Detener Conversación' : 'Iniciar Conversación';
  toggleButton.disabled = error;
}

function updateStatus(message: string) {
    statusDiv.textContent = message;
}

// --- LÓGICA PRINCIPAL ---

async function toggleConversation() {
  if (isRecording) {
    stopConversation();
  } else {
    await startConversation();
  }
}

async function startConversation() {
  updateButton(true);
  updateStatus('Iniciando...');
  chatContainer.innerHTML = ''; // Limpiar chat al iniciar

  try {
    // Contextos de audio (se crean aquí para asegurar que el usuario interactuó con la página)
    // FIX: Cast window to `any` to allow access to `webkitAudioContext` for older browsers, resolving TypeScript error.
    inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({sampleRate: 16000});
    outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({sampleRate: 24000});
    
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // FIX: `vadConfig` is not a valid property and has been removed from the `config` object below.
    sessionPromise = ai.live.connect({
      model: 'gemini-2.5-flash-native-audio-preview-09-2025',
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: 'Eres un asistente amigable y conversacional. Habla en español.',
      },
      callbacks: {
        onopen: () => {
          updateStatus('Conexión establecida. Esperando que hables...');
          // Transmitir audio del micrófono al modelo
          const source = inputAudioContext.createMediaStreamSource(mediaStream);
          scriptProcessor = inputAudioContext.createScriptProcessor(4096, 1, 1);
          scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
            const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
            const pcmBlob = createBlob(inputData);
            sessionPromise?.then((session) => {
              session.sendRealtimeInput({ media: pcmBlob });
            });
          };
          source.connect(scriptProcessor);
          scriptProcessor.connect(inputAudioContext.destination);
        },
        onmessage: async (message: LiveServerMessage) => {
          // FIX: `vadSignal` does not exist on `LiveServerContent`, so related logic has been removed.
            
          // Gestionar transcripciones
          if (message.serverContent?.inputTranscription) {
            currentInputTranscription += message.serverContent.inputTranscription.text;
          }
          if (message.serverContent?.outputTranscription) {
            currentOutputTranscription += message.serverContent.outputTranscription.text;
          }
          if (message.serverContent?.turnComplete) {
            addChatMessage(currentInputTranscription, 'user');
            addChatMessage(currentOutputTranscription, 'model');
            currentInputTranscription = '';
            currentOutputTranscription = '';
            updateStatus('Esperando que hables...');
          }
          
          // Gestionar audio de salida
          const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
          if (audioData) {
            nextStartTime = Math.max(nextStartTime, outputAudioContext.currentTime);
            const audioBuffer = await decodeAudioData(
              decode(audioData),
              outputAudioContext,
              24000,
              1,
            );
            const source = outputAudioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(outputAudioContext.destination);
            source.addEventListener('ended', () => {
              outputSources.delete(source);
            });
            source.start(nextStartTime);
            nextStartTime += audioBuffer.duration;
            outputSources.add(source);
          }

          // Gestionar interrupciones
          if (message.serverContent?.interrupted) {
            for (const source of outputSources.values()) {
              source.stop();
              outputSources.delete(source);
            }
            nextStartTime = 0;
          }
        },
        onerror: (e: ErrorEvent) => {
          console.error('Error en la conexión:', e);
          updateStatus(`Error: ${e.message}`);
          stopConversation(true);
        },
        onclose: (e: CloseEvent) => {
          updateStatus('Conversación finalizada.');
          stopConversation();
        },
      },
    });

    // Esperar a que la sesión se establezca para evitar condiciones de carrera
    await sessionPromise;

  } catch (error) {
    console.error('Fallo al iniciar la conversación:', error);
    updateStatus(`Error al iniciar: ${error.message}`);
    stopConversation(true);
  }
}

function stopConversation(error: boolean = false) {
    if (!isRecording && !error) return; // Ya está detenido

    updateStatus(error ? 'Error, conexión cerrada.' : 'Deteniendo...');

    // Cerrar sesión de Gemini
    sessionPromise?.then(session => session.close());
    sessionPromise = null;

    // Detener y limpiar recursos de audio
    if (scriptProcessor) {
        scriptProcessor.disconnect();
        scriptProcessor = null;
    }
    mediaStream?.getTracks().forEach(track => track.stop());
    mediaStream = null;
    
    inputAudioContext?.close().catch(console.error);
    outputAudioContext?.close().catch(console.error);
    inputAudioContext = null;
    outputAudioContext = null;

    outputSources.forEach(source => source.stop());
    outputSources.clear();
    nextStartTime = 0;
    
    currentInputTranscription = '';
    currentOutputTranscription = '';

    updateButton(false, error);
    if (!error) updateStatus('Listo para iniciar una nueva conversación.');
}


// --- INICIALIZACIÓN ---
toggleButton.addEventListener('click', toggleConversation);
updateStatus('Listo para iniciar una nueva conversación.');
