// Frozen-contract Config samples (what the user pastes) and terminal theater.
// The Config shape is { agent, tools: [{name, description}], guards: [] };
// Person B's classifier turns it into the Graph the engine scans.

export const DEFAULT_AGENT_CONFIG = `{
  "agent": "customer-support-agent",
  "tools": [
    { "name": "read_email", "description": "Read incoming customer emails" },
    { "name": "fetch_url", "description": "Fetch content from a customer-provided URL" },
    { "name": "search_orders", "description": "Look up internal order history" },
    { "name": "issue_refund", "description": "Issue a refund to a payment method" },
    { "name": "send_email", "description": "Send a reply email" }
  ],
  "guards": []
}`;

const SLACK_COPILOT_CONFIG = `{
  "agent": "slack-copilot",
  "tools": [
    { "name": "listen_mentions", "description": "Read incoming Slack mentions from any channel member" },
    { "name": "fetch_link", "description": "Fetch and summarize an external URL shared in chat" },
    { "name": "run_sql", "description": "Execute a SQL query against the internal production database" },
    { "name": "post_message", "description": "Send a message back to the Slack channel" }
  ],
  "guards": []
}`;

const SHOPIFY_BOT_CONFIG = `{
  "agent": "shopify-fulfillment-bot",
  "tools": [
    { "name": "receive_webhook", "description": "Receive an incoming order webhook from an untrusted external source" },
    { "name": "lookup_inventory", "description": "Check internal inventory levels" },
    { "name": "fulfill_order", "description": "Charge the customer and ship the order via the Shopify API" },
    { "name": "human_approval", "description": "Require a human to approve the action before it runs" }
  ],
  "guards": ["human_approval"]
}`;

const DEVOPS_DEPLOY_CONFIG = `{
  "agent": "cicd-deploy-agent",
  "tools": [
    { "name": "read_pr_comment", "description": "Read comments posted on a pull request by any external GitHub user" },
    { "name": "fetch_build_log", "description": "Fetch a build log from a contributor-supplied CI URL" },
    { "name": "run_shell", "description": "Execute an arbitrary shell command on the deploy runner" },
    { "name": "deploy_production", "description": "Deploy the current build to the production Kubernetes cluster" }
  ],
  "guards": []
}`;

const FINTECH_TREASURY_CONFIG = `{
  "agent": "treasury-ops-agent",
  "tools": [
    { "name": "read_invoice_email", "description": "Read incoming vendor invoice emails from an external inbox" },
    { "name": "wire_transfer", "description": "Send a wire transfer to a supplier bank account" },
    { "name": "send_notification", "description": "Send an email notification to the finance team" }
  ],
  "guards": [{ "guard": "human_approval", "placement": "wire_transfer" }]
}`;

const HEALTHCARE_INTAKE_CONFIG = `{
  "agent": "patient-intake-agent",
  "tools": [
    { "name": "read_patient_message", "description": "Read an incoming patient message from the portal" },
    { "name": "lookup_record", "description": "Look up an internal patient record by id" },
    { "name": "send_prescription", "description": "Submit a prescription order to the pharmacy system" },
    { "name": "clinician_review", "description": "Require a licensed clinician to review and approve before any prescription is submitted" }
  ],
  "guards": ["clinician_review"]
}`;

// Editable template configs shown as quick-start chips. Ordered as a spectrum:
// wide-open -> partially guarded -> fully clean, across varied domains.
export const PRESETS = [
  {
    name: 'Customer Support Agent (Refund Sink)',
    desc: 'Untrusted email and URL sources feeding a privileged Stripe refund action with no guard.',
    config: DEFAULT_AGENT_CONFIG,
  },
  {
    name: 'Slack Copilot (SQL Sink)',
    desc: 'Reads external mentions and links, then runs raw SQL against production. Fully unguarded.',
    config: SLACK_COPILOT_CONFIG,
  },
  {
    name: 'CI/CD Deploy Bot (RCE)',
    desc: 'PR comments and CI logs flow into arbitrary shell execution and a production deploy. No guard.',
    config: DEVOPS_DEPLOY_CONFIG,
  },
  {
    name: 'Fintech Treasury (Partial Guard)',
    desc: 'Approval gates the wire transfer, but the notification sink is still hijackable. Shows partial coverage.',
    config: FINTECH_TREASURY_CONFIG,
  },
  {
    name: 'Healthcare Intake (Guarded)',
    desc: 'Patient messages reach a prescription sink, gated behind mandatory clinician review. Scans clean.',
    config: HEALTHCARE_INTAKE_CONFIG,
  },
  {
    name: 'Shopify Bot (Guarded)',
    desc: 'Order fulfillment gated behind a human_approval guard. Should scan clean.',
    config: SHOPIFY_BOT_CONFIG,
  },
];

// Scan Terminal Lines (theater; App overrides the final line with real counts).
export const SCAN_LOGS_SEQUENCE = [
  { text: '> Initializing Redline Scanner v2.1.8...', type: 'input' },
  { text: '> Loading agent configuration file...', type: 'info' },
  { text: '> Validating syntax and circular flows... OK', type: 'success' },
  { text: '> Connecting to Butterbase auth...', type: 'info' },
  { text: '> Authenticating session signature... [SECURE]', type: 'success' },
  { text: '> RocketRide Cloud: Classifying source and sink nodes...', type: 'info' },
  { text: '> Roles assigned: sources, sinks, guards, passthroughs', type: 'warning' },
  { text: '> Neo4j: Ingesting graph and traversing CAN_FLOW_INTO paths...', type: 'info' },
  { text: '> Checking each path for an intervening guard...', type: 'info' },
  { text: '> WARNING: Unguarded source-to-sink paths detected.', type: 'warning' },
  { text: '> VULNERABILITY DETECTED: prompt injection can reach a privileged sink.', type: 'error' },
  { text: '> Ranking chokepoints for optimal guard placement...', type: 'info' },
  { text: '> Scan complete. Rendering graph visualization...', type: 'success' },
];

// Fix Terminal Lines
export const FIX_LOGS_SEQUENCE = [
  { text: '> Initiating automated patch sequence...', type: 'input' },
  { text: '> Selecting optimal chokepoint from scan results...', type: 'info' },
  { text: '> Injecting human_approval guard at the target sink...', type: 'success' },
  { text: '> Rewiring graph edges through the new guard...', type: 'info' },
  { text: '> Neo4j: Re-traversing all source-to-sink paths...', type: 'info' },
  { text: '> Recounting unguarded paths after the fix...', type: 'success' },
  { text: '> Guard verified at the chokepoint. Recomputing exposure...', type: 'success' },
  { text: '> Patch applied. Rendering secured graph...', type: 'success' },
];
