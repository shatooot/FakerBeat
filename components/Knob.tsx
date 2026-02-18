import React, { useState, useEffect, useRef } from 'react';

interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  onChange?: (value: number) => void;
}

const Knob: React.FC<KnobProps> = ({ label, value, min, max, unit = '', onChange }) => {
  const [isDragging, setIsDragging] = useState(false);
  const startYRef = useRef<number | null>(null);
  const startValueRef = useRef<number>(0);

  // Calculate rotation: map value to -135deg to +135deg
  const percentage = (value - min) / (max - min);
  const rotation = -135 + (percentage * 270);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging || startYRef.current === null || !onChange) return;
      
      const deltaY = startYRef.current - e.clientY;
      const range = max - min;
      const sensitivity = 200; // pixels to traverse full range
      const deltaValue = (deltaY / sensitivity) * range;
      
      let newValue = startValueRef.current + deltaValue;
      newValue = Math.max(min, Math.min(max, newValue));
      
      onChange(newValue);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      startYRef.current = null;
      document.body.style.cursor = 'default';
    };

    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'ns-resize';
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'default';
    };
  }, [isDragging, max, min, onChange]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!onChange) return;
    setIsDragging(true);
    startYRef.current = e.clientY;
    startValueRef.current = value;
  };

  return (
    <div className="flex flex-col items-center gap-2 select-none group">
      <div 
        className={`relative w-16 h-16 flex items-center justify-center ${onChange ? 'cursor-ns-resize' : ''}`}
        onMouseDown={handleMouseDown}
      >
        {/* Ring Background */}
        <div className={`absolute w-full h-full rounded-full border-4 transition-colors duration-200 ${isDragging ? 'border-slate-600' : 'border-slate-700'}`}></div>
        
        {/* Knob Body */}
        <div 
          className={`w-12 h-12 rounded-full shadow-xl border flex items-center justify-center relative transform transition-all duration-100 ease-out
            ${isDragging 
              ? 'bg-slate-700 border-cyan-400 shadow-[0_0_15px_rgba(34,211,238,0.4)] scale-105' 
              : 'bg-slate-800 border-slate-600 group-hover:border-slate-500'
            }
          `}
          style={{ transform: `rotate(${rotation}deg)` }}
        >
          {/* Indicator Dot */}
          <div className={`absolute top-1 w-1.5 h-1.5 rounded-full shadow-[0_0_8px_rgba(34,211,238,0.8)] transition-colors duration-200 ${isDragging ? 'bg-white' : 'bg-cyan-400'}`}></div>
        </div>
      </div>
      <div className="text-center pointer-events-none">
        <div className={`text-xs font-mono uppercase tracking-wider transition-colors duration-200 ${isDragging ? 'text-cyan-400' : 'text-slate-400'}`}>{label}</div>
        <div className={`text-xs font-bold transition-colors duration-200 ${isDragging ? 'text-white' : 'text-cyan-400'}`}>{value.toFixed(1)}{unit}</div>
      </div>
    </div>
  );
};

export default Knob;