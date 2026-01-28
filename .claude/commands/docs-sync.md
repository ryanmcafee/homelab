# Sync Embedded Documentation

Automatically update CLAUDE.md with the latest chart versions from values.yaml files using embedme.

## Instructions

Run the embedme tool to synchronize embedded code snippets in markdown files:

1. Execute `mise exec -- embedme CLAUDE.md AGENTS.md` to update all embedded snippets
2. Report which snippets were updated (if any)
3. If there were changes, summarize what chart versions were refreshed

After running embedme, verify the update was successful by checking the output for:
- Number of snippets embedded
- Any errors or warnings

If embedme reports changes, briefly list which charts had version updates.
