/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// FIX: `LiveSession` is not an exported member and has been removed from the import.
import {
  GoogleGenAI,
  LiveServerMessage,
  Modality,
  Blob,
  FunctionDeclaration,
  Type
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

// Transcripciones y elementos de UI en tiempo real
let currentInputTranscription = '';
let currentOutputTranscription = '';
let currentUserMessageEl: HTMLDivElement | null = null;
let currentModelMessageEl: HTMLDivElement | null = null;

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

// --- FUNCIÓN DE HERRAMIENTA MCP ---
async function fetchSalesOrderDetails(salesOrderID: string): Promise<any> {
  const url = '/mcp-api'; // Proxy hacia el servidor MCP para evitar errores CORS en desarrollo
  const requestBody = {
    method: "tools/call",
    params: {
      name: "getSalesOrderDetails",
      arguments: { salesOrderID },
      _meta: { progressToken: 0 }
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error("Error al consultar el servidor MCP:", error);
    throw error;
  }
}

// --- DECLARACIÓN DE HERRAMIENTA PARA GEMINI ---
const getSalesOrderDetailsTool: FunctionDeclaration = {
  name: 'getSalesOrderDetails',
  description: 'Obtiene los detalles de una orden de venta específica usando su ID.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      salesOrderID: {
        type: Type.STRING,
        description: 'El ID de la orden de venta a consultar.',
      },
    },
    required: ['salesOrderID'],
  },
};


// --- LÓGICA DE LA INTERFAZ ---

function updateButton(recording: boolean, error: boolean = false) {
  isRecording = recording;
  toggleButton.classList.toggle('recording', recording);
  buttonText.textContent = recording ? 'Finalizar Conversación' : 'Iniciar Conversación';
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
  currentUserMessageEl = null;
  currentModelMessageEl = null;

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
        systemInstruction: 'Eres un asistente amigable y conversacional. Habla en español. También puedes ayudar a consultar detalles de órdenes de venta.',
        tools: [{functionDeclarations: [getSalesOrderDetailsTool]}],
      },
      callbacks: {
        onopen: () => {
          updateStatus('Conexión establecida. Di algo...');
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
          // Gestionar llamadas a herramientas (function calling)
          if (message.toolCall) {
            for (const fc of message.toolCall.functionCalls) {
              if (fc.name === 'getSalesOrderDetails') {
                updateStatus(`Consultando orden ${fc.args.salesOrderID}...`);
                try {
                  // FIX: The `FunctionCall` arguments from the Gemini API are of type `unknown`. Cast to string.
                  const result = await fetchSalesOrderDetails(fc.args.salesOrderID as string);
                  const resultString = JSON.stringify(result);
                  
                  sessionPromise?.then((session) => {
                    session.sendToolResponse({
                      functionResponses: {
                        id: fc.id,
                        name: fc.name,
                        response: { result: resultString },
                      },
                    });
                  });
                } catch (error) {
                  console.error('Error en la llamada a la herramienta:', error);
                  // FIX: Safely access the message property from the 'unknown' error type.
                  const errorMessage = error instanceof Error ? error.message : String(error);
                  sessionPromise?.then((session) => {
                    session.sendToolResponse({
                      functionResponses: {
                        id: fc.id,
                        name: fc.name,
                        response: { result: `Error al obtener los detalles: ${errorMessage}` },
                      },
                    });
                  });
                }
              }
            }
          }

          // Gestionar transcripciones en tiempo real
          if (message.serverContent?.inputTranscription) {
            currentInputTranscription += message.serverContent.inputTranscription.text;
            if (!currentUserMessageEl) {
              currentUserMessageEl = document.createElement('div');
              currentUserMessageEl.classList.add('message', 'user-message', 'in-progress');
              chatContainer.appendChild(currentUserMessageEl);
            }
            currentUserMessageEl.textContent = currentInputTranscription;
            updateStatus('Escuchando...');
          }

          if (message.serverContent?.outputTranscription) {
            if (currentUserMessageEl) {
              currentUserMessageEl.classList.remove('in-progress');
              currentUserMessageEl = null;
            }
            currentOutputTranscription += message.serverContent.outputTranscription.text;
            if (!currentModelMessageEl) {
              currentModelMessageEl = document.createElement('div');
              currentModelMessageEl.classList.add('message', 'model-message', 'in-progress');
              chatContainer.appendChild(currentModelMessageEl);
            }
            currentModelMessageEl.textContent = currentOutputTranscription;
            updateStatus('Gemini está respondiendo...');
          }

          // Un turno se completa cuando Gemini termina de hablar
          if (message.serverContent?.turnComplete) {
            if (currentModelMessageEl) {
              currentModelMessageEl.classList.remove('in-progress');
            }
            if (currentUserMessageEl) { // Caso: el usuario habló pero Gemini no respondió
              currentUserMessageEl.classList.remove('in-progress');
            }
            
            // Reiniciar para el siguiente turno
            currentUserMessageEl = null;
            currentModelMessageEl = null;
            currentInputTranscription = '';
            currentOutputTranscription = '';
            updateStatus('Di algo...');
          }
          
          chatContainer.scrollTop = chatContainer.scrollHeight;

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
    // FIX: Safely access the message property from the 'unknown' error type.
    const errorMessage = error instanceof Error ? error.message : String(error);
    updateStatus(`Error al iniciar: ${errorMessage}`);
    stopConversation(true);
  }
}

function stopConversation(error: boolean = false) {
    if (!isRecording && !error) return; // Ya está detenido

    updateStatus(error ? 'Error, conexión cerrada.' : 'Finalizando...');

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
    currentUserMessageEl = null;
    currentModelMessageEl = null;

    updateButton(false, error);
    if (!error) updateStatus('Listo para iniciar una nueva conversación.');
}


// --- INICIALIZACIÓN ---
toggleButton.addEventListener('click', toggleConversation);
updateStatus('Listo para iniciar una nueva conversación.');