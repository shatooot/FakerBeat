import React, { useRef, useEffect, useState } from 'react';

interface VisualizerProps {
  audioBuffer: AudioBuffer | null;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  color: string;
  onSeek: (time: number) => void;
}

const Visualizer: React.FC<VisualizerProps> = ({ audioBuffer, currentTime, duration, isPlaying, color, onSeek }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [waveformCache, setWaveformCache] = useState<HTMLCanvasElement | null>(null);

  // 1. Generate Static Waveform (Expensive operation, do once per buffer)
  useEffect(() => {
    if (!audioBuffer) return;

    const width = 800;
    const height = 120;
    // Use standard canvas instead of OffscreenCanvas for wider compatibility
    const cacheCanvas = document.createElement('canvas');
    cacheCanvas.width = width;
    cacheCanvas.height = height;
    const ctx = cacheCanvas.getContext('2d');
    if (!ctx) return;

    const data = audioBuffer.getChannelData(0);
    const step = Math.ceil(data.length / width);
    const amp = height / 2;

    ctx.fillStyle = '#1e293b'; // Slate-800 background (transparent-ish)
    ctx.clearRect(0, 0, width, height);

    ctx.beginPath();
    ctx.moveTo(0, height / 2);

    for (let i = 0; i < width; i++) {
      let min = 1.0;
      let max = -1.0;
      
      // Optimization: Downsample
      for (let j = 0; j < step; j++) {
        const datum = data[(i * step) + j];
        if (datum < min) min = datum;
        if (datum > max) max = datum;
      }
      
      const yMin = (1 + min) * amp;
      const yMax = (1 + max) * amp;
      
      ctx.fillStyle = 'rgba(255,255,255,0.4)'; 
      ctx.fillRect(i, yMin, 1, yMax - yMin);
    }
    
    setWaveformCache(cacheCanvas);

  }, [audioBuffer]);

  // 2. Render On Prop Change
  // We removed the internal RAF loop because parent component triggers updates via currentTime prop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !waveformCache) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 1. Draw Cached Waveform (Background)
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(waveformCache, 0, 0, canvas.width, canvas.height);

    // 2. Draw Progress Overlay (The "Played" part)
    const progressRatio = currentTime / (duration || 1);
    const progressWidth = canvas.width * progressRatio;

    // Draw Color Tint on top of the waveform for the played section
    ctx.globalCompositeOperation = 'source-atop'; 
    ctx.fillStyle = color === 'cyan' ? '#22d3ee' : '#a855f7';
    ctx.fillRect(0, 0, progressWidth, canvas.height);

    // 3. Draw Playhead Line
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#fff';
    ctx.fillRect(progressWidth, 0, 2, canvas.height);
    
  }, [waveformCache, currentTime, duration, color]); // Runs whenever currentTime updates from parent

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current || !duration) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = x / rect.width;
    const newTime = ratio * duration;
    onSeek(newTime);
  };

  return (
    <div className="relative w-full h-full bg-slate-900/30 rounded-md">
       <canvas 
        ref={canvasRef} 
        width={800} 
        height={120} 
        className="w-full h-full rounded-md cursor-pointer"
        onClick={handleClick}
      />
      {!audioBuffer && (
          <div className="absolute inset-0 flex items-center justify-center text-slate-600 text-xs font-mono">
              [WAITING FOR AUDIO STREAM]
          </div>
      )}
    </div>
  );
};

export default Visualizer;