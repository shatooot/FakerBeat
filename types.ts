export interface AudioStats {
  duration: number;
  sampleRate: number;
  numberOfChannels: number;
  rms: number; 
  peak: number;
  crestFactor: number;
  // Spectral distribution (0-1 range relative energy)
  lowEnergy: number;    // < 200Hz
  midEnergy: number;    // 200Hz - 5kHz
  highEnergy: number;   // > 5kHz
  subBassEnergy: number; // < 40Hz (Rumble check)
  stereoCorrelation: number; // -1 to 1 (Width check)
}

export interface MasteringSettings {
  // Global
  inputGain: number; 
  limiterCeiling: number; 

  // Enhancement
  saturation: number; 
  stereoWidth: number; 

  // 3-Band EQ
  eqLow: number;
  eqMid: number;
  eqHigh: number;

  // Multiband Compression (Thresholds per band)
  mbLowThreshold: number;
  mbMidThreshold: number;
  mbHighThreshold: number;
}

export enum AppState {
  IDLE = 'IDLE',
  ANALYZING = 'ANALYZING',
  READY_TO_MASTER = 'READY_TO_MASTER',
  MASTERING = 'MASTERING', 
  PLAYBACK = 'PLAYBACK'
}