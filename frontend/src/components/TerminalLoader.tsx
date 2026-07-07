import React, { useState, useEffect, useRef } from 'react';
import { Terminal, Shield, Play, HelpCircle, Check, AlertCircle } from 'lucide-react';
import { TerminalLog } from '../types';

interface TerminalLoaderProps {
  logsSequence: Array<{ text: string; type: string }>;
  onFinished: () => void;
  title?: string;
}

export default function TerminalLoader({ logsSequence, onFinished, title = "REDLINE SECURITY CORE CO-PROCESSOR" }: TerminalLoaderProps) {
  const [displayedLogs, setDisplayedLogs] = useState<TerminalLog[]>([]);
  const [currentLineIndex, setCurrentLineIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Speed of printing lines
  useEffect(() => {
    if (currentLineIndex >= logsSequence.length) {
      // Completed typing all logs, now finish progress bar and trigger callback
      const progressTimer = setInterval(() => {
        setProgress(prev => {
          if (prev >= 100) {
            clearInterval(progressTimer);
            // Give the user a brief moment to read the final line
            const callbackTimeout = setTimeout(() => {
              onFinished();
            }, 1000);
            return 100;
          }
          return prev + 5;
        });
      }, 50);
      return () => clearInterval(progressTimer);
    }

    const currentLine = logsSequence[currentLineIndex];
    
    // Calculate simulated delay based on length of text for natural feel
    const delay = Math.max(300, currentLine.text.length * 15);
    
    const timer = setTimeout(() => {
      const now = new Date();
      const timestamp = now.toLocaleTimeString() + '.' + String(now.getMilliseconds()).padStart(3, '0');
      
      setDisplayedLogs(prev => [
        ...prev,
        {
          text: currentLine.text,
          type: currentLine.type as any,
          timestamp
        }
      ]);

      setCurrentLineIndex(prev => prev + 1);
      
      // Update progress proportionally to line index
      setProgress(Math.round(((currentLineIndex + 1) / logsSequence.length) * 80));
    }, delay);

    return () => clearTimeout(timer);
  }, [currentLineIndex, logsSequence, onFinished]);

  // Auto scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [displayedLogs]);

  const handleSkip = () => {
    // Instantly complete logs and trigger finished callback
    const allLogs = logsSequence.map((l, idx) => {
      const now = new Date();
      return {
        text: l.text,
        type: l.type as any,
        timestamp: now.toLocaleTimeString() + '.' + String(idx * 40).padStart(3, '0')
      };
    });
    setDisplayedLogs(allLogs);
    setProgress(100);
    onFinished();
  };

  return (
    <div className="w-full max-w-3xl mx-auto bg-slate-950 rounded-xl border border-slate-800 shadow-[0_20px_50px_rgba(0,0,0,0.8)] overflow-hidden font-mono text-sm relative">
      
      {/* Terminal Title Bar */}
      <div className="bg-slate-900 px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5">
            <span className="w-3 h-3 rounded-full bg-red-500/80 inline-block" />
            <span className="w-3 h-3 rounded-full bg-yellow-500/80 inline-block" />
            <span className="w-3 h-3 rounded-full bg-green-500/80 inline-block" />
          </div>
          <span className="text-xs text-slate-400 ml-2 select-none tracking-wider">{title}</span>
        </div>
        
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-[10px] text-red-500 bg-red-950/40 border border-red-900/60 px-2 py-0.5 rounded animate-pulse">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block" /> LIVE DECRYPT
          </span>
          <button 
            onClick={handleSkip} 
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors bg-slate-950 border border-slate-800 px-2 py-1 rounded cursor-pointer"
          >
            Skip [ESC]
          </button>
        </div>
      </div>

      {/* Terminal Display screen */}
      <div 
        ref={scrollRef}
        className="p-6 h-96 overflow-y-auto bg-slate-950 text-slate-300 leading-relaxed scrollbar-thin scrollbar-thumb-slate-800"
      >
        <div className="space-y-2">
          {displayedLogs.map((log, index) => {
            let colorClass = 'text-slate-400';
            let icon = ' ';

            if (log.type === 'success') {
              colorClass = 'text-emerald-400';
              icon = '✔';
            } else if (log.type === 'warning') {
              colorClass = 'text-amber-400';
              icon = '▲';
            } else if (log.type === 'error') {
              colorClass = 'text-red-400 font-semibold';
              icon = '✖';
            } else if (log.type === 'input') {
              colorClass = 'text-indigo-400';
              icon = '❯';
            }

            return (
              <div key={index} className="flex items-start gap-3 border-l-2 border-transparent hover:border-slate-800 pl-1 py-0.5 transition-colors">
                <span className="text-[10px] text-slate-600 select-none pt-0.5">[{log.timestamp}]</span>
                <span className={`text-xs font-semibold select-none ${colorClass}`}>{icon}</span>
                <p className={`flex-1 text-xs break-all ${colorClass}`}>{log.text}</p>
              </div>
            );
          })}

          {/* Active typed line indicator */}
          {currentLineIndex < logsSequence.length && (
            <div className="flex items-center gap-3 pl-1 py-1">
              <span className="text-[10px] text-slate-700 select-none">
                [{new Date().toLocaleTimeString()}]
              </span>
              <span className="text-xs text-slate-500 animate-pulse">❯</span>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-400 font-semibold">Executing sub-module analysis</span>
                <span className="w-1.5 h-3.5 bg-red-500 animate-pulse inline-block" />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom status & Progress Bar */}
      <div className="bg-slate-950/90 border-t border-slate-900 px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-slate-500 font-mono">NEO4J HEURISTICS PROGRESS</span>
            <span className="text-red-400 font-semibold">{progress}%</span>
          </div>
          <div className="h-1.5 bg-slate-900 rounded-full overflow-hidden">
            <div 
              className="h-full bg-gradient-to-r from-red-600 to-red-400 transition-all duration-300 shadow-[0_0_10px_rgba(239,68,68,0.5)]"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        <div className="text-right text-[10px] text-slate-500 font-mono select-none">
          PID: <span className="text-slate-400">8014</span> | SOCKET: <span className="text-slate-400">CONNECT_OK</span>
        </div>
      </div>
    </div>
  );
}
