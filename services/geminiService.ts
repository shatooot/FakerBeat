import { GoogleGenAI, Type, FunctionDeclaration } from "@google/genai";
import { AudioStats } from "../types";

// Safe access to process.env.API_KEY to prevent ReferenceError if process is undefined
const getApiKey = () => {
  try {
    return typeof process !== 'undefined' ? process.env.API_KEY : '';
  } catch (e) {
    return '';
  }
};

const GEMINI_API_KEY = getApiKey();

export const analyzeTrackWithAI = async (stats: AudioStats, filename: string): Promise<string> => {
  if (!GEMINI_API_KEY) {
    return "[SYSTEM_FAILURE] API Key missing. Unable to initialize Neural Engine.";
  }

  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

  const prompt = `
    You are the "TechnoMaster Core v2.5", a high-performance audio analyzer for electronic music production.
    Mix Target: Club-ready Techno (Raw, Hypnotic, or Peak-Time).
    
    Telemetry Report:
    [SOURCE]: ${filename}
    [DYNAMIC_RANGE]: ${stats.crestFactor.toFixed(2)} dB
    [LOUDNESS]: ${stats.rms.toFixed(2)} dB RMS
    [SPECTRAL_TILT]: Low:${(stats.lowEnergy * 100).toFixed(0)}% | High:${(stats.highEnergy * 100).toFixed(0)}%
    [STEREO_FIELD]: ${(stats.stereoCorrelation * 100).toFixed(0)}% Correlation
    [SUB_BASS_DENSITY]: ${(stats.subBassEnergy * 100).toFixed(0)}%
    
    Audit Directives:
    1. Transient Integrity analysis.
    2. Low-End Authority analysis.
    3. Stereo Image check.
    4. Spectral Balance suggestions.
    
    Format: System Log lines, technical, cold, max 8 lines.
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: prompt,
    });
    return response.text || "[ERROR] Audit stream timed out.";
  } catch (error) {
    return "[SYSTEM_ERROR] AI Neural Link severed.";
  }
};

export const controlAppFunctionDeclarations: FunctionDeclaration[] = [
  {
    name: 'update_mastering_settings',
    description: 'Adjust the audio mastering parameters based on user request.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        eqLow: { type: Type.NUMBER, description: 'Low shelf gain (-12 to 12 dB)' },
        eqMid: { type: Type.NUMBER, description: 'Mid peak gain (-12 to 12 dB)' },
        eqHigh: { type: Type.NUMBER, description: 'High shelf gain (-12 to 12 dB)' },
        saturation: { type: Type.NUMBER, description: 'Saturation amount (0 to 100 %)' },
        stereoWidth: { type: Type.NUMBER, description: 'Stereo width (0 to 200 %)' },
        inputGain: { type: Type.NUMBER, description: 'Input gain (-12 to 12 dB)' },
        limiterCeiling: { type: Type.NUMBER, description: 'Limiter ceiling (-3 to 0 dB)' },
      },
    },
  },
  {
    name: 'playback_control',
    description: 'Control the playback of the audio track.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: { type: Type.STRING, enum: ['play', 'pause'], description: 'The playback action to perform' },
      },
      required: ['action'],
    },
  },
  {
    name: 'navigation_control',
    description: 'Jump forward or backward in the track.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        direction: { type: Type.STRING, enum: ['forward', 'backward'], description: 'Jump direction (8 bars)' },
      },
      required: ['direction'],
    },
  },
];

export async function chatWithAI(
  message: string,
  history: any[],
  stats: AudioStats | null,
  currentSettings: any
) {
  if (!GEMINI_API_KEY) {
     return { text: "System Alert: Neural Engine offline. API Key not detected." };
  }

  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  
  const systemInstruction = `
    You are the "TechnoMaster AI Assistant". You help users master their Techno tracks.
    You have access to current audio statistics: ${JSON.stringify(stats)}.
    Current settings: ${JSON.stringify(currentSettings)}.
    
    When a user asks to change something (e.g., "add more bass", "make it louder", "play the track"), 
    you MUST use the provided tools to execute the change.
    
    Guidelines:
    - Be professional, concise, and helpful.
    - If you change settings, explain briefly why you chose those values for a Techno context.
    - For Techno, "warmth" usually means more saturation and a slight low-shelf boost.
    - "Power" or "Punch" usually means adjusting the input gain and high-shelf.
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: [...history, { role: 'user', parts: [{ text: message }] }],
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: controlAppFunctionDeclarations }],
      },
    });

    return response;
  } catch (error) {
    console.error("Chat error:", error);
    throw error;
  }
}