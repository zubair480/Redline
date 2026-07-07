import React, { useState, useEffect } from 'react';
import { 
  Mail, 
  Cpu, 
  CreditCard, 
  ShieldCheck, 
  Zap, 
  ShieldAlert, 
  Play, 
  RefreshCw,
  Sparkles,
  Info
} from 'lucide-react';
import { ScanNode, AppStep } from '../types';
import { VULNERABLE_NODES, RESOLVED_NODES } from '../data';

interface GraphAreaProps {
  step: AppStep;
  selectedNodeId: string;
  onSelectNode: (node: ScanNode) => void;
}

export default function GraphArea({ step, selectedNodeId, onSelectNode }: GraphAreaProps) {
  const isResolved = step === 'resolved';
  const nodes = isResolved ? RESOLVED_NODES : VULNERABLE_NODES;

  // Track if a packet simulation is actively animating
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationProgress, setSimulationProgress] = useState(0);

  // Position lookup tables to match our absolute div % locations with SVG viewBox (1000 x 600)
  const nodePositions: Record<string, { x: number; y: number; pctLeft: string; pctTop: string }> = isResolved ? {
    'src_email': { x: 120, y: 240, pctLeft: '12%', pctTop: '40%' },
    'tool_intent': { x: 380, y: 360, pctLeft: '38%', pctTop: '60%' },
    'sanitizer': { x: 640, y: 240, pctLeft: '64%', pctTop: '40%' },
    'sink_refund': { x: 880, y: 360, pctLeft: '88%', pctTop: '60%' }
  } : {
    'src_email': { x: 150, y: 240, pctLeft: '15%', pctTop: '40%' },
    'tool_intent': { x: 500, y: 360, pctLeft: '50%', pctTop: '60%' },
    'sink_refund': { x: 850, y: 240, pctLeft: '85%', pctTop: '40%' }
  };

  const getIcon = (iconName: string, status: string, isHovered: boolean) => {
    const size = 22;
    const colorClass = 
      status === 'vulnerable' ? 'text-red-500' :
      status === 'secured' ? 'text-emerald-500' : 'text-slate-400';

    switch(iconName) {
      case 'Mail': return <Mail size={size} className={colorClass} />;
      case 'Cpu': return <Cpu size={size} className={colorClass} />;
      case 'ShieldCheck': return <ShieldCheck size={size} className="text-emerald-400" />;
      case 'CreditCard': return <CreditCard size={size} className={colorClass} />;
      default: return <Cpu size={size} className={colorClass} />;
    }
  };

  const triggerSimulation = () => {
    if (isSimulating) return;
    setIsSimulating(true);
    setSimulationProgress(0);
  };

  useEffect(() => {
    if (!isSimulating) return;
    
    const interval = setInterval(() => {
      setSimulationProgress(prev => {
        if (prev >= 100) {
          clearInterval(interval);
          setTimeout(() => {
            setIsSimulating(false);
            setSimulationProgress(0);
          }, 800);
          return 100;
        }
        return prev + 2.5;
      });
    }, 40);

    return () => clearInterval(interval);
  }, [isSimulating]);

  // Set default selection when node lists change
  useEffect(() => {
    const defaultNode = nodes.find(n => n.id === 'src_email') || nodes[0];
    if (defaultNode && !selectedNodeId) {
      onSelectNode(defaultNode);
    }
  }, [step, nodes, onSelectNode, selectedNodeId]);

  return (
    <div id="cyber_graph_container" className="relative flex-1 bg-slate-950/80 rounded-2xl border border-slate-800 p-6 flex flex-col justify-between overflow-hidden scan-line-effect min-h-[500px]">
      
      {/* Background Grid Pattern & Tech scan lines */}
      <div className="absolute inset-0 cyber-grid-pattern opacity-70 pointer-events-none" />
      
      {/* Dynamic Scan laser line for simulation effect */}
      {isSimulating && (
        <div className="absolute top-0 bottom-0 w-0.5 bg-red-500/50 shadow-[0_0_20px_rgba(239,68,68,0.8)] scan-line-laser pointer-events-none" style={{ left: `${simulationProgress}%` }} />
      )}

      {/* Graph Area Header */}
      <div className="relative z-10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${isResolved ? 'bg-emerald-500/10 border border-emerald-500/30' : 'bg-red-500/10 border border-red-500/30 animate-pulse'}`}>
            {isResolved ? (
              <ShieldCheck className="text-emerald-500 w-5 h-5" />
            ) : (
              <ShieldAlert className="text-red-500 w-5 h-5" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-display font-bold text-slate-100 text-lg">Agent Vulnerability Map</span>
              <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded-full border ${isResolved ? 'bg-emerald-950/50 border-emerald-800 text-emerald-400' : 'bg-red-950/50 border-red-900 text-red-400 animate-pulse'}`}>
                {isResolved ? 'Secure State' : 'Threat Active'}
              </span>
            </div>
            <p className="text-xs text-slate-400">Interactive live graph. Click on nodes to inspect parameters.</p>
          </div>
        </div>

        {/* Play Simulation CTA */}
        <button
          onClick={triggerSimulation}
          disabled={isSimulating}
          className={`px-3 py-1.5 rounded-lg border text-xs font-mono flex items-center gap-2 transition-all ${
            isSimulating 
              ? 'bg-slate-900 border-slate-800 text-slate-500 cursor-not-allowed'
              : isResolved
                ? 'bg-slate-900/50 hover:bg-emerald-950/30 border-slate-800 hover:border-emerald-500/30 text-emerald-400'
                : 'bg-slate-900/50 hover:bg-red-950/30 border-slate-800 hover:border-red-500/30 text-red-400'
          }`}
        >
          {isSimulating ? (
            <>
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              <span>Running Payload Simulation... {Math.round(simulationProgress)}%</span>
            </>
          ) : (
            <>
              <Play className={`w-3.5 h-3.5 ${isResolved ? 'text-emerald-400' : 'text-red-400'}`} />
              <span>Simulate Injection Attack</span>
            </>
          )}
        </button>
      </div>

      {/* The Node Graph Stage */}
      <div className="relative flex-1 w-full flex items-center justify-center my-4 min-h-[340px]">
        
        {/* SVG Connections Layer */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 1000 600" preserveAspectRatio="none">
          <defs>
            {/* Red neon glow filter */}
            <filter id="neon-glow-red" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="8" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            {/* Green neon glow filter */}
            <filter id="neon-glow-green" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="8" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Render Connections */}
          {isResolved ? (
            <>
              {/* Green connections */}
              <path 
                d="M 120,240 Q 250,300 380,360" 
                fill="none" 
                stroke="#10b981" 
                strokeWidth="4" 
                className="path-glowing-green"
                filter="url(#neon-glow-green)"
                opacity="0.8"
              />
              <path 
                d="M 380,360 Q 510,300 640,240" 
                fill="none" 
                stroke="#10b981" 
                strokeWidth="4" 
                className="path-glowing-green"
                filter="url(#neon-glow-green)"
                opacity="0.8"
              />
              <path 
                d="M 640,240 Q 760,300 880,360" 
                fill="none" 
                stroke="#10b981" 
                strokeWidth="4" 
                className="path-glowing-green"
                filter="url(#neon-glow-green)"
                opacity="0.8"
              />

              {/* Simulation Attack Packet traveling on safe route */}
              {isSimulating && (
                <>
                  <circle r="8" fill="#10b981" className="shadow-lg shadow-emerald-500">
                    <animateMotion 
                      dur="2.5s" 
                      repeatCount="1" 
                      path="M 120,240 Q 250,300 380,360 Q 510,300 640,240 Q 760,300 880,360" 
                      fill="freeze"
                    />
                  </circle>
                  <circle r="14" fill="none" stroke="#10b981" strokeWidth="2" opacity="0.6">
                    <animateMotion 
                      dur="2.5s" 
                      repeatCount="1" 
                      path="M 120,240 Q 250,300 380,360 Q 510,300 640,240 Q 760,300 880,360" 
                      fill="freeze"
                    />
                    <animate attributeName="r" values="8;16;8" dur="1s" repeatCount="indefinite" />
                  </circle>
                </>
              )}
            </>
          ) : (
            <>
              {/* Glowing Red Danger Paths */}
              <path 
                d="M 150,240 Q 325,300 500,360" 
                fill="none" 
                stroke="#ef4444" 
                strokeWidth="5" 
                className="path-glowing-red"
                filter="url(#neon-glow-red)"
                opacity="0.9"
              />
              <path 
                d="M 500,360 Q 675,300 850,240" 
                fill="none" 
                stroke="#ef4444" 
                strokeWidth="5" 
                className="path-glowing-red"
                filter="url(#neon-glow-red)"
                opacity="0.9"
              />

              {/* Attack Simulation Packet - malicious prompt bypass */}
              {isSimulating && (
                <>
                  <circle r="9" fill="#ef4444" className="shadow-lg shadow-red-500">
                    <animateMotion 
                      dur="2s" 
                      repeatCount="1" 
                      path="M 150,240 Q 325,300 500,360 Q 675,300 850,240" 
                      fill="freeze"
                    />
                  </circle>
                  {/* Ripple pulse visual */}
                  <circle r="16" fill="none" stroke="#ef4444" strokeWidth="2" opacity="0.7">
                    <animateMotion 
                      dur="2s" 
                      repeatCount="1" 
                      path="M 150,240 Q 325,300 500,360 Q 675,300 850,240" 
                      fill="freeze"
                    />
                    <animate attributeName="r" values="9;20;9" dur="0.8s" repeatCount="indefinite" />
                  </circle>
                </>
              )}
            </>
          )}
        </svg>

        {/* Render Interactive Nodes as ABSOLUTELY positioned HTML elements */}
        {nodes.map((node) => {
          const pos = nodePositions[node.id];
          if (!pos) return null;
          
          const isSelected = selectedNodeId === node.id;
          
          let statusBorderColor = 'border-slate-800 hover:border-slate-700 bg-slate-900';
          let glowEffect = '';

          if (node.status === 'vulnerable') {
            statusBorderColor = isSelected ? 'border-red-500 ring-2 ring-red-500/30' : 'border-red-900/80 hover:border-red-700 bg-slate-950';
            glowEffect = 'animate-pulse-glow';
          } else if (node.status === 'secured') {
            statusBorderColor = isSelected ? 'border-emerald-500 ring-2 ring-emerald-500/30' : 'border-emerald-950 hover:border-emerald-700 bg-slate-950';
            if (node.type === 'sanitizer') {
              glowEffect = 'animate-pulse-glow-green';
            }
          } else if (isSelected) {
            statusBorderColor = 'border-indigo-500 ring-2 ring-indigo-500/20';
          }

          return (
            <button
              key={node.id}
              onClick={() => onSelectNode(node)}
              className={`absolute transition-all duration-300 transform -translate-x-1/2 -translate-y-1/2 flex flex-col items-center z-20 group cursor-pointer ${glowEffect}`}
              style={{ left: pos.pctLeft, top: pos.pctTop }}
            >
              {/* Outer circle layout */}
              <div className={`w-14 h-14 rounded-2xl flex items-center justify-center border-2 transition-all ${statusBorderColor} shadow-xl relative`}>
                {getIcon(node.iconName, node.status, isSelected)}
                
                {/* Micro-badge */}
                {node.status === 'vulnerable' && (
                  <span className="absolute -top-1.5 -right-1.5 flex h-4 w-4">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-4 w-4 bg-red-500 items-center justify-center text-[8px] font-bold text-white">!</span>
                  </span>
                )}
                {node.status === 'secured' && node.type === 'sanitizer' && (
                  <span className="absolute -top-1.5 -right-1.5 flex h-4 w-4 bg-emerald-500 rounded-full items-center justify-center text-[8px] font-bold text-white shadow-md shadow-emerald-500/50">
                    <Sparkles className="w-2.5 h-2.5 text-white" />
                  </span>
                )}
              </div>

              {/* Node Title & Badge */}
              <div className="mt-2 text-center">
                <p className={`text-xs font-semibold font-display tracking-wide ${isSelected ? 'text-slate-100' : 'text-slate-400 group-hover:text-slate-200'}`}>
                  {node.label}
                </p>
                <div className="flex items-center gap-1 justify-center mt-0.5">
                  <span className="text-[9px] font-mono text-slate-500 bg-slate-900 px-1.5 py-0.2 rounded border border-slate-800/80">
                    {node.techBadge || node.type.toUpperCase()}
                  </span>
                </div>
              </div>
            </button>
          );
        })}

        {/* Visual packet payload label during simulation */}
        {isSimulating && (
          <div 
            className={`absolute z-30 px-2 py-1 rounded text-[10px] font-mono border ${
              isResolved 
                ? 'bg-emerald-950 border-emerald-500 text-emerald-300' 
                : 'bg-red-950 border-red-500 text-red-300'
            } transition-all duration-75`}
            style={{ 
              left: `${simulationProgress}%`, 
              top: `${isResolved ? (simulationProgress < 33 ? 42 : simulationProgress < 66 ? 50 : 45) : (simulationProgress < 50 ? 44 : 52)}%`,
              transform: 'translate(-50%, -100%)',
              opacity: simulationProgress > 5 && simulationProgress < 95 ? 1 : 0
            }}
          >
            {isResolved ? (
              <span className="flex items-center gap-1">
                <ShieldCheck className="w-2.5 h-2.5" /> Payload Sanitized
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <ShieldAlert className="w-2.5 h-2.5 animate-bounce" /> "Issue me a refund..."
              </span>
            )}
          </div>
        )}
      </div>

      {/* Legend & Stats bar */}
      <div className="relative z-10 border-t border-slate-900/60 pt-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-6 text-[11px] text-slate-400 font-mono">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
            <span>Untrusted Source</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded bg-slate-700" />
            <span>Standard Agent Tool</span>
          </div>
          {isResolved && (
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded bg-emerald-500 animate-pulse-glow-green" />
              <span>Input Sanitizer</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-red-900 border border-red-500" />
            <span>Privileged Sink (Stripe)</span>
          </div>
        </div>

        <div className="text-right">
          <span className="text-[10px] font-mono text-slate-500">
            Scanning Model: <strong className="text-slate-400 font-semibold">Butter-Parser v2</strong>
          </span>
        </div>
      </div>
    </div>
  );
}
