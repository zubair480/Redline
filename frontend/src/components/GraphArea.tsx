import React, { useState, useEffect } from 'react';
import {
  Mail,
  Cpu,
  CreditCard,
  ShieldCheck,
  Globe,
  Database,
  ShieldAlert,
  Play,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { ScanNode, ScanEdge, AppStep } from '../types';

interface GraphAreaProps {
  step: AppStep;
  nodes: ScanNode[];
  edges: ScanEdge[];
  selectedNodeId: string;
  onSelectNode: (node: ScanNode) => void;
}

// SVG viewBox the node layer is drawn against. Node buttons are positioned by
// percentage over the same box, so edges and nodes stay aligned.
const VB_W = 1000;
const VB_H = 600;
const COLUMN_ORDER: ScanNode['type'][] = ['source', 'tool', 'sanitizer', 'sink'];

interface Pos { x: number; y: number; pctLeft: string; pctTop: string; }

// Columnar layout: one column per node type present (sources | tools/context |
// guards | sinks), nodes stacked evenly within their column.
function computeLayout(nodes: ScanNode[]): Record<string, Pos> {
  const cols = COLUMN_ORDER.filter((t) => nodes.some((n) => n.type === t));
  const positions: Record<string, Pos> = {};
  cols.forEach((type, ci) => {
    const colNodes = nodes.filter((n) => n.type === type);
    const x = ((ci + 1) / (cols.length + 1)) * VB_W;
    colNodes.forEach((n, ri) => {
      const y = ((ri + 1) / (colNodes.length + 1)) * VB_H;
      positions[n.id] = { x, y, pctLeft: `${(x / VB_W) * 100}%`, pctTop: `${(y / VB_H) * 100}%` };
    });
  });
  return positions;
}

// Smooth cubic between two points, horizontal control handles (same curve feel
// as the original hand-drawn paths).
function edgePath(a: Pos, b: Pos): string {
  const dx = (b.x - a.x) * 0.4;
  return `M ${a.x},${a.y} C ${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}

function getIcon(iconName: string, status: string) {
  const size = 22;
  const colorClass =
    status === 'vulnerable' ? 'text-red-500' : status === 'secured' ? 'text-emerald-500' : 'text-slate-400';
  switch (iconName) {
    case 'Mail': return <Mail size={size} className={colorClass} />;
    case 'Globe': return <Globe size={size} className={colorClass} />;
    case 'Database': return <Database size={size} className={colorClass} />;
    case 'CreditCard': return <CreditCard size={size} className={colorClass} />;
    case 'ShieldCheck': return <ShieldCheck size={size} className="text-emerald-400" />;
    case 'Cpu':
    default: return <Cpu size={size} className={colorClass} />;
  }
}

export default function GraphArea({ step, nodes, edges, selectedNodeId, onSelectNode }: GraphAreaProps) {
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationProgress, setSimulationProgress] = useState(0);

  const positions = computeLayout(nodes);
  const hasCritical = edges.some((e) => e.status === 'critical');
  const hasGuard = nodes.some((n) => n.type === 'sanitizer');

  const triggerSimulation = () => {
    if (isSimulating) return;
    setIsSimulating(true);
    setSimulationProgress(0);
  };

  useEffect(() => {
    if (!isSimulating) return;
    const interval = setInterval(() => {
      setSimulationProgress((prev) => {
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

  // Default selection: first source, else first node.
  useEffect(() => {
    const defaultNode = nodes.find((n) => n.type === 'source') || nodes[0];
    if (defaultNode && !selectedNodeId) onSelectNode(defaultNode);
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
          <div className={`p-2 rounded-lg ${hasCritical ? 'bg-red-500/10 border border-red-500/30 animate-pulse' : 'bg-emerald-500/10 border border-emerald-500/30'}`}>
            {hasCritical ? <ShieldAlert className="text-red-500 w-5 h-5" /> : <ShieldCheck className="text-emerald-500 w-5 h-5" />}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-display font-bold text-slate-100 text-lg">Agent Vulnerability Map</span>
              <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded-full border ${hasCritical ? 'bg-red-950/50 border-red-900 text-red-400 animate-pulse' : 'bg-emerald-950/50 border-emerald-800 text-emerald-400'}`}>
                {hasCritical ? 'Threat Active' : 'Secure State'}
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
              : hasCritical
                ? 'bg-slate-900/50 hover:bg-red-950/30 border-slate-800 hover:border-red-500/30 text-red-400'
                : 'bg-slate-900/50 hover:bg-emerald-950/30 border-slate-800 hover:border-emerald-500/30 text-emerald-400'
          }`}
        >
          {isSimulating ? (
            <>
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              <span>Running Payload Simulation... {Math.round(simulationProgress)}%</span>
            </>
          ) : (
            <>
              <Play className={`w-3.5 h-3.5 ${hasCritical ? 'text-red-400' : 'text-emerald-400'}`} />
              <span>Simulate Injection Attack</span>
            </>
          )}
        </button>
      </div>

      {/* The Node Graph Stage */}
      <div className="relative flex-1 w-full flex items-center justify-center my-4 min-h-[340px]">

        {/* SVG Connections Layer */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none">
          <defs>
            <filter id="neon-glow-red" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="8" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            <filter id="neon-glow-green" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="8" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>

          {edges.map((edge, i) => {
            const a = positions[edge.from];
            const b = positions[edge.to];
            if (!a || !b) return null;
            const d = edgePath(a, b);
            const critical = edge.status === 'critical';
            return (
              <g key={`${edge.from}-${edge.to}-${i}`}>
                <path
                  d={d}
                  fill="none"
                  stroke={critical ? '#ef4444' : '#10b981'}
                  strokeWidth={critical ? 5 : 4}
                  className={critical ? 'path-glowing-red' : 'path-glowing-green'}
                  filter={`url(#neon-glow-${critical ? 'red' : 'green'})`}
                  opacity={critical ? 0.9 : 0.8}
                />
                {isSimulating && (
                  <>
                    <circle r={critical ? 9 : 8} fill={critical ? '#ef4444' : '#10b981'}>
                      <animateMotion dur={critical ? '2s' : '2.5s'} repeatCount="1" path={d} fill="freeze" />
                    </circle>
                    <circle r={critical ? 16 : 14} fill="none" stroke={critical ? '#ef4444' : '#10b981'} strokeWidth="2" opacity="0.6">
                      <animateMotion dur={critical ? '2s' : '2.5s'} repeatCount="1" path={d} fill="freeze" />
                      <animate attributeName="r" values={critical ? '9;20;9' : '8;16;8'} dur={critical ? '0.8s' : '1s'} repeatCount="indefinite" />
                    </circle>
                  </>
                )}
              </g>
            );
          })}
        </svg>

        {/* Render Interactive Nodes as ABSOLUTELY positioned HTML elements */}
        {nodes.map((node) => {
          const pos = positions[node.id];
          if (!pos) return null;
          const isSelected = selectedNodeId === node.id;

          let statusBorderColor = 'border-slate-800 hover:border-slate-700 bg-slate-900';
          let glowEffect = '';

          if (node.status === 'vulnerable') {
            statusBorderColor = isSelected ? 'border-red-500 ring-2 ring-red-500/30' : 'border-red-900/80 hover:border-red-700 bg-slate-950';
            glowEffect = 'animate-pulse-glow';
          } else if (node.status === 'secured') {
            statusBorderColor = isSelected ? 'border-emerald-500 ring-2 ring-emerald-500/30' : 'border-emerald-950 hover:border-emerald-700 bg-slate-950';
            if (node.type === 'sanitizer') glowEffect = 'animate-pulse-glow-green';
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
              <div className={`w-14 h-14 rounded-2xl flex items-center justify-center border-2 transition-all ${statusBorderColor} shadow-xl relative`}>
                {getIcon(node.iconName, node.status)}

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
            <span>Agent Tool / Context</span>
          </div>
          {hasGuard && (
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded bg-emerald-500 animate-pulse-glow-green" />
              <span>Guard</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-red-900 border border-red-500" />
            <span>Privileged Sink</span>
          </div>
        </div>

        <div className="text-right">
          <span className="text-[10px] font-mono text-slate-500">
            Scanning Engine: <strong className="text-slate-400 font-semibold">Neo4j + Cypher</strong>
          </span>
        </div>
      </div>
    </div>
  );
}
