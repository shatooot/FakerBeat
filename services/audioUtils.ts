import { AudioStats } from "../types";

// Utility to convert AudioBuffer to WAV Blob
export function bufferToWave(abuffer: AudioBuffer, len: number): Blob {
  let numOfChan = abuffer.numberOfChannels;
  let length = len * numOfChan * 2 + 44;
  let buffer = new ArrayBuffer(length);
  let view = new DataView(buffer);
  let channels = [];
  let i;
  let sample;
  let offset = 0;
  let pos = 0;

  function setUint16(data: number) {
    view.setUint16(pos, data, true);
    pos += 2;
  }

  function setUint32(data: number) {
    view.setUint32(pos, data, true);
    pos += 4;
  }

  setUint32(0x46464952); // "RIFF"
  setUint32(length - 8); 
  setUint32(0x45564157); // "WAVE"
  setUint32(0x20746d66); // "fmt "
  setUint32(16); 
  setUint16(1); 
  setUint16(numOfChan);
  setUint32(abuffer.sampleRate);
  setUint32(abuffer.sampleRate * 2 * numOfChan); 
  setUint16(numOfChan * 2); 
  setUint16(16); 
  setUint32(0x61746164); 
  setUint32(length - pos - 4); 

  for (i = 0; i < abuffer.numberOfChannels; i++)
    channels.push(abuffer.getChannelData(i));

  while (pos < len) {
    for (i = 0; i < numOfChan; i++) {
      sample = Math.max(-1, Math.min(1, channels[i][pos])); 
      sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0; 
      view.setInt16(44 + offset, sample, true); 
      offset += 2;
    }
    pos++;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

export function calculateAudioStats(buffer: AudioBuffer): AudioStats {
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  
  let sumSquares = 0;
  let peak = 0;
  let stereoSum = 0;
  
  // Spectral buckets
  let lowSum = 0;
  let midSum = 0;
  let highSum = 0;
  let subSum = 0;

  // We analyze a representative sample of 15 seconds to avoid performance lag
  const durationToAnalyze = Math.min(buffer.duration, 15);
  const sampleSize = Math.floor(durationToAnalyze * buffer.sampleRate);
  const startOffset = Math.floor(buffer.length / 2 - sampleSize / 2); // Center analysis on the likely "drop"
  const actualStart = Math.max(0, startOffset);

  // Constants for approximate frequency weighted analysis
  for (let i = actualStart; i < Math.min(actualStart + sampleSize, buffer.length); i++) {
    const sL = left[i];
    const sR = right[i];
    const mid = (sL + sR) / 2;

    const absMid = Math.abs(mid);
    if (absMid > peak) peak = absMid;
    sumSquares += mid * mid;

    // Stereo correlation check (Dot product approximation)
    stereoSum += sL * sR;

    // Spectral approximation
    if (i > actualStart) {
      const diff = Math.abs(mid - left[i-1]);
      const smooth = (mid + left[i-1]) / 2;
      
      highSum += diff * diff; // High freq energy
      lowSum += smooth * smooth; // Low freq energy
      
      if (i % 10 === 0) {
        subSum += Math.abs(mid) > 0.1 ? 1 : 0;
      }
    }
  }

  const rms = Math.sqrt(sumSquares / Math.max(1, sampleSize));
  const rmsDb = 20 * Math.log10(rms || 0.000001);
  const peakDb = 20 * Math.log10(peak || 0.000001);
  
  const correlation = stereoSum / (sumSquares || 1); // -1 (anti-phase) to 1 (mono)

  // Energy distribution normalized
  const totalSpec = lowSum + highSum;
  
  return {
    rms: rmsDb,
    peak: peakDb,
    crestFactor: peakDb - rmsDb,
    duration: buffer.duration,
    sampleRate: buffer.sampleRate,
    numberOfChannels: buffer.numberOfChannels,
    lowEnergy: lowSum / (totalSpec || 1),
    midEnergy: 0.5, // Reference mid
    highEnergy: highSum / (totalSpec || 1),
    subBassEnergy: subSum / (Math.max(1, sampleSize) / 10),
    stereoCorrelation: Math.max(-1, Math.min(1, correlation))
  };
}

export function calculateProductionScore(stats: AudioStats): number {
  let score = 100;

  if (stats.peak > -0.1) score -= 30; // Clipping
  if (stats.crestFactor < 4) score -= 20; // Too crushed
  if (stats.crestFactor > 15) score -= 15; // Too dynamic for Techno
  
  // Phase check
  if (stats.stereoCorrelation < 0) score -= 40; // Phase cancellation issues
  if (stats.stereoCorrelation > 0.95) score -= 10; // Mix is too mono

  return Math.max(0, Math.min(100, Math.floor(score)));
}

export function makeDistortionCurve(amount: number) {
  const k = amount; 
  const n_samples = 44100;
  const curve = new Float32Array(n_samples);
  for (let i = 0; i < n_samples; ++i) {
    const x = (i * 2) / n_samples - 1;
    const drive = 1 + (k / 10); 
    curve[i] = (2 / Math.PI) * Math.atan(x * drive);
  }
  return curve;
}

export async function detectBPM(buffer: AudioBuffer): Promise<number> {
  try {
    // Optimization: Only process a 30s slice from the middle of the track
    // instead of the whole file. Techno is usually consistent.
    const sliceDuration = 30;
    const startSample = Math.floor((buffer.duration / 2) * buffer.sampleRate);
    const endSample = Math.min(buffer.length, startSample + (sliceDuration * buffer.sampleRate));
    const sliceLength = endSample - startSample;
    
    if (sliceLength <= 0) return 128;

    const offlineCtx = new OfflineAudioContext(1, sliceLength, buffer.sampleRate);
    const source = offlineCtx.createBufferSource();
    
    // Copy channel data for the slice
    const tempBuffer = offlineCtx.createBuffer(1, sliceLength, buffer.sampleRate);
    const originalData = buffer.getChannelData(0);
    const sliceData = tempBuffer.getChannelData(0);
    
    for (let i = 0; i < sliceLength; i++) {
        sliceData[i] = originalData[startSample + i];
    }
    
    source.buffer = tempBuffer;
    
    const filter = offlineCtx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 150;
    source.connect(filter);
    filter.connect(offlineCtx.destination);
    source.start(0);
    
    const renderedBuffer = await offlineCtx.startRendering();
    const data = renderedBuffer.getChannelData(0);
    const peaks = [];
    const threshold = 0.4; 
    
    for(let i = 0; i < data.length; i+=1000) {
        if(data[i] > threshold && (peaks.length === 0 || i - peaks[peaks.length-1] > 2000)) {
          peaks.push(i);
        }
    }
    
    const intervals = [];
    for(let i = 1; i < peaks.length; i++) {
        intervals.push(peaks[i] - peaks[i-1]);
    }
    
    const counts: Record<number, number> = {};
    intervals.forEach(int => {
        const q = Math.round(int / 100) * 100; 
        counts[q] = (counts[q] || 0) + 1;
    });
    
    let maxCount = 0;
    let bestInterval = 0;
    Object.entries(counts).forEach(([interval, count]) => {
        if(count > maxCount) {
          maxCount = count;
          bestInterval = Number(interval);
        }
    });
    
    if(bestInterval === 0) return 128; 
    let bpm = (60 * buffer.sampleRate) / bestInterval;
    while (bpm < 110) bpm *= 2;
    while (bpm > 155) bpm /= 2;
    return Math.round(bpm);
  } catch (e) {
    console.error("BPM Detection failed", e);
    return 128;
  }
}

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export async function analyzeKeyReal(buffer: AudioBuffer): Promise<string> {
    try {
        // MUST use matching sample rate to the input buffer
        const analysisLength = Math.min(buffer.length, buffer.sampleRate * 2);
        const offlineCtx = new OfflineAudioContext(1, analysisLength, buffer.sampleRate); 
        const source = offlineCtx.createBufferSource();
        source.buffer = buffer;
        const filter = offlineCtx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = 1000; 
        source.connect(filter);
        filter.connect(offlineCtx.destination);
        source.start(0);
        const rendered = await offlineCtx.startRendering();
        const data = rendered.getChannelData(0);
        let bestOffset = -1;
        let maxCorr = 0;
        // Pitch detection via autocorrelation approximation
        for (let offset = Math.floor(buffer.sampleRate / 1000); offset < Math.floor(buffer.sampleRate / 40); offset++) {
            let corr = 0;
            for (let i = 0; i < data.length - offset; i += 20) {
                corr += data[i] * data[i + offset];
            }
            if (corr > maxCorr) {
                maxCorr = corr;
                bestOffset = offset;
            }
        }
        if (bestOffset === -1) return "Unknown";
        const freq = buffer.sampleRate / bestOffset;
        const noteNum = 12 * (Math.log(freq / 440) / Math.log(2));
        const midi = Math.round(noteNum) + 69;
        const noteIndex = midi % 12;
        return NOTES[noteIndex] || "Unknown";
    } catch(e) {
        console.error("Key analysis failed:", e);
        return "Unknown";
    }
}