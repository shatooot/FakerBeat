import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Upload, Play, Pause, Download, RefreshCw, Sliders, Terminal, Disc, Rewind, FastForward, MessageSquare, Send, Sparkles, X, ChevronRight } from 'lucide-react';
import { AppState, AudioStats, MasteringSettings } from './types';
import { bufferToWave, calculateAudioStats, calculateProductionScore, makeDistortionCurve, detectBPM, analyzeKeyReal } from './services/audioUtils';
import { analyzeTrackWithAI, chatWithAI } from './services/geminiService';
import Visualizer from './components/Visualizer';
import Knob from './components/Knob';

// Define the graph structure for real-time updates
interface AudioGraph {
  inputGain: GainNode;
  rumbleFilter: BiquadFilterNode;
  saturation: WaveShaperNode;
  lowShelf: BiquadFilterNode;
  midPeaking: BiquadFilterNode;
  highShelf: BiquadFilterNode;
  // Stereo Width Nodes
  midGain: GainNode; 
  sideGain: GainNode; 
  // Multiband
  mbLow: DynamicsCompressorNode;
  mbMid: DynamicsCompressorNode;
  mbHigh: DynamicsCompressorNode;
  limiter: DynamicsCompressorNode;
}

const App: React.FC = () => {
  // State
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [fileName, setFileName] = useState<string>('');
  const [stats, setStats] = useState<AudioStats | null>(null);
  const [score, setScore] = useState<number>(0);
  const [aiLogs, setAiLogs] = useState<string[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBypassed, setIsBypassed] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [activeTab, setActiveTab] = useState<'MENTOR' | 'ARCHITECT'>('MENTOR');
  
  // Chat State
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'model'; text: string }[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);
  
  // Real-time Metering State
  const [liveStats, setLiveStats] = useState<{ rms: number; peak: number }>({ rms: -100, peak: -100 });
  
  const [bpm, setBpm] = useState<number>(128);
  const [key, setKey] = useState<string>('--');

  const [settings, setSettings] = useState<MasteringSettings>({
    inputGain: 0,
    limiterCeiling: -0.1, 
    saturation: 5, 
    stereoWidth: 100, 
    eqLow: 0,
    eqMid: 0,
    eqHigh: 0,
    mbLowThreshold: -16,
    mbMidThreshold: -16,
    mbHighThreshold: -16,
  });

  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const originalBufferRef = useRef<AudioBuffer | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const graphRef = useRef<AudioGraph | null>(null); // Store graph for updates
  const startTimeRef = useRef<number>(0); 
  const startOffsetRef = useRef<number>(0); 
  const lastMeterUpdateRef = useRef<number>(0);
  const meterSmoothingRef = useRef({ rms: -100, peak: -100 });
  const chatEndRef = useRef<HTMLDivElement>(null);

  const CROSSOVER_LOW_MID = 200; 
  const CROSSOVER_MID_HIGH = 5000;

  const initAudioContext = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
  };

  const addLog = (text: string) => {
    setAiLogs(prev => [...prev, text]);
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // Real-time Parameter Updates
  useEffect(() => {
    if (!graphRef.current || !audioContextRef.current) return;
    const g = graphRef.current;
    const s = settings;
    const now = audioContextRef.current.currentTime;
    const ramp = 0.05; // 50ms smooth transition to prevent clicks

    // Gain
    g.inputGain.gain.setTargetAtTime(Math.pow(10, s.inputGain / 20), now, ramp);
    
    // EQ
    g.lowShelf.gain.setTargetAtTime(s.eqLow, now, ramp);
    g.midPeaking.gain.setTargetAtTime(s.eqMid, now, ramp);
    g.highShelf.gain.setTargetAtTime(s.eqHigh, now, ramp);

    // Saturation
    g.saturation.curve = makeDistortionCurve(s.saturation);

    // Stereo Width (M/S Gain)
    // Width 100% = 1.0 (Normal), 0% = 0.0 (Mono), 200% = 2.0 (Extra Wide)
    g.sideGain.gain.setTargetAtTime(s.stereoWidth / 100, now, ramp);

    // Compression
    g.mbLow.threshold.setTargetAtTime(s.mbLowThreshold, now, ramp);
    g.mbMid.threshold.setTargetAtTime(s.mbMidThreshold, now, ramp);
    g.mbHigh.threshold.setTargetAtTime(s.mbHighThreshold, now, ramp);

    // Limiter
    g.limiter.threshold.setTargetAtTime(s.limiterCeiling, now, ramp);

  }, [settings]);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    initAudioContext();
    setFileName(file.name);
    setAppState(AppState.ANALYZING);
    setAiLogs([]);
    setIsPlaying(false);
    setCurrentTime(0);
    startOffsetRef.current = 0;
    setLiveStats({ rms: -100, peak: -100 });
    
    addLog(`[SYSTEM] Initializing load sequence...`);
    addLog(`[LOAD] File: ${file.name}`);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const context = audioContextRef.current;
      if (!context) throw new Error("Audio Engine Unavailable");
      
      addLog(`[PROCESS] Decoding audio data...`);
      
      let audioBuffer: AudioBuffer;
      try {
        audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
      } catch (decodeErr) {
        addLog(`[RETRY] Standard decode failed, attempting legacy fallback...`);
        audioBuffer = await new Promise((resolve, reject) => {
          context.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
        });
      }

      originalBufferRef.current = audioBuffer;
      const trackStats = calculateAudioStats(audioBuffer);
      setStats(trackStats);
      setScore(calculateProductionScore(trackStats));
      addLog(`[STATS] RMS: ${trackStats.rms.toFixed(2)}dB | Peak: ${trackStats.peak.toFixed(2)}dB`);

      addLog(`[ANALYSIS] Detecting Tempo and Harmonic Key...`);
      const [detectedBpm, detectedKey] = await Promise.all([
        detectBPM(audioBuffer),
        analyzeKeyReal(audioBuffer)
      ]);
      setBpm(detectedBpm);
      setKey(detectedKey);
      addLog(`[RESULT] Tempo: ${detectedBpm} BPM | Key: ${detectedKey}`);

      const newSettings = { ...settings };
      // Auto-gain Staging
      if (trackStats.peak < -6) newSettings.inputGain = Math.min(6, -3 - trackStats.peak);
      else if (trackStats.peak > -0.5) newSettings.inputGain = -1.0;
      
      // Auto-Compressor Thresholds based on RMS
      newSettings.mbLowThreshold = Math.floor(trackStats.rms - 2); 
      newSettings.mbMidThreshold = Math.floor(trackStats.rms);     
      newSettings.mbHighThreshold = Math.floor(trackStats.rms + 1); 
      setSettings(newSettings);

      addLog(`[AI] Uplink established. Requesting deep analysis...`);
      const analysisText = await analyzeTrackWithAI(trackStats, file.name);
      analysisText.split('\n').filter(l => l.trim().length > 0).forEach((line, i) => {
        setTimeout(() => addLog(line), i * 100);
      });

      setAppState(AppState.READY_TO_MASTER);
      setChatMessages([{ role: 'model', text: "Systems online. Analysis complete. I'm ready to help you optimize this track. What's our first move?" }]);
    } catch (error: any) {
      console.error("Error decoding audio:", error);
      addLog(`[ERROR] Audio decode failed: ${error.message}`);
      setAppState(AppState.IDLE);
    }
  };

  const setupAudioGraph = (ctx: AudioContext, destination: AudioNode) => {
    // 1. Input Gain
    const inputGainNode = ctx.createGain();
    inputGainNode.gain.value = Math.pow(10, settings.inputGain / 20);
    
    // 2. Rumble Filter (Sub Cut)
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'highpass';
    rumbleFilter.frequency.value = 25; 
    
    // 3. Saturation (Warmth)
    const saturationNode = ctx.createWaveShaper();
    saturationNode.curve = makeDistortionCurve(settings.saturation);
    saturationNode.oversample = '4x'; 
    
    // 4. EQ Chain
    const lowShelf = ctx.createBiquadFilter();
    lowShelf.type = 'lowshelf';
    lowShelf.frequency.value = 100;
    lowShelf.gain.value = settings.eqLow;
    
    const midPeaking = ctx.createBiquadFilter();
    midPeaking.type = 'peaking';
    midPeaking.frequency.value = 1000;
    midPeaking.gain.value = settings.eqMid;
    
    const highShelf = ctx.createBiquadFilter();
    highShelf.type = 'highshelf';
    highShelf.frequency.value = 10000;
    highShelf.gain.value = settings.eqHigh;

    inputGainNode.connect(rumbleFilter);
    rumbleFilter.connect(saturationNode);
    saturationNode.connect(lowShelf);
    lowShelf.connect(midPeaking);
    midPeaking.connect(highShelf);

    // 5. Stereo Width Processing (Mid/Side Matrix)
    // HighShelf output goes into Splitter
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);

    highShelf.connect(splitter);

    // M/S Encoding Matrix
    // Mid = (L + R) * 0.5
    // Side = (L - R) * 0.5
    
    const sumL = ctx.createGain(); sumL.gain.value = 0.5;
    const sumR = ctx.createGain(); sumR.gain.value = 0.5;
    const diffL = ctx.createGain(); diffL.gain.value = 0.5;
    const diffR = ctx.createGain(); diffR.gain.value = -0.5;

    splitter.connect(sumL, 0); // L -> SumL
    splitter.connect(sumR, 1); // R -> SumR
    splitter.connect(diffL, 0); // L -> DiffL
    splitter.connect(diffR, 1); // R -> DiffR

    const midSignal = ctx.createGain(); // Holds Mid signal
    const sideSignal = ctx.createGain(); // Holds Side signal
    const sideGain = ctx.createGain(); // Controls Width
    
    sumL.connect(midSignal);
    sumR.connect(midSignal);
    diffL.connect(sideSignal);
    diffR.connect(sideSignal);

    // Width Control applied to Side Signal
    sideGain.gain.value = settings.stereoWidth / 100;
    sideSignal.connect(sideGain);
    
    // M/S Decoding Matrix
    // L = Mid + Side
    // R = Mid - Side
    const outL_Mid = ctx.createGain(); outL_Mid.gain.value = 1;
    const outL_Side = ctx.createGain(); outL_Side.gain.value = 1;
    const outR_Mid = ctx.createGain(); outR_Mid.gain.value = 1;
    const outR_Side = ctx.createGain(); outR_Side.gain.value = -1;

    midSignal.connect(outL_Mid);
    midSignal.connect(outR_Mid);
    sideGain.connect(outL_Side);
    sideGain.connect(outR_Side);

    // Merge back to Stereo
    outL_Mid.connect(merger, 0, 0);
    outL_Side.connect(merger, 0, 0);
    outR_Mid.connect(merger, 0, 1);
    outR_Side.connect(merger, 0, 1);

    // 6. Multiband Compression (Connected to Merger Output)
    const lowFilter = ctx.createBiquadFilter();
    lowFilter.type = 'lowpass';
    lowFilter.frequency.value = CROSSOVER_LOW_MID;
    const lowComp = ctx.createDynamicsCompressor();
    lowComp.threshold.value = settings.mbLowThreshold;
    lowComp.ratio.value = 2.5; 
    
    const midLowCut = ctx.createBiquadFilter();
    midLowCut.type = 'highpass';
    midLowCut.frequency.value = CROSSOVER_LOW_MID;
    const midHighCut = ctx.createBiquadFilter();
    midHighCut.type = 'lowpass';
    midHighCut.frequency.value = CROSSOVER_MID_HIGH;
    const midComp = ctx.createDynamicsCompressor();
    midComp.threshold.value = settings.mbMidThreshold;
    midComp.ratio.value = 2; 
    
    const highFilter = ctx.createBiquadFilter();
    highFilter.type = 'highpass';
    highFilter.frequency.value = CROSSOVER_MID_HIGH;
    const highComp = ctx.createDynamicsCompressor();
    highComp.threshold.value = settings.mbHighThreshold;
    highComp.ratio.value = 1.5; 

    // Route Merger (Stereo) into Crossovers
    merger.connect(lowFilter);
    lowFilter.connect(lowComp);
    
    merger.connect(midLowCut);
    midLowCut.connect(midHighCut);
    midHighCut.connect(midComp);
    
    merger.connect(highFilter);
    highFilter.connect(highComp);

    // Sum compressed bands
    const compSumNode = ctx.createGain();
    lowComp.connect(compSumNode);
    midComp.connect(compSumNode);
    highComp.connect(compSumNode);

    // 7. Limiter (Final Stage)
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = settings.limiterCeiling;
    limiter.ratio.value = 20; 
    limiter.attack.value = 0.002; 
    compSumNode.connect(limiter);

    // 8. Analysis
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048; 
    limiter.connect(analyser);
    analyser.connect(destination);

    // Store references for real-time updates via useEffect
    graphRef.current = {
      inputGain: inputGainNode,
      rumbleFilter,
      saturation: saturationNode,
      lowShelf,
      midPeaking,
      highShelf,
      midGain: midSignal,
      sideGain,
      mbLow: lowComp,
      mbMid: midComp,
      mbHigh: highComp,
      limiter
    };

    analyserRef.current = analyser;
    return { input: inputGainNode, output: analyser };
  };

  useEffect(() => {
    let animationFrame: number;
    const updateTime = () => {
      if (isPlaying && audioContextRef.current) {
        const elapsed = audioContextRef.current.currentTime - startTimeRef.current;
        const actualTime = startOffsetRef.current + elapsed;
        if (originalBufferRef.current && actualTime >= originalBufferRef.current.duration) handleStop();
        else {
           setCurrentTime(actualTime);
           if (analyserRef.current) {
              const now = performance.now();
              // Throttle meter updates to save CPU (20fps is enough for meters)
              if (now - lastMeterUpdateRef.current > 50) {
                 const dataArray = new Float32Array(analyserRef.current.fftSize);
                 analyserRef.current.getFloatTimeDomainData(dataArray);
                 let sumSquares = 0, peak = 0;
                 for (let i = 0; i < dataArray.length; i++) {
                   const sample = dataArray[i];
                   sumSquares += sample * sample;
                   if (Math.abs(sample) > peak) peak = Math.abs(sample);
                 }
                 const dbRMS = 20 * Math.log10(Math.sqrt(sumSquares / dataArray.length) || 0.000001);
                 const dbPeak = 20 * Math.log10(peak || 0.000001);
                 const alpha = 0.3;
                 meterSmoothingRef.current.rms = (alpha * dbRMS) + ((1 - alpha) * meterSmoothingRef.current.rms);
                 meterSmoothingRef.current.peak = Math.max(dbPeak, (0.1 * dbPeak) + (0.9 * meterSmoothingRef.current.peak));
                 setLiveStats({ rms: Math.max(-100, meterSmoothingRef.current.rms), peak: Math.max(-100, meterSmoothingRef.current.peak) });
                 lastMeterUpdateRef.current = now;
              }
           }
           animationFrame = requestAnimationFrame(updateTime);
        }
      }
    };
    if (isPlaying) animationFrame = requestAnimationFrame(updateTime);
    return () => cancelAnimationFrame(animationFrame);
  }, [isPlaying]);

  const playAudio = (offset: number) => {
    const ctx = audioContextRef.current;
    if (!ctx || !originalBufferRef.current) return;
    if (ctx.state === 'suspended') ctx.resume();
    if (sourceNodeRef.current) {
      sourceNodeRef.current.stop();
      sourceNodeRef.current.disconnect();
    }
    const source = ctx.createBufferSource();
    source.buffer = originalBufferRef.current;
    if (isBypassed) {
      // Direct connection, no graph
      source.connect(ctx.destination);
      graphRef.current = null; // Clear graph ref since we bypassed
    } else {
      const chain = setupAudioGraph(ctx, ctx.destination);
      source.connect(chain.input);
    }
    startTimeRef.current = ctx.currentTime;
    startOffsetRef.current = offset;
    source.start(0, offset);
    sourceNodeRef.current = source;
    setIsPlaying(true);
  };

  const handleStop = () => {
    if (sourceNodeRef.current) {
      sourceNodeRef.current.stop();
      sourceNodeRef.current = null;
    }
    setIsPlaying(false);
  };

  const togglePlayback = useCallback(() => {
    isPlaying ? handleStop() : playAudio(currentTime);
  }, [isPlaying, currentTime, isBypassed, settings]);

  const handleSeek = (time: number) => {
    setCurrentTime(time);
    startOffsetRef.current = time;
    if (isPlaying) playAudio(time);
  };

  const jumpBars = (direction: number) => {
    if (!bpm) return;
    const jumpTime = (60 / bpm) * 4 * 8; 
    let newTime = currentTime + (jumpTime * direction);
    handleSeek(Math.max(0, Math.min(stats?.duration || 0, newTime)));
  };

  const updateSetting = (key: keyof MasteringSettings, value: number) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const handleDownload = async () => {
    if (!originalBufferRef.current) return;
    addLog(`[EXPORT] Rendering offline bounce...`);
    const buffer = originalBufferRef.current;
    const offlineCtx = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;
    const chain = setupAudioGraph(offlineCtx as unknown as AudioContext, offlineCtx.destination);
    source.connect(chain.input);
    source.start(0);
    const rendered = await offlineCtx.startRendering();
    const wavBlob = bufferToWave(rendered, rendered.length);
    const url = URL.createObjectURL(wavBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `MASTERED_${fileName.replace(/\.[^/.]+$/, "")}.wav`;
    a.click();
    addLog(`[EXPORT] Done.`);
  };

  const handleChatSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!chatInput.trim() || isChatLoading) return;

    const userMsg = chatInput;
    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', text: userMsg }]);
    setIsChatLoading(true);

    try {
      const history = chatMessages.map(m => ({
        role: m.role,
        parts: [{ text: m.text }]
      }));

      const response = await chatWithAI(userMsg, history, stats, settings);
      
      if (response.functionCalls) {
        for (const call of response.functionCalls) {
          if (call.name === 'update_mastering_settings') {
            const args = call.args as Partial<MasteringSettings>;
            setSettings(prev => ({ ...prev, ...args }));
            addLog(`[AI_CMD] Applied mastering adjustments.`);
          } else if (call.name === 'playback_control') {
            const { action } = call.args as { action: 'play' | 'pause' };
            if (action === 'play') playAudio(currentTime);
            else handleStop();
          } else if (call.name === 'navigation_control') {
            const { direction } = call.args as { direction: 'forward' | 'backward' };
            jumpBars(direction === 'forward' ? 1 : -1);
          }
        }
      }

      setChatMessages(prev => [...prev, { role: 'model', text: response.text || "Action executed." }]);
    } catch (error) {
      setChatMessages(prev => [...prev, { role: 'model', text: "Signal interference. Please retry." }]);
    } finally {
      setIsChatLoading(false);
    }
  };

  const formatTime = (time: number) => {
    const m = Math.floor(time / 60);
    const s = Math.floor(time % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const displayRms = isPlaying ? liveStats.rms : (stats?.rms ?? -100);
  const displayPeak = isPlaying ? liveStats.peak : (stats?.peak ?? -100);

  return (
    <div className="min-h-screen bg-[#050505] text-slate-200 font-sans selection:bg-purple-500/30 overflow-x-hidden">
      <header className="border-b border-slate-800 bg-black/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h1 className="text-xl md:text-2xl font-black tracking-tighter text-white">
              TECHNO<span className="text-transparent bg-clip-text bg-gradient-to-r from-purple-500 to-cyan-400">MASTER</span>
            </h1>
          </div>
          <div className="hidden md:flex items-center gap-1 bg-slate-900/50 p-1 rounded-lg border border-slate-800">
             <button onClick={() => setActiveTab('MENTOR')} className={`px-4 py-1.5 rounded text-xs font-bold uppercase tracking-wider transition-all ${activeTab === 'MENTOR' ? 'bg-slate-800 text-purple-400' : 'text-slate-500'}`}>The Mentor</button>
             <button onClick={() => setActiveTab('ARCHITECT')} className={`px-4 py-1.5 rounded text-xs font-bold uppercase tracking-wider transition-all ${activeTab === 'ARCHITECT' ? 'bg-slate-800 text-cyan-400' : 'text-slate-500'}`}>Architect</button>
          </div>
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setIsChatOpen(!isChatOpen)}
              className={`p-2 rounded-full transition-all border ${isChatOpen ? 'bg-cyan-500/20 border-cyan-500 text-cyan-400' : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-white'}`}
            >
              <MessageSquare className="w-5 h-5" />
            </button>
            <div className="relative group">
              <input type="file" accept="audio/*" onChange={handleFileUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-20" disabled={appState === AppState.ANALYZING} />
              <button className="flex items-center gap-2 bg-purple-600 hover:bg-purple-500 text-white px-5 py-2 rounded font-bold text-xs uppercase tracking-wider transition-all shadow-[0_0_20px_rgba(147,51,234,0.3)]">
                 <Upload className="w-4 h-4" /> Upload Track
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8 grid grid-cols-1 lg:grid-cols-12 gap-6 relative">
        {/* Main Content */}
        <div className={`${isChatOpen ? 'lg:col-span-8' : 'lg:col-span-12'} transition-all duration-300 grid grid-cols-1 lg:grid-cols-12 gap-6`}>
          <div className="lg:col-span-12">
            <div className="bg-black border border-slate-800 rounded-xl overflow-hidden relative h-[340px] flex flex-col group shadow-2xl">
                <div className="absolute top-6 left-6 z-20">
                  <h2 className="text-2xl font-bold text-white uppercase tracking-tight">{fileName || "NO TRACK LOADED"}</h2>
                  <div className="flex items-center gap-4 mt-2">
                    <p className="font-mono text-slate-500 text-sm">{stats ? `${formatTime(currentTime)} / ${formatTime(stats.duration)}` : '00:00 / 00:00'}</p>
                    {stats && <div className="flex gap-3"><span className="text-xs bg-slate-800 px-2 py-0.5 rounded text-cyan-400">{bpm} BPM</span><span className="text-xs bg-slate-800 px-2 py-0.5 rounded text-purple-400">KEY: {key}</span></div>}
                  </div>
                </div>
                <div className="absolute top-6 right-6 z-20 flex gap-3">
                  <button onClick={() => setIsBypassed(!isBypassed)} disabled={!stats} className={`h-10 px-4 rounded-full font-bold text-xs border transition-all ${isBypassed ? 'bg-yellow-500 text-black border-yellow-500' : 'bg-black/40 text-slate-400 border-slate-700'}`}>
                    {isBypassed ? 'ORIGINAL' : 'COMPARE'}
                  </button>
                </div>
                <div className="mt-auto h-40 w-full relative z-10 px-6 mb-4">
                  <Visualizer audioBuffer={originalBufferRef.current} currentTime={currentTime} duration={stats?.duration || 0} isPlaying={isPlaying} color={isBypassed ? 'cyan' : 'purple'} onSeek={handleSeek} />
                </div>
                <div className="h-16 bg-slate-900/80 border-t border-slate-800 flex items-center justify-center gap-6 z-20">
                  <button onClick={() => jumpBars(-1)} disabled={!stats} className="p-2 text-slate-400 hover:text-white"><Rewind /></button>
                  <button onClick={togglePlayback} disabled={!stats} className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${isPlaying ? 'bg-white text-black' : 'bg-purple-600 text-white'}`}>
                    {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="ml-1 w-4 h-4" />}
                  </button>
                  <button onClick={() => jumpBars(1)} disabled={!stats} className="p-2 text-slate-400 hover:text-white"><FastForward /></button>
                </div>
            </div>
          </div>

          <div className="lg:col-span-4 space-y-6">
            <div className="bg-[#0a0a0a] border border-slate-800 rounded-xl p-6 relative">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-6">Live Monitor</h3>
                <div className="space-y-6">
                  <div className="text-center py-4 border-b border-slate-800/50">
                      <div className={`text-4xl font-mono font-bold ${displayRms > -8 ? 'text-yellow-400' : 'text-slate-200'}`}>
                        {displayRms > -100 ? (displayRms + 3).toFixed(1) : '-Inf'} <span className="text-sm text-slate-600">LUFS</span>
                      </div>
                      <div className="text-[10px] text-slate-600 uppercase mt-1 tracking-wider">{isPlaying ? "Momentary" : "Integrated"} Loudness</div>
                  </div>
                  <div className="space-y-4">
                      <div>
                        <div className="flex justify-between text-[10px] text-slate-500 uppercase mb-1"><span>Energy</span><span>{displayRms > -100 ? Math.min(100, (displayRms + 60) * 2).toFixed(0) : 0}%</span></div>
                        <div className="h-1.5 bg-slate-900 rounded-full overflow-hidden"><div className="h-full bg-purple-500 transition-all duration-100" style={{ width: `${displayRms > -100 ? Math.min(100, (displayRms + 60) * 2) : 0}%` }} /></div>
                      </div>
                      <div>
                        <div className="flex justify-between text-[10px] text-slate-500 uppercase mb-1"><span>Peak</span><span className={displayPeak > -0.5 ? 'text-red-500' : 'text-slate-500'}>{displayPeak > -100 ? displayPeak.toFixed(1) : '-Inf'} dB</span></div>
                        <div className="h-1.5 bg-slate-900 rounded-full overflow-hidden"><div className={`h-full transition-all duration-100 ${displayPeak > -1 ? 'bg-red-500' : 'bg-green-500'}`} style={{ width: `${displayPeak > -100 ? Math.min(100, (displayPeak + 60) * 1.8) : 0}%` }} /></div>
                      </div>
                  </div>
                </div>
            </div>
            <div className="bg-[#0a0a0a] border border-slate-800 rounded-xl p-6 flex items-center gap-4">
                <div className="relative w-16 h-16 flex items-center justify-center">
                  <svg className="w-full h-full transform -rotate-90"><circle cx="32" cy="32" r="28" stroke="#1e293b" strokeWidth="4" fill="none" /><circle cx="32" cy="32" r="28" stroke={score > 80 ? '#22d3ee' : '#f87171'} strokeWidth="4" fill="none" strokeDasharray="175" strokeDashoffset={175 - (175 * score) / 100} /></svg>
                  <span className="absolute text-sm font-bold text-white">{score}</span>
                </div>
                <div><div className="text-xs text-slate-500 uppercase">Mix Health</div><div className="text-sm font-bold">{score > 80 ? 'Club Ready' : 'Needs Work'}</div></div>
            </div>
          </div>

          <div className="lg:col-span-8 space-y-6">
            {activeTab === 'MENTOR' ? (
              <div className="bg-[#0a0a0a] border border-slate-800 rounded-xl p-1 h-[400px] flex flex-col">
                  <div className="bg-slate-900/50 px-4 py-2 border-b border-slate-800 flex items-center justify-between">
                    <div className="flex items-center gap-2"><Terminal className="w-3 h-3 text-slate-500" /><span className="text-[10px] font-mono text-slate-500 uppercase">AI_LOG</span></div>
                    {appState === AppState.ANALYZING && <RefreshCw className="w-3 h-3 text-purple-500 animate-spin" />}
                  </div>
                  <div className="flex-1 p-4 font-mono text-xs overflow-y-auto space-y-1">
                    {aiLogs.length === 0 && <div className="text-slate-700 italic">// Waiting for input...</div>}
                    {aiLogs.map((log, i) => <div key={i} className={`break-words ${log.startsWith('[ERROR]') ? 'text-red-400' : 'text-green-400/80'}`}>{log}</div>)}
                  </div>
              </div>
            ) : (
              <div className="bg-[#0a0a0a] border border-slate-800 rounded-xl p-6 min-h-[400px] h-auto space-y-8">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className="space-y-4">
                      <div className="text-[10px] font-bold text-slate-600 uppercase border-b border-slate-800 pb-1">3-Band EQ</div>
                      <div className="grid grid-cols-3 gap-2">
                          <Knob label="Low" value={settings.eqLow} min={-12} max={12} unit="dB" onChange={(v) => updateSetting('eqLow', v)} />
                          <Knob label="Mid" value={settings.eqMid} min={-12} max={12} unit="dB" onChange={(v) => updateSetting('eqMid', v)} />
                          <Knob label="High" value={settings.eqHigh} min={-12} max={12} unit="dB" onChange={(v) => updateSetting('eqHigh', v)} />
                      </div>
                    </div>
                    <div className="space-y-4">
                      <div className="text-[10px] font-bold text-slate-600 uppercase border-b border-slate-800 pb-1">Enhance</div>
                      <div className="flex gap-4">
                          <Knob label="Sat" value={settings.saturation} min={0} max={100} unit="%" onChange={(v) => updateSetting('saturation', v)} />
                          <Knob label="Width" value={settings.stereoWidth} min={0} max={200} unit="%" onChange={(v) => updateSetting('stereoWidth', v)} />
                      </div>
                    </div>
                    <div className="space-y-4 md:col-span-2">
                      <div className="text-[10px] font-bold text-slate-600 uppercase border-b border-slate-800 pb-1">Dynamics</div>
                      <div className="flex gap-8 justify-center items-start">
                          <Knob label="Gain" value={settings.inputGain} min={-12} max={12} unit="dB" onChange={(v) => updateSetting('inputGain', v)} />
                          <Knob label="Ceiling" value={settings.limiterCeiling} min={-3} max={0} unit="dB" onChange={(v) => updateSetting('limiterCeiling', v)} />
                      </div>
                    </div>
                  </div>
              </div>
            )}
            <div className="bg-[#0a0a0a] border border-slate-800 rounded-xl p-4 flex justify-between items-center">
                <div className="flex items-center gap-3"><Disc className="w-5 h-5 text-purple-500 animate-spin-slow" /><div className="text-xs"><div className="text-white font-bold">Ready to Bounce</div><div className="text-slate-600">WAV • 44.1kHz • 16-bit</div></div></div>
                <button onClick={handleDownload} disabled={!stats} className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-white px-6 py-2 rounded font-bold text-xs uppercase disabled:opacity-50"><Download className="w-3 h-3" /> Export</button>
            </div>
          </div>
        </div>

        {/* AI Chat Sidebar */}
        {isChatOpen && (
          <aside className="lg:col-span-4 bg-[#0a0a0a] border border-slate-800 rounded-xl flex flex-col h-[85vh] sticky top-20 animate-in slide-in-from-right duration-300">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-cyan-400" />
                <h3 className="font-bold text-sm uppercase tracking-widest text-white">AI Control Hub</h3>
              </div>
              <button onClick={() => setIsChatOpen(false)} className="text-slate-500 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {chatMessages.map((msg, idx) => (
                <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-2xl p-3 text-sm font-mono leading-relaxed ${
                    msg.role === 'user' 
                      ? 'bg-purple-600/20 border border-purple-500/50 text-slate-100 rounded-tr-none' 
                      : 'bg-slate-900 border border-slate-700 text-cyan-400 rounded-tl-none'
                  }`}>
                    {msg.text}
                  </div>
                </div>
              ))}
              {isChatLoading && (
                <div className="flex justify-start">
                  <div className="bg-slate-900 border border-slate-700 p-3 rounded-2xl rounded-tl-none flex gap-1">
                    <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-bounce"></span>
                    <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-bounce [animation-delay:0.2s]"></span>
                    <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-bounce [animation-delay:0.4s]"></span>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            <div className="p-4 border-t border-slate-800">
              <form onSubmit={handleChatSubmit} className="relative">
                <input 
                  type="text" 
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Ask AI to adjust settings or play..."
                  className="w-full bg-black border border-slate-700 rounded-full py-2.5 pl-4 pr-12 text-sm focus:border-cyan-500 focus:outline-none transition-colors font-mono"
                />
                <button 
                  type="submit" 
                  disabled={!chatInput.trim() || isChatLoading}
                  className="absolute right-1.5 top-1.5 w-8 h-8 bg-cyan-600 text-white rounded-full flex items-center justify-center hover:bg-cyan-500 transition-colors disabled:opacity-30"
                >
                  <Send className="w-4 h-4" />
                </button>
              </form>
              <div className="mt-2 flex gap-2">
                <button onClick={() => setChatInput('Enhance sub bass')} className="text-[10px] bg-slate-900 border border-slate-800 px-2 py-1 rounded-md text-slate-500 hover:text-cyan-400 hover:border-cyan-400/30 transition-all">"Enhance sub bass"</button>
                <button onClick={() => setChatInput('Check for phase issues')} className="text-[10px] bg-slate-900 border border-slate-800 px-2 py-1 rounded-md text-slate-500 hover:text-cyan-400 hover:border-cyan-400/30 transition-all">"Check phase"</button>
              </div>
            </div>
          </aside>
        )}
      </main>
    </div>
  );
};

export default App;