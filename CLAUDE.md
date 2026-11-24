# My Day: rules for AI agents

## Design work (always)
- For ANY design, redesign, critique, audit, polish or UI change in this project, use the **Impeccable** skill
  (`.claude/skills/impeccable`, run `/impeccable <command>`). Read its SKILL.md and `reference/craft-floor.md` before editing UI.
- Mode: **Operate** (a daily task dashboard). Scanability and clarity first, personality in the details.
- Keep the colour scheme exactly: the CSS variables in `bridge-dashboard.html` (`--blue`, `--wa`, `--gm`, `--ol`, `--me`, `--file`, `--red`, sky/lavender background). Bright and happy; no dark mode, no black UI.
- Each channel keeps its own colour: WhatsApp green, Gmail coral, Outlook blue, manual tasks purple, documents orange.
- Change only the design language (layout, spacing, typography, hierarchy, motion, copy tone). Do NOT change JavaScript behaviour, API calls, element ids used by the script, or data files.

## Safety
- WhatsApp is read-only: never add send, reply, react or mark-as-read code.
- Never commit `data/`, `config.json`, `.wwebjs_auth/`, `.wwebjs_cache/`, API keys or tokens.
- Run `npm test` after changes; all suites must pass.
