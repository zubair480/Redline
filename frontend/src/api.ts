// Butterbase client for the Redline pipeline. All calls hit the deployed
// functions (scan runs the real Neo4j engine through the tunnel). See the
// Person A/C specs for the frozen shapes.

const APP_ID = 'app_wiexpf4uwdww';
const AUTH = `https://api.butterbase.ai/auth/${APP_ID}`;
const API = `https://api.butterbase.ai/v1/${APP_ID}`;

const TOKEN_KEY = 'redline_token';
const EMAIL_KEY = 'redline_email';

// ---- Result shapes (frozen contract) ----
export interface VulnPath {
  id: string;
  path: string[];
  severity: string;
  explanation: string;
}
export interface RecommendedFix {
  guard: string;
  placement: string | null;
  pathsEliminated: number;
  pathsTotal: number;
  rationale: string;
}
export interface Results {
  summary: { sources: number; sinks: number; guards: number; vulnerablePaths: number };
  vulnerablePaths: VulnPath[];
  recommendedFix: RecommendedFix | null;
}
export interface ScanResponse extends Results {
  scanId: string;
}
export interface ApplyFixResponse {
  scanId: string;
  guardAdded: { guard: string; placement: string | null };
  before: { vulnerablePaths: number };
  after: Results;
  pathsEliminated: number;
  config: any;
}
export interface Graph {
  nodes: Array<{ id: string; role: string; privileged: boolean; rationale?: string }>;
  edges: Array<{ from: string; via?: string; to: string }>;
  guards: any[];
}
export interface ScanRow {
  id: string;
  agent_name: string | null;
  config: any;
  graph: Graph;
  results: Results;
  kind: string;
  created_at: string;
}

export class ApiError extends Error {
  status: number;
  stage?: string;
  constructor(message: string, status: number, stage?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.stage = stage;
  }
}
export class PaywallError extends Error {
  used?: number;
  freeLimit?: number;
  constructor(message: string, used?: number, freeLimit?: number) {
    super(message);
    this.name = 'PaywallError';
    this.used = used;
    this.freeLimit = freeLimit;
  }
}

function randId(): string {
  // Math.random is fine here; only used for throwaway demo credentials.
  return Math.random().toString(36).slice(2, 10);
}

// The scan runs the LLM classify + per-path explain stages sequentially, so a
// cold scan (uncached config) can take ~20s. Generous ceiling so it never
// aborts mid-analysis; cached configs return in well under a second.
const REQUEST_TIMEOUT_MS = 45000;

// fetch with an abort-based timeout so a stalled request never hangs the UI.
async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new ApiError('Request timed out', 408);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url: string, body: any, token?: string): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const r = await timedFetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { r, data };
}

// ---- Session ----
let cachedToken: string | null = null;
let sessionPromise: Promise<string> | null = null;

export function currentEmail(): string {
  return localStorage.getItem(EMAIL_KEY) || '';
}

async function establishSession(): Promise<string> {
  const existing = localStorage.getItem(TOKEN_KEY);
  if (existing) { cachedToken = existing; return existing; }

  const email = `demo-${randId()}@redline.test`;
  const password = `Redline!${randId()}`;
  // Silent signup; some deployments return a token directly, others require a login.
  let token = '';
  const signup = await postJson(`${AUTH}/signup`, { email, password, display_name: 'Redline Demo' });
  token = signup.data?.access_token || signup.data?.token || '';
  if (!token) {
    const login = await postJson(`${AUTH}/login`, { email, password });
    token = login.data?.access_token || login.data?.token || '';
    if (!token) throw new ApiError('Could not establish a demo session', signup.r.status || 500, 'auth');
  }
  cachedToken = token;
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(EMAIL_KEY, email);
  return token;
}

// Memoize the in-flight promise so concurrent callers on mount share one signup
// instead of racing and creating duplicate demo users.
export function ensureSession(): Promise<string> {
  if (cachedToken) return Promise.resolve(cachedToken);
  if (!sessionPromise) {
    sessionPromise = establishSession().catch((err) => {
      sessionPromise = null; // allow a retry on failure
      throw err;
    });
  }
  return sessionPromise;
}

// Drop the stored token so the next ensureSession() signs up a fresh demo user.
// Called when the backend rejects our token as unauthenticated (expired JWT).
function invalidateSession(): void {
  cachedToken = null;
  sessionPromise = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EMAIL_KEY);
}

async function authedPost(fnPath: string, body: any, retryOn401 = true): Promise<any> {
  const token = await ensureSession();
  const { r, data } = await postJson(`${API}/fn/${fnPath}`, body, token);
  // A stale/expired demo JWT reads as anonymous to the backend. Reset the
  // session once and retry so the user never has to clear localStorage by hand.
  if (r.status === 401 && retryOn401) {
    invalidateSession();
    return authedPost(fnPath, body, false);
  }
  if (r.status === 402) {
    const msg = data?.error?.message || data?.message || 'Free scan limit reached';
    throw new PaywallError(msg, data?.used, data?.freeLimit);
  }
  if (!r.ok) {
    const msg = data?.error?.message || data?.message || `${fnPath} failed (${r.status})`;
    throw new ApiError(msg, r.status, data?.error?.stage);
  }
  return data;
}

// ---- Pipeline calls ----
export function runScan(config: any): Promise<ScanResponse> {
  return authedPost('scan', config);
}

export function applyFix(scanId: string): Promise<ApplyFixResponse> {
  return authedPost('apply-fix', { scanId });
}

export async function billingUnlock(): Promise<void> {
  await authedPost('billing', { action: 'checkout' });
  await authedPost('billing', { action: 'confirm' });
}

export async function getHistory(retryOn401 = true): Promise<ScanRow[]> {
  const token = await ensureSession();
  const r = await timedFetch(`${API}/scans?order=created_at.desc`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.status === 401 && retryOn401) {
    invalidateSession();
    return getHistory(false);
  }
  if (!r.ok) return [];
  const data = await r.json();
  return Array.isArray(data) ? data : (data.rows ?? data.data ?? []);
}

// Fetch the stored row so we get the classified Graph (roles + rationale for
// every node); scan/apply-fix only return Results. Returns null if unavailable.
export async function fetchScanRow(scanId: string): Promise<ScanRow | null> {
  const rows = await getHistory();
  return rows.find((row) => row.id === scanId) || null;
}
