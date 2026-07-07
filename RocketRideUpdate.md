# RocketRide Update

## Commit 3bad56b — Add prompts for pipeline

Added standalone system prompt files for the two RocketRide pipelines:

- **`pipelines/prompts/classify-system.md`** — System prompt for the classify pipeline. Instructs Claude to classify each agent tool as `source`, `sink`, `guard`, or `passthrough`, infer data-flow edges between them, and return structured Graph JSON. Includes role definitions, edge inference rules, guard normalization, output schema, and a worked example.

- **`pipelines/prompts/explain-system.md`** — System prompt for the explain pipeline. Supports two modes:
  - *Path explanation*: generates a 2–3 sentence concrete exploit narrative for a vulnerable path (names tools, describes attack, states consequence).
  - *Fix rationale*: generates a 1–2 sentence rationale for a recommended guard placement.

- **`.gitignore`** — Added `.rocketride/` to ignored paths.

---

## Commit aeadbfd — Add pipeline

Added RocketRide pipeline definitions and supporting changes:

- **`pipelines/classify.pipe`** — Pipeline definition for `/classify`. Three-component flow: webhook input → Claude Haiku classifier → response output. System prompt is embedded in the LLM component config. Uses `${ANTHROPIC_API_KEY}` for auth.

- **`pipelines/explain.pipe`** — Pipeline definition for `/explain`. Same three-component flow: webhook input → Claude Sonnet explainer → response output. Handles both path-explanation and fix-rationale modes.

- **`functions/scan.ts`** — Updated the `explain()` function to support a separate `ROCKETRIDE_EXPLAIN_API_KEY` env var (falls back to `ROCKETRIDE_API_KEY`). The key is now resolved once and reused for both the path-explanation and fix-rationale fetch calls.

- **`CLAUDE.md`** — Added project-level instructions file documenting project structure, conventions, tech stack, environment variables, and API endpoints.
