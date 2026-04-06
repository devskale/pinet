# PiNet Phase 1: Zero-Friction Setup

## TODO

- [x] 1. CLI entry point (`pinet.mjs`) — bare `pinet` command that routes subcommands
- [x] 2. Built-in template definitions + `--list` flag (6 templates: fullstack, nextjs-devteam, devops, code-review, duo, research)
- [x] 3. `pinet init <template> <name>` — scaffold project dirs, write project.json, symlink extension, write .pi/settings.json
- [ ] 4. `pinet up` / `pinet down` — start/stop agents as child processes, login with name@team
- [ ] 5. `pinet status` / `pinet logs` / `pinet restart` — observe and manage running agents
- [ ] 6. `/pinet brief` — send scenario file to all agents via team message
- [ ] 7. Cross-machine: `pinet up --machine` — SSH to remote machines
- [ ] 8. End-to-end validation — init fullstack template, up, brief, status, down
- [ ] 9. Update docs and prd, commit and push

## Learnings

_Updated after each todo._

### After 1–3: CLI + templates + init

- All three naturally collapsed into one file (`pinet.mjs`). No need for separate modules at this scale.
- Template scaffold tested with `fullstack` template — creates 4 agent dirs, each with `.pi/settings.json` (correct model) and symlink to extension.
- `project.json` captures the full picture: agents, models, machine assignment, teams (with empty tokens for wizard to fill).
- `pinet status` already works for offline agents — shows model, machine, team token status.
- **Symlink uses relative path** — resolves correctly from the agent workspace back to the pinet package. Falls back to absolute if that fails.
- `--list` flag works. Custom templates from `~/.pinet/templates/*.json` load on top of built-ins.
