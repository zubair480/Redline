# Spec 09: Frontend and Demo (Person D)

## Purpose

Define the Redline frontend and the pitch. The visualization is the entire
"judges remember it" thesis, so this role is the most protected slot on the
team: do not pull Person D onto anything else. The UI renders the frozen Results
shape and must start against a local mock immediately, never waiting on the
backend.

## Owns / Does Not Own

Owns: the paste-a-config UI, the columnar SVG graph, the cinematic red-trace
animation, the vulnerable-path side panel, the fix panel, the apply-fix "red
goes green" moment, and the 3-minute pitch.

Does not own: any analysis logic. The UI computes nothing about vulnerabilities;
it renders whatever Results arrive. It also does not own severity strings, path
ids, or fix placement (all come from the backend, spec 01).

## Interface

The UI consumes exactly two backend calls (Person C spec), mocked locally
against the frozen Results shape until live:

```
POST /fn/scan       body: Config                         -> { scanId, ...Results }
POST /fn/apply-fix  body: { scanId, recommendedFix }      -> { before, after, pathsEliminated, guardAdded, config }
```

Plus auth (`Authorization: Bearer <token>`) and, for the paywall beat,
`POST /fn/billing`.

It renders the frozen Results shape:
`{ summary, vulnerablePaths: [{id, path, severity, explanation}], recommendedFix }`.

## Behavior

Build in this order, verifying each stage renders before moving on. Start on the
mock Results the whole time.

1. **UI shell.** A dropdown of the 3 sample configs (support-agent,
   guarded-agent, clean-agent) loading into a textarea, plus a Scan button. On
   scan, call `/fn/scan` (mock locally until live).
2. **Graph render.** Fixed **columnar SVG** layout, not force-directed and not
   3D: sources in a left column, the single `context` node in the middle, sinks
   on the right. Grey edges by default. Label every node with its tool name and
   role. Must be legible and screenshot cleanly.
3. **Vulnerable paths.** Turn the edges on each `vulnerablePaths` entry red. A
   side panel lists each red path with its `severity` and `explanation`.
4. **The cinematic moment.** On scan, dim the rest of the screen and animate a
   glowing red trace along each vulnerable path from source to sink (SVG
   `stroke-dasharray` animation plus a CSS glow filter). Keep it 2D and smooth;
   capture a couple of still frames before and after so it reads well in a
   recording. This is the high-stakes beat and the one thing that cannot be
   rescued in the last hour if neglected early.
5. **Fix panel.** Show `recommendedFix`: which guard, where (`placement`), how
   many paths it kills (`pathsEliminated` of `pathsTotal`), plus the
   auto-remediation snippet from `/explain`. An Apply Fix button calls
   `/fn/apply-fix`, reruns, and animates the red paths turning green.

### Rendering rules that keep the UI robust

- **Render, never compute.** Draw exactly the nodes, edges, paths, severities,
  and fix the backend returns. Do not infer or recolor based on your own logic;
  the whole point is that the graph engine is the source of truth.
- **Handle `placement: null`.** A clean config returns
  `recommendedFix.placement = null` and an empty `vulnerablePaths` array. Render
  this as "No fix needed, 0 vulnerable paths" and show the graph all-grey, no
  red trace. This is the "rescan goes green" end state.
- **Do not hard-code severity strings.** Style by whatever arrives
  (`critical | high | medium`); the real engine emits `critical`/`high`, the
  mock may emit `medium` (see specs [README](README.md)). Unknown values get a
  neutral style, never a crash.
- **The context node has no role.** It is the shared LLM context window; label it
  "context" and treat it as a passthrough hub, never as a source or sink.

## Pitch (Person D drives it)

Three minutes. Paste the vulnerable support-agent config, hit scan, let the red
trace light up from `read_email` to `issue_refund`, read the plain-English
exploit, show the one-guard fix, apply it, watch it go green. Land the framing:
Redline is an agentic app that secures agentic apps, and the graph is the whole
engine, not decoration.

Rehearse the shared-context objection and the reframe:

> "Isn't everything trivially connected through the shared context?"
> "Yes, and that is exactly the finding. Every ungated privileged sink is
> reachable from every untrusted source. We show you which sinks those are and
> the single minimal guard that closes the most paths at once."

## Acceptance Criteria

- [ ] The 3 sample configs load from the dropdown and scan against the mock
      Results without any backend running
- [ ] The columnar SVG renders sources left, `context` center, sinks right, with
      readable tool-name and role labels, and screenshots cleanly
- [ ] Scanning the support-agent lights a red trace from a source to a privileged
      sink with the screen dimmed; the side panel shows each path's severity and
      explanation
- [ ] The fix panel shows the recommended guard, placement, paths eliminated, and
      the remediation snippet; Apply Fix reruns and animates red to green
- [ ] The clean-agent config renders all-grey with "no fix needed" and no crash
      on `placement: null`
- [ ] Switching `/fn/scan` from the local mock to the live Butterbase endpoint is
      a base-URL change, with no change to rendering code
- [ ] The 3-minute demo has been rehearsed twice, including the shared-context
      objection and reframe

## Open Questions

None.
