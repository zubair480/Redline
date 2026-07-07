import React, { useState, useEffect, useRef } from 'react';
import { 
  Shield, 
  Terminal as TerminalIcon, 
  Play, 
  Layers, 
  CheckCircle2, 
  AlertTriangle, 
  History, 
  User, 
  Lock, 
  Zap, 
  Sparkles, 
  ArrowRight, 
  Info, 
  Check, 
  Code, 
  CreditCard, 
  X, 
  ExternalLink,
  ChevronRight,
  ShieldCheck,
  RefreshCw,
  Clock,
  HelpCircle
} from 'lucide-react';
import { AppStep, ScanNode, ScanEdge } from './types';
import {
  DEFAULT_AGENT_CONFIG,
  SCAN_LOGS_SEQUENCE,
  FIX_LOGS_SEQUENCE,
  PRESETS,
} from './data';
import GraphArea from './components/GraphArea';
import TerminalLoader from './components/TerminalLoader';
import {
  ensureSession,
  currentEmail,
  runScan,
  applyFix,
  billingUnlock,
  fetchScanRow,
  getHistory,
  PaywallError,
  type Results,
  type ScanResponse,
  type ApplyFixResponse,
  type ScanRow,
} from './api';
import { resultsToView, deriveView } from './mapping';

interface ViewData {
  results: Results;
  nodes: ScanNode[];
  edges: ScanEdge[];
  guardAdded?: { guard: string; placement: string | null };
  before?: number;
}

export default function App() {
  // Navigation & Simulation State
  const [step, setStep] = useState<AppStep>('config');
  const [editorContent, setEditorContent] = useState(DEFAULT_AGENT_CONFIG);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<ScanNode | null>(null);

  // Tabbed input state
  const [activeInputTab, setActiveInputTab] = useState<'paste' | 'github' | 'cli'>('paste');
  const [gitRepo, setGitRepo] = useState('SerafimSharkov/support-agent');
  const [gitBranch, setGitBranch] = useState('main');
  const [gitStatus, setGitStatus] = useState<'idle' | 'checking' | 'found' | 'error'>('idle');
  const [gitError, setGitError] = useState<string | null>(null);
  
  // Custom interactive state updates
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isPaywallOpen, setIsPaywallOpen] = useState(false);
  const [isPro, setIsPro] = useState(false);
  
  // Mock credit card checkout form
  const [cardNumber, setCardNumber] = useState('');
  const [cardExpiry, setCardExpiry] = useState('');
  const [cardCvv, setCardCvv] = useState('');
  const [cardName, setCardName] = useState('');
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  const [paymentSuccess, setPaymentSuccess] = useState(false);

  // Live scan results from the backend pipeline.
  const [scanId, setScanId] = useState<string | null>(null);
  const [vulnView, setVulnView] = useState<ViewData | null>(null);
  const [resolvedView, setResolvedView] = useState<ViewData | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  // Real scan history (RLS-scoped to the demo user).
  const [history, setHistory] = useState<ScanRow[]>([]);

  // Demo session identity.
  const [userEmail, setUserEmail] = useState('');

  // In-flight request promises, awaited when the terminal animation finishes.
  const scanPromise = useRef<Promise<ScanResponse> | null>(null);
  const fixPromise = useRef<Promise<ApplyFixResponse> | null>(null);
  const lastConfig = useRef<any>(null);

  // Establish a silent demo session on load.
  useEffect(() => {
    ensureSession()
      .then(() => setUserEmail(currentEmail()))
      .catch(() => setScanError('Could not connect to the Redline backend.'));
  }, []);

  const refreshHistory = () => {
    getHistory().then(setHistory).catch(() => {});
  };
  useEffect(() => { refreshHistory(); }, []);

  // JSON Syntax Validation Helper
  const handleEditorChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setEditorContent(val);
    try {
      JSON.parse(val);
      setJsonError(null);
    } catch (err: any) {
      setJsonError(`Syntax Error: ${err.message}`);
    }
  };

  const loadPreset = (preset: typeof PRESETS[0]) => {
    setEditorContent(preset.config);
    setJsonError(null);
  };

  // Kick off the real scan and enter the terminal animation. The request runs
  // concurrently; handleScanFinished awaits it when the terminal completes.
  const startScan = (config: any) => {
    lastConfig.current = config;
    setScanError(null);
    scanPromise.current = runScan(config);
    // The real handling happens in handleScanFinished; this no-op handler just
    // keeps a fast rejection (e.g. 402) from logging as an unhandled rejection
    // while the terminal animation is still playing.
    scanPromise.current.catch(() => {});
    setStep('loading_scan');
  };

  const handleRunScan = () => {
    if (activeInputTab === 'paste') {
      let config: any;
      try {
        config = JSON.parse(editorContent);
        setJsonError(null);
      } catch (err: any) {
        setJsonError(`Invalid JSON config! Please resolve errors before scanning. (${err.message})`);
        return;
      }
      startScan(config);
    } else if (activeInputTab === 'github') {
      // GitHub tab is a visual mock: verify, then scan the default config.
      const scanDefault = () => startScan(JSON.parse(DEFAULT_AGENT_CONFIG));
      if (gitStatus !== 'found') {
        setGitStatus('checking');
        setTimeout(() => {
          setGitStatus('found');
          setGitError(null);
          scanDefault();
        }, 1200);
        return;
      }
      setGitError(null);
      scanDefault();
    } else {
      // CLI tab is a visual mock: scan the default config.
      startScan(JSON.parse(DEFAULT_AGENT_CONFIG));
    }
  };

  const renderScanResult = async (resp: ScanResponse) => {
    const row = await fetchScanRow(resp.scanId);
    const view = row?.graph ? resultsToView(row.graph, resp) : deriveView(lastConfig.current, resp);
    setScanId(resp.scanId);
    setVulnView({ results: resp, nodes: view.nodes, edges: view.edges });
    setSelectedNode(null);
    setStep('vulnerable');
    refreshHistory();
  };

  const handleScanFinished = async () => {
    try {
      const resp = await scanPromise.current!;
      await renderScanResult(resp);
    } catch (err: any) {
      // Paywall is disabled for the demo: if the backend still enforces its
      // free-scan limit, silently unlock and retry once so the user never sees
      // a paywall. Any other failure surfaces as before.
      if (err instanceof PaywallError) {
        try {
          await billingUnlock();
          await renderScanResult(await runScan(lastConfig.current));
          return;
        } catch (retryErr: any) {
          setScanError(retryErr?.message || 'Scan failed.');
          setStep('config');
        }
      } else {
        setScanError(err?.message || 'Scan failed.');
        setStep('config');
      }
    }
  };

  const handleApplyFix = () => {
    if (!scanId) return;
    fixPromise.current = applyFix(scanId);
    fixPromise.current.catch(() => {}); // handled in handleFixFinished
    setStep('loading_fix');
  };

  const handleFixFinished = async () => {
    try {
      const resp = await fixPromise.current!;
      const row = await fetchScanRow(resp.scanId);
      const view = row?.graph
        ? resultsToView(row.graph, resp.after)
        : deriveView(resp.config, resp.after);
      setResolvedView({
        results: resp.after,
        nodes: view.nodes,
        edges: view.edges,
        guardAdded: resp.guardAdded,
        before: resp.before.vulnerablePaths,
      });
      setSelectedNode(null);
      setStep('resolved');
      refreshHistory();
    } catch (err: any) {
      setScanError(err?.message || 'Apply fix failed.');
      setStep('vulnerable');
    }
  };

  // Real mock-mode billing unlock (checkout -> confirm), behind the card form.
  const handleProcessUpgrade = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cardNumber || !cardExpiry || !cardCvv || !cardName) {
      alert("Please fill in all credit card details.");
      return;
    }
    setIsProcessingPayment(true);
    try {
      await billingUnlock();
    } catch {
      // Mock billing rarely fails; grant the UX regardless for the demo.
    }
    setIsProcessingPayment(false);
    setPaymentSuccess(true);
    setIsPro(true);
    refreshHistory();
  };

  // After unlock, close the modal and auto-retry the scan that hit the paywall.
  const handleReturnFromUpgrade = () => {
    setPaymentSuccess(false);
    setIsPaywallOpen(false);
    if (lastConfig.current) startScan(lastConfig.current);
  };

  // Derived view data for the vulnerable/resolved panel.
  const activeView = step === 'resolved' ? resolvedView : vulnView;
  const activeResults = activeView?.results ?? null;
  const activeNodes = activeView?.nodes ?? [];
  const activeEdges = activeView?.edges ?? [];
  const vulnCount = activeResults?.summary.vulnerablePaths ?? 0;
  const topSeverity = (activeResults?.vulnerablePaths?.[0]?.severity ?? 'critical').toUpperCase();
  const recFix = activeResults?.recommendedFix ?? null;
  const selectedExplanation = (() => {
    const paths = activeResults?.vulnerablePaths ?? [];
    if (selectedNode) {
      const hit = paths.find((p) => p.path.includes(selectedNode.id));
      if (hit) return hit.explanation;
    }
    return paths[0]?.explanation ?? '';
  })();
  const resolvedBefore = resolvedView?.before ?? 0;
  const resolvedRemaining = resolvedView?.results.summary.vulnerablePaths ?? 0;
  const resolvedEliminated = Math.max(0, resolvedBefore - resolvedRemaining);
  const guardAdded = resolvedView?.guardAdded;
  const fullySecured = step === 'resolved' && resolvedRemaining === 0;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-300 flex flex-col font-sans selection:bg-red-500/30 selection:text-red-200">
      
      {/* Cyber ambient background lighting glow */}
      <div className="absolute top-0 left-1/4 w-[500px] h-[250px] bg-red-600/5 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute top-1/2 right-1/4 w-[400px] h-[300px] bg-indigo-600/5 rounded-full blur-[100px] pointer-events-none" />

      {/* Top Navbar */}
      <header className="sticky top-0 z-40 bg-slate-950/85 backdrop-blur-md border-b border-slate-900 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          
          {/* Logo */}
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="p-2.5 bg-red-500/10 border border-red-500/30 rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(239,68,68,0.15)]">
                <Shield className="text-red-500 w-5 h-5 animate-pulse" />
              </div>
              {/* Pulsing radar point */}
              <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-emerald-500 border border-slate-950" />
            </div>
            
            <div>
              <div className="flex items-center gap-2">
                <span className="font-display font-black text-xl tracking-tight text-slate-100 uppercase">
                  Red<span className="text-red-500">line</span>
                </span>
                <span className="text-[9px] font-mono bg-slate-900 text-slate-500 px-2 py-0.5 rounded border border-slate-800">
                  v2.1
                </span>
              </div>
              <p className="text-[10px] text-slate-500 uppercase tracking-widest font-mono">Agent Security Scanner</p>
            </div>
          </div>

          {/* Quick Info & Actions */}
          <div className="flex items-center gap-4">
            
            {/* Scan History Button */}
            <div className="relative">
              <button
                onClick={() => setIsHistoryOpen(!isHistoryOpen)}
                className={`px-3.5 py-1.5 rounded-lg border text-xs font-mono flex items-center gap-2 transition-all ${
                  isHistoryOpen 
                    ? 'bg-slate-900 border-slate-700 text-slate-100' 
                    : 'bg-slate-950/40 border-slate-900 text-slate-400 hover:text-slate-200 hover:border-slate-800'
                }`}
              >
                <History className="w-3.5 h-3.5" />
                <span>Scan History</span>
                <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
              </button>

              {/* Interactive Scan History Dropdown */}
              {isHistoryOpen && (
                <div className="absolute right-0 mt-2.5 w-80 bg-slate-950 border border-slate-800 rounded-xl shadow-[0_10px_30px_rgba(0,0,0,0.8)] overflow-hidden z-50 animate-in fade-in duration-200">
                  <div className="bg-slate-900 px-4 py-3 border-b border-slate-800 flex items-center justify-between">
                    <span className="text-xs font-mono font-bold text-slate-300">RECENT DIAGNOSTICS</span>
                    <button onClick={() => setIsHistoryOpen(false)} className="text-slate-500 hover:text-slate-300">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="max-h-72 overflow-y-auto divide-y divide-slate-900">
                    {history.length === 0 && (
                      <div className="p-3.5 text-[10px] font-mono text-slate-500">No scans yet. Run a scan to populate history.</div>
                    )}
                    {history.map((row) => {
                      const paths = row.results?.summary?.vulnerablePaths ?? 0;
                      const secured = paths === 0;
                      const status = secured ? 'SECURED' : 'THREAT_FOUND';
                      const date = row.created_at ? new Date(row.created_at).toLocaleString() : '';
                      return (
                        <div key={row.id} className="p-3.5 hover:bg-slate-900/40 transition-colors">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[10px] font-mono text-slate-500">{date}</span>
                            <span className={`text-[9px] font-mono px-1.5 py-0.2 rounded font-bold ${
                              secured
                                ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-900/50'
                                : 'bg-red-950/60 text-red-400 border border-red-900/50'
                            }`}>
                              {status}
                            </span>
                          </div>
                          <h4 className="text-xs font-semibold text-slate-200 truncate">{row.agent_name || 'agent'}{row.kind === 'applyfix' ? ' (fix)' : ''}</h4>
                          <p className="text-[10px] text-slate-400 mt-0.5">{secured ? 'No unguarded paths' : `${paths} unguarded path(s)`}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Divider */}
            <span className="w-px h-6 bg-slate-800" />

            {/* Profile Avatar */}
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center overflow-hidden">
                <div className="w-full h-full bg-gradient-to-br from-red-600/30 to-indigo-600/30 flex items-center justify-center font-bold text-xs text-slate-200">
                  {(userEmail || 'RD').slice(0, 2).toUpperCase()}
                </div>
              </div>
              <div className="hidden md:block">
                <span className="block text-xs text-slate-300 font-semibold truncate max-w-[140px]">
                  Demo Session
                </span>
                <span className="block text-[9px] text-slate-500 font-mono truncate max-w-[140px]">
                  {userEmail || 'connecting...'}
                </span>
              </div>
            </div>

          </div>
        </div>
      </header>

      {/* Main Workspace Frame */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6 flex flex-col justify-center">
        
        {/* State 1: The Drop Zone */}
        {step === 'config' && (
          <div className="space-y-6 max-w-5xl mx-auto w-full animate-in fade-in slide-in-from-bottom-4 duration-300">
            
            {/* Header intro info */}
            <div className="text-center space-y-2 mb-2">
              <h1 className="font-display font-black text-3xl md:text-4xl text-slate-100 tracking-tight leading-none">
                AI Agent Vulnerability Scanner
              </h1>
              <p className="text-slate-400 text-sm md:text-base max-w-2xl mx-auto">
                Turn prompt injection into a solved graph problem. Paste your agent config to trace execution paths, expose vulnerabilities, and pinpoint exactly where to deploy a security guard.
              </p>
            </div>

            {/* Preset Selector */}
            <div className="bg-slate-900/40 p-4 rounded-xl border border-slate-900">
              <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider block mb-2.5">
                Quick Start: Paste Pre-built Vulnerable Configurations
              </span>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {PRESETS.map((preset, idx) => (
                  <button
                    key={idx}
                    onClick={() => loadPreset(preset)}
                    className="p-3 bg-slate-950/70 hover:bg-slate-900 border border-slate-850 hover:border-slate-700 rounded-lg text-left transition-all duration-150 group cursor-pointer"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <h4 className="text-xs font-semibold text-slate-200 group-hover:text-slate-100 font-display">
                        {preset.name}
                      </h4>
                      <ChevronRight className="w-3.5 h-3.5 text-slate-500 group-hover:translate-x-0.5 transition-transform" />
                    </div>
                    <p className="text-[10px] text-slate-500 leading-normal line-clamp-2">
                      {preset.desc}
                    </p>
                  </button>
                ))}
              </div>
            </div>

            {/* Large Config card */}
            <div className="bg-slate-900/20 border border-slate-900 rounded-2xl overflow-hidden shadow-2xl animate-in fade-in duration-300">
              
              {/* Sleek inline tabbed navigation header */}
              <div className="bg-slate-900 px-5 py-4 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500/80 shrink-0" />
                  <span className="text-xs font-mono font-bold text-slate-300">AGENT AUDIT INTERFACE</span>
                </div>

                {/* SaaS Tab toggles */}
                <div className="flex items-center bg-slate-950 p-1 rounded-xl border border-slate-800 self-start sm:self-center">
                  <button
                    onClick={() => {
                      setActiveInputTab('paste');
                      setGitError(null);
                    }}
                    className={`px-3 py-1.5 text-xs font-mono font-medium rounded-lg transition-all cursor-pointer ${
                      activeInputTab === 'paste'
                        ? 'bg-slate-900 text-slate-100 shadow-sm border border-slate-800'
                        : 'text-slate-400 hover:text-slate-200 border border-transparent'
                    }`}
                  >
                    Paste Code
                  </button>
                  <button
                    onClick={() => {
                      setActiveInputTab('github');
                      setGitError(null);
                    }}
                    className={`px-3 py-1.5 text-xs font-mono font-medium rounded-lg transition-all cursor-pointer ${
                      activeInputTab === 'github'
                        ? 'bg-slate-900 text-slate-100 shadow-sm border border-slate-800'
                        : 'text-slate-400 hover:text-slate-200 border border-transparent'
                    }`}
                  >
                    Connect GitHub Repo
                  </button>
                  <button
                    onClick={() => {
                      setActiveInputTab('cli');
                      setGitError(null);
                    }}
                    className={`px-3 py-1.5 text-xs font-mono font-medium rounded-lg transition-all cursor-pointer ${
                      activeInputTab === 'cli'
                        ? 'bg-slate-900 text-slate-100 shadow-sm border border-slate-800'
                        : 'text-slate-400 hover:text-slate-200 border border-transparent'
                    }`}
                  >
                    CLI Instructions
                  </button>
                </div>

                <div className="flex items-center gap-2 self-end sm:self-center">
                  {activeInputTab === 'paste' && (
                    <>
                      <span className="text-[10px] font-mono text-slate-500">Syntax check:</span>
                      {jsonError ? (
                        <span className="text-[10px] font-mono text-red-400 bg-red-950/30 border border-red-900 px-2 py-0.5 rounded animate-pulse">
                          Syntax Invalid
                        </span>
                      ) : (
                        <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/30 border border-emerald-900 px-2 py-0.5 rounded">
                          Valid Structure
                        </span>
                      )}
                    </>
                  )}

                  {activeInputTab === 'github' && (
                    <>
                      <span className="text-[10px] font-mono text-slate-500">GitHub integration:</span>
                      {gitStatus === 'found' ? (
                        <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/30 border border-emerald-900 px-2 py-0.5 rounded">
                          Linked
                        </span>
                      ) : (
                        <span className="text-[10px] font-mono text-amber-400 bg-amber-950/30 border border-amber-900 px-2 py-0.5 rounded animate-pulse">
                          Awaiting Connection
                        </span>
                      )}
                    </>
                  )}

                  {activeInputTab === 'cli' && (
                    <>
                      <span className="text-[10px] font-mono text-slate-500">Local Sandbox:</span>
                      <span className="text-[10px] font-mono text-indigo-400 bg-indigo-950/30 border border-indigo-900 px-2 py-0.5 rounded">
                        Offline Ready
                      </span>
                    </>
                  )}
                </div>
              </div>

              {/* Render dynamic tab views */}
              {activeInputTab === 'paste' && (
                <div className="grid grid-cols-1 lg:grid-cols-12 animate-in fade-in duration-200">
                  
                  {/* The Code input */}
                  <div className="lg:col-span-8 border-r border-slate-900 relative">
                    
                    {/* Pseudo Line Numbers bar */}
                    <div className="absolute left-0 top-0 bottom-0 w-10 bg-slate-950/50 border-r border-slate-900 flex flex-col pt-4 select-none text-right pr-2 text-[10px] font-mono text-slate-600 space-y-1">
                      {Array.from({ length: 28 }).map((_, i) => (
                        <span key={i}>{i + 1}</span>
                      ))}
                    </div>

                    <textarea
                      value={editorContent}
                      onChange={handleEditorChange}
                      placeholder="Paste your agent JSON here..."
                      className="w-full h-96 bg-slate-950 pl-14 pr-4 py-4 font-mono text-xs text-red-400/90 focus:outline-none focus:text-slate-100 leading-relaxed resize-none overflow-y-auto scrollbar-thin"
                      spellCheck="false"
                    />
                  </div>

                  {/* Information sidebar inside DropZone card */}
                  <div className="lg:col-span-4 bg-slate-950/60 p-6 flex flex-col justify-between space-y-6">
                    <div>
                      <h3 className="font-display font-bold text-slate-100 text-sm mb-2 flex items-center gap-1.5">
                        <Info className="w-4 h-4 text-red-500" />
                        How Prompt Injection Maps work:
                      </h3>
                      
                      <ul className="space-y-3.5 text-xs text-slate-400 leading-relaxed list-none pl-0">
                        <li className="flex items-start gap-2.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-red-500 mt-1.5 shrink-0" />
                          <span><strong>Untrusted Sources</strong> like email inputs load external payloads directly into the LLM context.</span>
                        </li>
                        <li className="flex items-start gap-2.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-slate-600 mt-1.5 shrink-0" />
                          <span><strong>AI Agent Tools</strong> execute logic based on semantic intents derived from raw model classifications.</span>
                        </li>
                        <li className="flex items-start gap-2.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-red-500 mt-1.5 shrink-0" />
                          <span><strong>Privileged Sinks</strong> (APIs, Database hooks) execute high-risk commands without secondary validation.</span>
                        </li>
                      </ul>
                    </div>

                    {/* Status checklist and API Key notification */}
                    <div className="bg-slate-900/60 p-4 rounded-xl border border-slate-850 text-xs">
                      <span className="font-semibold text-slate-300 block mb-1">Redline Security Engine Status</span>
                      <div className="flex items-center gap-1.5 text-[11px] text-slate-500 font-mono">
                        <span className="w-2 h-2 rounded-full bg-emerald-500" />
                        <span>Ready for live heuristic mapping</span>
                      </div>
                    </div>
                  </div>

                </div>
              )}

              {activeInputTab === 'github' && (
                <div className="grid grid-cols-1 lg:grid-cols-12 animate-in fade-in duration-200">
                  <div className="lg:col-span-8 border-r border-slate-900 bg-slate-950/40 p-6 flex flex-col justify-center space-y-6">
                    <div className="space-y-4 max-w-lg mx-auto w-full">
                      <div className="flex items-center gap-3">
                        <svg className="w-8 h-8 text-slate-400 shrink-0" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                        </svg>
                        <div>
                          <h3 className="font-display font-bold text-slate-100 text-sm">Connect GitHub Repository</h3>
                          <p className="text-xs text-slate-500">Scan configs directly from your version control</p>
                        </div>
                      </div>

                      <div className="space-y-3">
                        <div>
                          <label className="text-[10px] font-mono text-slate-500 uppercase block mb-1">Repository Name</label>
                          <input
                            type="text"
                            value={gitRepo}
                            onChange={(e) => {
                              setGitRepo(e.target.value);
                              setGitStatus('idle');
                            }}
                            placeholder="e.g. owner/repository"
                            className="w-full bg-slate-950 border border-slate-800 focus:border-red-500/50 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none"
                          />
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="text-[10px] font-mono text-slate-500 uppercase block mb-1">Branch</label>
                            <input
                              type="text"
                              value={gitBranch}
                              onChange={(e) => {
                                setGitBranch(e.target.value);
                                setGitStatus('idle');
                              }}
                              placeholder="main"
                              className="w-full bg-slate-950 border border-slate-800 focus:border-red-500/50 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none"
                            />
                          </div>

                          <div className="flex items-end">
                            <button
                              onClick={() => {
                                if (!gitRepo) return;
                                setGitStatus('checking');
                                setTimeout(() => {
                                  setGitStatus('found');
                                }, 1200);
                              }}
                              disabled={gitStatus === 'checking'}
                              className="w-full py-2 bg-slate-900 hover:bg-slate-850 border border-slate-800 rounded-lg text-xs font-mono text-slate-300 hover:text-slate-100 flex items-center justify-center gap-2 transition-all cursor-pointer"
                            >
                              {gitStatus === 'checking' ? (
                                <>
                                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-red-500" />
                                  <span>Verifying...</span>
                                </>
                              ) : gitStatus === 'found' ? (
                                <>
                                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                                  <span className="text-emerald-400">Connected</span>
                                </>
                              ) : (
                                <span>Fetch Repo Files</span>
                              )}
                            </button>
                          </div>
                        </div>
                      </div>

                      {gitStatus === 'found' && (
                        <div className="bg-slate-950/80 p-3.5 rounded-xl border border-emerald-950/50 space-y-2 animate-in fade-in duration-200">
                          <span className="text-[10px] font-mono text-emerald-400 uppercase block">Found Security Schemas:</span>
                          <div className="space-y-1.5">
                            <button 
                              onClick={() => {
                                setEditorContent(DEFAULT_AGENT_CONFIG);
                              }}
                              className="w-full text-left p-2.5 bg-slate-900/50 hover:bg-slate-900 border border-slate-800 rounded-lg text-xs font-mono text-slate-300 flex items-center justify-between"
                            >
                              <span className="flex items-center gap-1.5">
                                <Code className="w-3.5 h-3.5 text-slate-500" />
                                agent_config.json <span className="text-[9px] text-slate-600">(Detected support schema)</span>
                              </span>
                              <span className="text-[10px] text-red-500 animate-pulse bg-red-950/30 px-1.5 py-0.5 rounded font-bold">UNSECURED</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Right side config info */}
                  <div className="lg:col-span-4 bg-slate-950/60 p-6 flex flex-col justify-between space-y-6">
                    <div>
                      <h3 className="font-display font-bold text-slate-100 text-sm mb-2 flex items-center gap-1.5">
                        <Sparkles className="w-4 h-4 text-red-500" />
                        CI/CD DevSecOps Integration
                      </h3>
                      <ul className="space-y-3.5 text-xs text-slate-400 leading-relaxed list-none pl-0">
                        <li className="flex items-start gap-2.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-red-500 mt-1.5 shrink-0" />
                          <span><strong>Pull Request Checks:</strong> Redline blocks merges if a commit introduces a direct execute path from an untrusted source to a privileged sink.</span>
                        </li>
                        <li className="flex items-start gap-2.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-slate-600 mt-1.5 shrink-0" />
                          <span><strong>Automatic Patch Proposals:</strong> Generates secure Input Sanitizer middleware logic as inline PR code comments.</span>
                        </li>
                      </ul>
                    </div>

                    <div className="bg-slate-900/60 p-4 rounded-xl border border-slate-850 text-xs">
                      <span className="font-semibold text-slate-300 block mb-1">Connection Integrity Check</span>
                      <div className="flex items-center gap-1.5 text-[11px] text-slate-500 font-mono">
                        <span className={`w-2 h-2 rounded-full ${gitStatus === 'found' ? 'bg-emerald-500' : 'bg-slate-700'}`} />
                        <span>{gitStatus === 'found' ? `${gitRepo} verified` : 'Awaiting credentials'}</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeInputTab === 'cli' && (
                <div className="grid grid-cols-1 lg:grid-cols-12 animate-in fade-in duration-200">
                  <div className="lg:col-span-8 border-r border-slate-900 bg-slate-950/40 p-6 flex flex-col justify-center">
                    <div className="space-y-4 max-w-xl mx-auto w-full font-mono text-xs">
                      <div className="flex items-center gap-2 mb-2">
                        <TerminalIcon className="w-5 h-5 text-red-500" />
                        <span className="font-semibold text-slate-300">INTEGRATE VIA LOCAL TERMINAL</span>
                      </div>

                      <div className="bg-slate-950 border border-slate-850 rounded-lg p-4 space-y-3 relative overflow-hidden">
                        <div className="absolute right-3 top-3 text-[10px] text-slate-600 uppercase select-none">BASH</div>
                        
                        <div className="space-y-1">
                          <span className="text-slate-600"># 1. Install Redline CLI globally</span>
                          <div className="flex justify-between items-center bg-slate-900 p-2 rounded border border-slate-850">
                            <span className="text-emerald-400 select-all">npm install -g @redline/agent-cli</span>
                          </div>
                        </div>

                        <div className="space-y-1">
                          <span className="text-slate-600"># 2. Authenticate using your security token</span>
                          <div className="flex justify-between items-center bg-slate-900 p-2 rounded border border-slate-850">
                            <span className="text-emerald-400 select-all">redline auth login --token rl_token_8014_ss</span>
                          </div>
                        </div>

                        <div className="space-y-1">
                          <span className="text-slate-600"># 3. Analyze your custom agent configuration</span>
                          <div className="flex justify-between items-center bg-slate-900 p-2 rounded border border-slate-850">
                            <span className="text-emerald-400 select-all">redline scan --file ./agent.json --detailed</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 text-[10px] text-slate-500">
                        <Info className="w-3.5 h-3.5 shrink-0" />
                        <span>Supports custom local config paths, CI integration, and export formats (JSON/HTML/YAML).</span>
                      </div>
                    </div>
                  </div>

                  {/* Right side CLI details */}
                  <div className="lg:col-span-4 bg-slate-950/60 p-6 flex flex-col justify-between space-y-6">
                    <div>
                      <h3 className="font-display font-bold text-slate-100 text-sm mb-2 flex items-center gap-1.5">
                        <TerminalIcon className="w-4 h-4 text-red-500" />
                        Local Sandbox Rules
                      </h3>
                      <ul className="space-y-3.5 text-xs text-slate-400 leading-relaxed list-none pl-0">
                        <li className="flex items-start gap-2.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-red-500 mt-1.5 shrink-0" />
                          <span><strong>Zero-Knowledge Encryption:</strong> Your JSON schema files are decrypted locally in memory. Redline's validation parser handles mapping without transferring backend secrets.</span>
                        </li>
                        <li className="flex items-start gap-2.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-slate-600 mt-1.5 shrink-0" />
                          <span><strong>Pre-commit Hooks:</strong> Block developers from committing circular maps or dangerous sinks into critical branches.</span>
                        </li>
                      </ul>
                    </div>

                    <div className="bg-slate-900/60 p-4 rounded-xl border border-slate-850 text-xs">
                      <span className="font-semibold text-slate-300 block mb-1">Local CLI Status</span>
                      <div className="flex items-center gap-1.5 text-[11px] text-slate-500 font-mono">
                        <span className="w-2 h-2 rounded-full bg-indigo-500" />
                        <span>Awaiting local command handshake</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Error overlay or warning */}
              {jsonError && (
                <div className="bg-red-950/50 border-t border-red-900 px-6 py-3 text-xs text-red-400 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span className="font-mono">{jsonError}</span>
                </div>
              )}
              {scanError && !jsonError && (
                <div className="bg-red-950/50 border-t border-red-900 px-6 py-3 text-xs text-red-400 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span className="font-mono">Backend error: {scanError}</span>
                </div>
              )}

              {/* Call to Action Button */}
              <div className="bg-slate-900 px-6 py-4 flex items-center justify-between border-t border-slate-800">
                <span className="text-xs text-slate-500 font-mono">Trace depth limit: 12 edges</span>
                <button
                  onClick={handleRunScan}
                  className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-red-600 to-red-500 hover:from-red-500 hover:to-red-400 font-semibold text-slate-50 text-sm flex items-center gap-2 shadow-[0_4px_20px_rgba(239,68,68,0.3)] hover:shadow-[0_4px_30px_rgba(239,68,68,0.5)] transition-all cursor-pointer transform hover:-translate-y-0.5 active:translate-y-0"
                >
                  <TerminalIcon className="w-4 h-4" />
                  <span>Run Vulnerability Scan</span>
                </button>
              </div>

            </div>

          </div>
        )}

        {/* State 2: Loading Terminal (Initial Scan) */}
        {step === 'loading_scan' && (
          <div className="animate-in fade-in zoom-in-95 duration-300">
            <TerminalLoader 
              logsSequence={SCAN_LOGS_SEQUENCE} 
              onFinished={handleScanFinished} 
              title="REDLINE HEURISTICS PROCESSOR - SECURITY PATH VERIFICATION"
            />
          </div>
        )}

        {/* State 2.1: Loading Terminal (Applying Patch) */}
        {step === 'loading_fix' && (
          <div className="animate-in fade-in zoom-in-95 duration-300">
            <TerminalLoader 
              logsSequence={FIX_LOGS_SEQUENCE} 
              onFinished={handleFixFinished} 
              title="AUTOMATED PATCH PIPELINE - SECURITY INTERMEDIARY INJECTION"
            />
          </div>
        )}

        {/* State 3 & 4: The Graph & Exploit View (The Reveal & Resolved) */}
        {(step === 'vulnerable' || step === 'resolved') && (
          <div className="space-y-6 animate-in fade-in duration-300">
            
            {/* Split Screen Panel */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
              
              {/* Graph Panel (70%) */}
              <div className="lg:col-span-8 flex flex-col">
                <GraphArea
                  step={step}
                  nodes={activeNodes}
                  edges={activeEdges}
                  selectedNodeId={selectedNode?.id || ''}
                  onSelectNode={(node) => setSelectedNode(node)}
                />
              </div>

              {/* Sidebar Panel (30%) */}
              <div className="lg:col-span-4 bg-slate-900/30 rounded-2xl border border-slate-800 p-6 flex flex-col justify-between space-y-6">
                
                {/* Upper sidebar content */}
                <div className="space-y-6">
                  
                  {/* Status header badge */}
                  <div>
                    {step === 'vulnerable' ? (
                      <div className="p-3 bg-red-950/40 border border-red-900/60 rounded-xl">
                        <div className="flex items-center gap-2 text-red-500 mb-1.5">
                          <AlertTriangle className="w-5 h-5 shrink-0 animate-bounce" />
                          <h3 className="font-display font-black text-sm tracking-wide uppercase">
                            {vulnCount} Vulnerable Path{vulnCount === 1 ? '' : 's'} Found
                          </h3>
                        </div>
                        <p className="text-[11px] font-mono text-red-400">
                          SEVERITY: {topSeverity} • {activeResults?.summary.sources ?? 0} SOURCES → {activeResults?.summary.sinks ?? 0} PRIVILEGED SINKS
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className={`p-3 rounded-xl border ${fullySecured ? 'bg-emerald-950/40 border-emerald-900/60' : 'bg-amber-950/40 border-amber-900/60'}`}>
                          <div className={`flex items-center gap-2 mb-1.5 ${fullySecured ? 'text-emerald-400' : 'text-amber-400'}`}>
                            <CheckCircle2 className="w-5 h-5 shrink-0" />
                            <h3 className="font-display font-black text-sm tracking-wide uppercase">
                              {fullySecured ? 'All Paths Secured' : 'Critical Path Secured'}
                            </h3>
                          </div>
                          <p className={`text-[11px] font-mono ${fullySecured ? 'text-emerald-400' : 'text-amber-400'}`}>
                            {resolvedEliminated} OF {resolvedBefore} PATHS ELIMINATED{resolvedRemaining > 0 ? ` • ${resolvedRemaining} REMAINING` : ''}
                          </p>
                        </div>

                        {/* Post-Scan Upsell CTA Card */}
                        <div className="p-4 bg-slate-950/90 border border-slate-800/80 rounded-xl shadow-[0_0_20px_rgba(30,41,59,0.5)] relative overflow-hidden group animate-in slide-in-from-top-2 duration-300">
                          <div className="absolute top-0 right-0 p-3 opacity-5 group-hover:opacity-10 transition-opacity">
                            <svg className="w-10 h-10 text-slate-300" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                            </svg>
                          </div>
                          <div className="space-y-3">
                            <p className="text-xs text-slate-300 leading-relaxed">
                              Keep your agents secure in production. Connect your GitHub repository to run Redline on every pull request.
                            </p>

                            <button
                              onClick={() => {
                                setStep('config');
                                setActiveInputTab('github');
                                setGitStatus('found');
                              }}
                              className="w-full py-2 bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 hover:text-slate-100 font-mono text-[11px] font-semibold rounded-lg shadow-sm transition-all flex items-center justify-center gap-2 cursor-pointer hover:border-slate-700"
                            >
                              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                              </svg>
                              <span>Connect GitHub</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Dynamic Tab Panel: Exploit vs Node Inspector */}
                  <div className="space-y-4">
                    
                    <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
                      <span className="text-xs font-mono text-slate-500 uppercase tracking-wider">Telemetry Insights</span>
                      {selectedNode && (
                        <span className="text-[10px] text-indigo-400 font-mono">Inspecting: {selectedNode.label}</span>
                      )}
                    </div>

                    {/* Node Specific parameters display if hovered/clicked */}
                    {selectedNode && (
                      <div className="bg-slate-950/80 p-4 rounded-xl border border-slate-850 space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-slate-200">{selectedNode.label}</span>
                          <span className={`text-[9px] font-mono px-2 py-0.5 rounded ${
                            selectedNode.status === 'vulnerable' ? 'bg-red-950 text-red-400 border border-red-900/30' :
                            selectedNode.status === 'secured' ? 'bg-emerald-950 text-emerald-400 border border-emerald-900/30' :
                            'bg-slate-900 text-slate-400 border border-slate-800'
                          }`}>
                            {selectedNode.status.toUpperCase()}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-400 leading-normal">{selectedNode.description}</p>
                        
                        {/* Key-values nested */}
                        {selectedNode.details && (
                          <div className="pt-2 border-t border-slate-900 space-y-1">
                            {Object.entries(selectedNode.details).map(([key, val]) => (
                              <div key={key} className="flex justify-between text-[10px] font-mono">
                                <span className="text-slate-500">{key}:</span>
                                <span className="text-slate-300 font-semibold">{val}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Exploit Narrative */}
                    <div className="space-y-2">
                      <span className="text-[11px] font-mono text-slate-400 uppercase tracking-wider block">Exploit Narrative:</span>
                      <p className="text-xs text-slate-300 leading-relaxed bg-slate-950/40 p-3 rounded-xl border border-slate-850/80">
                        {step === 'vulnerable'
                          ? (selectedExplanation || 'Untrusted input can reach a privileged sink without passing through any guard.')
                          : fullySecured
                            ? `The ${guardAdded?.guard || 'human_approval'} guard now intercepts every flow into "${guardAdded?.placement}". Injected instructions can no longer trigger a privileged action without approval.`
                            : (selectedExplanation || `${resolvedRemaining} path(s) still reach a privileged sink. Add another guard to close them.`)}
                      </p>
                    </div>

                    {/* Remediation */}
                    <div className="space-y-2">
                      <span className="text-[11px] font-mono text-slate-400 uppercase tracking-wider block">Remediation Action:</span>
                      <div className={`p-3.5 rounded-xl border text-xs leading-normal ${
                        step === 'vulnerable'
                          ? 'bg-red-950/10 border-red-900/30 text-red-300 shadow-[0_0_15px_rgba(239,68,68,0.02)]'
                          : 'bg-emerald-950/10 border-emerald-900/30 text-emerald-300 shadow-[0_0_15px_rgba(16,185,129,0.02)]'
                      }`}>
                        {step === 'vulnerable' ? (
                          recFix ? (
                            <><strong>Optimal Chokepoint:</strong> {recFix.rationale || `Place a ${recFix.guard} guard at "${recFix.placement}" to eliminate ${recFix.pathsEliminated} of ${recFix.pathsTotal} vulnerable paths.`}</>
                          ) : (
                            <><strong>No fix needed:</strong> no unguarded path reaches a privileged sink.</>
                          )
                        ) : (
                          <><strong>Guard deployed:</strong> {guardAdded?.guard || 'human_approval'} at "{guardAdded?.placement}". {resolvedEliminated} of {resolvedBefore} paths eliminated{resolvedRemaining > 0 ? `, ${resolvedRemaining} remaining` : ''}.</>
                        )}
                      </div>
                    </div>

                    {/* Vulnerable path list */}
                    {step === 'vulnerable' && (activeResults?.vulnerablePaths?.length ?? 0) > 0 && (
                      <div className="space-y-2">
                        <span className="text-[11px] font-mono text-slate-400 uppercase tracking-wider block">Vulnerable Paths ({vulnCount}):</span>
                        <div className="space-y-1.5 max-h-40 overflow-y-auto scrollbar-thin">
                          {activeResults!.vulnerablePaths.map((p) => (
                            <div key={p.id} className="bg-slate-950/60 border border-slate-850/80 rounded-lg px-2.5 py-1.5">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[10px] font-mono text-slate-300 truncate">{p.path.join(' → ')}</span>
                                <span className={`text-[8px] font-mono px-1.5 py-0.5 rounded shrink-0 ${
                                  p.severity === 'critical' ? 'bg-red-950 text-red-400 border border-red-900/40' : 'bg-amber-950 text-amber-400 border border-amber-900/40'
                                }`}>
                                  {p.severity.toUpperCase()}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                  </div>

                </div>

                {/* Bottom interactive action */}
                <div className="pt-4 border-t border-slate-900">
                  {step === 'vulnerable' ? (
                    <button
                      onClick={handleApplyFix}
                      className="w-full py-3 px-4 bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-slate-50 font-bold text-xs font-mono uppercase tracking-widest rounded-xl transition-all shadow-[0_4px_20px_rgba(16,185,129,0.2)] hover:shadow-[0_4px_35px_rgba(16,185,129,0.4)] flex items-center justify-center gap-2 cursor-pointer transform hover:-translate-y-0.5 active:translate-y-0"
                    >
                      <ShieldCheck className="w-4 h-4" />
                      <span>Apply Fix & Rescan</span>
                    </button>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 justify-center text-xs text-emerald-400 font-mono">
                        <Check className="w-3.5 h-3.5 bg-emerald-950 border border-emerald-900 rounded-full p-0.5" />
                        <span>Continuous Scan Shield Active</span>
                      </div>
                    </div>
                  )}

                  <button
                    onClick={() => {
                      setStep('config');
                      setSelectedNode(null);
                    }}
                    className="w-full mt-2 py-2 px-4 bg-slate-950 hover:bg-slate-900 text-slate-500 hover:text-slate-300 font-mono text-[10px] uppercase tracking-wide rounded-lg border border-slate-900 hover:border-slate-800 transition-all cursor-pointer"
                  >
                    ← Back to Config Editor
                  </button>
                </div>

              </div>

            </div>

          </div>
        )}

      </main>

      {/* State 4: The Paywall / Pricing Modal */}
      {isPaywallOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-300">
          <div className="w-full max-w-4xl mx-4 bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-[0_30px_70px_rgba(0,0,0,0.9)] max-h-[90vh] flex flex-col md:flex-row relative">
            
            {/* Close button */}
            <button
              onClick={() => setIsPaywallOpen(false)}
              className="absolute top-4 right-4 z-50 text-slate-500 hover:text-slate-300 p-1.5 rounded-full bg-slate-950/80 border border-slate-800 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>

            {/* Left Column: Pro features & benefits pitch (55% width) */}
            <div className="flex-1 p-6 md:p-8 bg-gradient-to-br from-slate-950 via-slate-950 to-red-950/10 space-y-6 flex flex-col justify-between">
              <div>
                <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-red-500/10 border border-red-500/30 rounded-full text-red-400 text-[10px] font-mono uppercase tracking-widest mb-4">
                  <Sparkles className="w-3 h-3 text-red-500 animate-pulse" /> Limited Free Scan Used
                </div>
                
                <h2 className="font-display font-black text-2xl md:text-3xl text-slate-100 tracking-tight leading-tight">
                  Upgrade to <span className="text-red-500">Redline Pro</span>
                </h2>
                <p className="text-slate-400 text-xs md:text-sm mt-1 leading-relaxed">
                  Out of free scans. Continuous security mapping ensures prompt injection safety limits are verified automatically inside production workflows.
                </p>
              </div>

              {/* Benefits checklists */}
              <div className="space-y-3.5 py-4">
                <div className="flex items-start gap-3">
                  <div className="p-1 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 mt-0.5">
                    <Check className="w-3 h-3" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-slate-200">Continuous Auto-Scanning</h4>
                    <p className="text-[11px] text-slate-500">Verify vulnerability coverage 24/7 on every tool update and logic path change.</p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="p-1 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 mt-0.5">
                    <Check className="w-3 h-3" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-slate-200">Unlimited Multi-Agent Scans</h4>
                    <p className="text-[11px] text-slate-500">Map up to 100 source, tool, and privileged API sink connections simultaneously.</p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="p-1 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 mt-0.5">
                    <Check className="w-3 h-3" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-slate-200">Automated Pull Request Remediations</h4>
                    <p className="text-[11px] text-slate-500">Auto-generate and push secured Input Sanitizer middleware directly to GitHub.</p>
                  </div>
                </div>
              </div>

              {/* Pricing breakdown */}
              <div className="bg-slate-900/60 p-4 rounded-2xl border border-slate-850 flex items-center justify-between">
                <div>
                  <span className="text-[10px] text-slate-500 font-mono block">DEVELOPER PRO LICENSE</span>
                  <div className="flex items-baseline gap-1">
                    <span className="text-2xl font-display font-black text-slate-100">$49</span>
                    <span className="text-xs text-slate-500">/mo billed yearly</span>
                  </div>
                </div>
                <div className="text-right text-[11px] text-emerald-400 font-mono font-bold bg-emerald-950/40 border border-emerald-900/60 px-2.5 py-1 rounded-lg">
                  Save 20% Active
                </div>
              </div>
            </div>

            {/* Right Column: Checkout credit card form (45% width) */}
            <div className="w-full md:w-[380px] bg-slate-900/80 p-6 md:p-8 border-t md:border-t-0 md:border-l border-slate-800 flex flex-col justify-center">
              
              {paymentSuccess ? (
                <div className="text-center space-y-4 py-8 animate-in zoom-in-95 duration-300">
                  <div className="w-16 h-16 bg-emerald-500/10 border border-emerald-500/30 rounded-full flex items-center justify-center mx-auto shadow-[0_0_20px_rgba(16,185,129,0.2)]">
                    <CheckCircle2 className="w-8 h-8 text-emerald-500 animate-bounce" />
                  </div>
                  
                  <div>
                    <h3 className="font-display font-bold text-slate-100 text-lg">Payment Successful!</h3>
                    <p className="text-xs text-slate-400 mt-1">
                      Welcome to Redline Pro! Your account has been upgraded to unlimited scan privileges.
                    </p>
                  </div>

                  <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-850 text-left space-y-1 text-[11px] font-mono">
                    <div className="flex justify-between">
                      <span className="text-slate-500">License ID:</span>
                      <span className="text-slate-300">RL-PRO-2026-9041</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Status:</span>
                      <span className="text-emerald-400">Unlimited Active</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Billing:</span>
                      <span className="text-slate-300">Developer Annually</span>
                    </div>
                  </div>

                  <button
                    onClick={handleReturnFromUpgrade}
                    className="w-full py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 font-semibold text-xs font-mono uppercase tracking-wider rounded-xl transition-all cursor-pointer"
                  >
                    Run Scan (Pro Unlocked)
                  </button>
                </div>
              ) : (
                <form onSubmit={handleProcessUpgrade} className="space-y-4">
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold text-slate-200">Secure Payment</h3>
                    <p className="text-[10px] text-slate-500 font-mono">ENCRYPTED STRIPE SSL GATEWAY</p>
                  </div>

                  {/* Card Number */}
                  <div className="space-y-1">
                    <label className="text-[10px] font-mono text-slate-400 uppercase">Card Number</label>
                    <div className="relative">
                      <input
                        type="text"
                        required
                        placeholder="4242 •••• •••• 4242"
                        value={cardNumber}
                        onChange={(e) => setCardNumber(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 focus:border-red-500/50 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none placeholder-slate-700"
                      />
                      <CreditCard className="w-4 h-4 text-slate-600 absolute right-3 top-2.5" />
                    </div>
                  </div>

                  {/* Expiry & CVV */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-[10px] font-mono text-slate-400 uppercase">Expiry Date</label>
                      <input
                        type="text"
                        required
                        placeholder="MM / YY"
                        value={cardExpiry}
                        onChange={(e) => setCardExpiry(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 focus:border-red-500/50 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none placeholder-slate-700"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-mono text-slate-400 uppercase">CVV / CVC</label>
                      <input
                        type="password"
                        required
                        placeholder="•••"
                        maxLength={4}
                        value={cardCvv}
                        onChange={(e) => setCardCvv(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 focus:border-red-500/50 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none placeholder-slate-700"
                      />
                    </div>
                  </div>

                  {/* Cardholder name */}
                  <div className="space-y-1">
                    <label className="text-[10px] font-mono text-slate-400 uppercase">Cardholder Name</label>
                    <input
                      type="text"
                      required
                      placeholder="Serafim Sharkov"
                      value={cardName}
                      onChange={(e) => setCardName(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 focus:border-red-500/50 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none placeholder-slate-700"
                    />
                  </div>

                  {/* Submit pay */}
                  <button
                    type="submit"
                    disabled={isProcessingPayment}
                    className="w-full py-3 bg-gradient-to-r from-red-600 to-red-500 hover:from-red-500 hover:to-red-400 disabled:from-slate-800 disabled:to-slate-800 disabled:cursor-not-allowed font-bold text-xs font-mono uppercase tracking-wider rounded-xl transition-all shadow-md shadow-red-500/15 flex items-center justify-center gap-2 cursor-pointer mt-2"
                  >
                    {isProcessingPayment ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Verifying Card...</span>
                      </>
                    ) : (
                      <>
                        <Lock className="w-3.5 h-3.5" />
                        <span>Authorize $49.00 payment</span>
                      </>
                    )}
                  </button>

                  <p className="text-[10px] text-center text-slate-600 leading-normal">
                    By clicking authorize, you agree to secure automated payments. Cancel at any time in settings.
                  </p>
                </form>
              )}

            </div>

          </div>
        </div>
      )}

      {/* Humble Footer */}
      <footer className="border-t border-slate-950 bg-slate-950 py-6 px-6 text-center select-none mt-auto">
        <p className="text-xs text-slate-600 font-mono">
          REDLINE SECURITY INC • VERIFICATION SANDBOX SERVICE • SECURING AI INTEGRITY GLOBALLY
        </p>
      </footer>

    </div>
  );
}
