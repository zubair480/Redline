export type AppStep = 'config' | 'loading_scan' | 'vulnerable' | 'loading_fix' | 'resolved';

export interface ScanNode {
  id: string;
  label: string;
  type: 'source' | 'tool' | 'sink' | 'sanitizer';
  iconName: string;
  description: string;
  status: 'vulnerable' | 'secured' | 'neutral';
  techBadge?: string;
  details?: Record<string, string>;
}

export interface ScanEdge {
  from: string;
  to: string;
  status: 'critical' | 'secured';
  label?: string;
}

export interface TerminalLog {
  text: string;
  type: 'info' | 'success' | 'warning' | 'error' | 'input';
  timestamp: string;
}
