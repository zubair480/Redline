import { ScanNode, ScanEdge } from './types';

export const DEFAULT_AGENT_CONFIG = `{
  "agent_id": "agent_customer_support_v2",
  "version": "1.0.4",
  "metadata": {
    "engine": "Redline Agent Engine",
    "owner": "sec-ops-team"
  },
  "sources": [
    {
      "id": "src_email",
      "name": "Read Email",
      "type": "untrusted_input",
      "endpoint": "imap.company.com/inbox",
      "poll_interval": "10s"
    }
  ],
  "tools": [
    {
      "id": "tool_intent",
      "name": "Process Intent",
      "type": "llm_agent_router",
      "model": "gemini-2.5-flash",
      "system_prompt": "You are a routing agent. Decide if the user wants to check refund eligibility, open a ticket, or request a refund."
    }
  ],
  "sinks": [
    {
      "id": "sink_refund",
      "name": "Issue Refund",
      "type": "privileged_api",
      "provider": "Stripe REST API",
      "critical_level": "CRITICAL_LEVEL_3",
      "requires_approval": false
    }
  ],
  "connections": [
    {
      "source": "src_email",
      "target": "tool_intent"
    },
    {
      "source": "tool_intent",
      "target": "sink_refund"
    }
  ]
}`;

// Scan Terminal Lines
export const SCAN_LOGS_SEQUENCE = [
  { text: "> Initializing Redline Scanner v2.1.8...", type: 'input' },
  { text: "> Loading agent configuration file...", type: 'info' },
  { text: "> Validating syntax and circular flows... OK", type: 'success' },
  { text: "> Connecting to Butterbase auth...", type: 'info' },
  { text: "> Authenticating session signature... [SECURE]", type: 'success' },
  { text: "> RocketRide Cloud: Classifying source and sink nodes...", type: 'info' },
  { text: "> Source identified: 'Read Email' (untrusted_input)", type: 'warning' },
  { text: "> Sink identified: 'Issue Refund' (privileged_api)", type: 'warning' },
  { text: "> Neo4j: Traversing paths...", type: 'info' },
  { text: "> 1 direct execution path detected between source & sink", type: 'info' },
  { text: "> Checking intermediate filter validations...", type: 'info' },
  { text: "> WARNING: Unchecked paths detected. Indirect injection risk high.", type: 'warning' },
  { text: "> VULNERABILITY DETECTED: Path allows prompt injection bypass of intent-filter.", type: 'error' },
  { text: "> Threat signature: [CVE-AGENT-2026-9041] Active", type: 'error' },
  { text: "> Scanning complete. Loading graph visualization...", type: 'success' }
];

// Fix Terminal Lines
export const FIX_LOGS_SEQUENCE = [
  { text: "> Initiating automated patch sequence...", type: 'input' },
  { text: "> Requesting Butterbase security sandbox token...", type: 'info' },
  { text: "> Injecting middleware node: 'Input Sanitizer'...", type: 'success' },
  { text: "> Rewriting connection paths... OK", type: 'info' },
  { text: "> Validating data sanitization filters... [STRICT ACTIVE]", type: 'success' },
  { text: "> Re-running flow traverse on Neo4j...", type: 'info' },
  { text: "> All indirect paths checked against prompt injection rules.", type: 'success' },
  { text: "> Status: SUCCESS. The vulnerability has been blocked at optimal chokepoint.", type: 'success' },
  { text: "> Secure deployment successful. Transitioning to safe mode...", type: 'success' }
];

// Vulnerable State Graph (State 3)
export const VULNERABLE_NODES: ScanNode[] = [
  {
    id: 'src_email',
    label: 'Read Email',
    type: 'source',
    iconName: 'Mail',
    description: 'Polls external user email inbox. Untrusted external inputs are loaded directly into context.',
    status: 'vulnerable',
    techBadge: 'IMAP SSL',
    details: {
      'Endpoint': 'imap.company.com/inbox',
      'Format': 'HTML/Text Plain',
      'Access Scope': 'Read-Only',
      'Trust Boundary': 'External / Untrusted'
    }
  },
  {
    id: 'tool_intent',
    label: 'Process Intent',
    type: 'tool',
    iconName: 'Cpu',
    description: 'LLM-powered semantic parsing tool. Classifies text intents and delegates tasks.',
    status: 'neutral',
    techBadge: 'Gemini 2.5',
    details: {
      'Model': 'gemini-2.5-flash',
      'Temperature': '0.1',
      'Role Prompt': 'Routing Classifier',
      'Pre-Filter': 'None'
    }
  },
  {
    id: 'sink_refund',
    label: 'Issue Refund',
    type: 'sink',
    iconName: 'CreditCard',
    description: 'Privileged transactional database/Stripe connector. Bypasses standard confirmations.',
    status: 'vulnerable',
    techBadge: 'Stripe API',
    details: {
      'Method': 'POST /v1/refunds',
      'Max Transaction': '$5,000.00',
      'Human-in-the-Loop': 'Disabled',
      'Auth Method': 'Bearer Secret Token'
    }
  }
];

export const VULNERABLE_EDGES: ScanEdge[] = [
  { from: 'src_email', to: 'tool_intent', status: 'critical', label: 'Unsanitized Payload' },
  { from: 'tool_intent', to: 'sink_refund', status: 'critical', label: 'Direct Instruction' }
];

// Resolved State Graph (State 4)
export const RESOLVED_NODES: ScanNode[] = [
  {
    id: 'src_email',
    label: 'Read Email',
    type: 'source',
    iconName: 'Mail',
    description: 'Polls external user email inbox. Untrusted external inputs are loaded directly into context.',
    status: 'secured',
    techBadge: 'IMAP SSL',
    details: {
      'Endpoint': 'imap.company.com/inbox',
      'Format': 'HTML/Text Plain',
      'Access Scope': 'Read-Only',
      'Trust Boundary': 'External / Untrusted'
    }
  },
  {
    id: 'tool_intent',
    label: 'Process Intent',
    type: 'tool',
    iconName: 'Cpu',
    description: 'LLM-powered semantic parsing tool. Classifies text intents and delegates tasks.',
    status: 'secured',
    techBadge: 'Gemini 2.5',
    details: {
      'Model': 'gemini-2.5-flash',
      'Temperature': '0.1',
      'Role Prompt': 'Routing Classifier',
      'Pre-Filter': 'None'
    }
  },
  {
    id: 'sanitizer',
    label: 'Input Sanitizer',
    type: 'sanitizer',
    iconName: 'ShieldCheck',
    description: 'Optimal security chokepoint. Blocks prompt injections and malicious instruction overrides.',
    status: 'secured',
    techBadge: 'Redline Guard',
    details: {
      'Rule Engine': 'Llama Guard & Custom Regex',
      'Rejection Action': 'Fail-Safe & Log Threat',
      'Input Validation': 'Strict Schema Validation',
      'Latent Delay': '< 15ms'
    }
  },
  {
    id: 'sink_refund',
    label: 'Issue Refund',
    type: 'sink',
    iconName: 'CreditCard',
    description: 'Privileged transactional database/Stripe connector. Securely guarded by Input Sanitizer.',
    status: 'secured',
    techBadge: 'Stripe API',
    details: {
      'Method': 'POST /v1/refunds',
      'Max Transaction': '$5,000.00',
      'Human-in-the-Loop': 'Disabled',
      'Auth Method': 'Bearer Secret Token'
    }
  }
];

export const RESOLVED_EDGES: ScanEdge[] = [
  { from: 'src_email', to: 'tool_intent', status: 'secured', label: 'Flow Tracked' },
  { from: 'tool_intent', to: 'sanitizer', status: 'secured', label: 'Filtered Output' },
  { from: 'sanitizer', to: 'sink_refund', status: 'secured', label: 'Secured Exec' }
];
