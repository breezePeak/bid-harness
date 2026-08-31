# AGENTS.md — Archived Agent Notes

Archived Agent Note records under the kind directories are frozen historical snapshots, not current authority. Never edit, reformat, translate, repair, delete, or move a sealed artifact; use an active Agent Note or current documentation for new decisions and facts.

The archival change may only relocate the complete note record, add its archive metadata, and repair or delete inbound links. Legacy sidecars remain sealed with their existing records. Do not inspect, verify, or repair links out of archived notes.

Run the [`dsh-archive-agent-notes`](../../skills/dsh-archive-agent-notes/SKILL.md) workflow and append new artifact hashes with `pnpm run verify-archived-agent-notes --write`. The normal verifier rejects changed or missing sealed artifacts, incomplete legacy records, unknown kind folders, and invalid archive metadata.
