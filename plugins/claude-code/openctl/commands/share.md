# Share Session

Share this Claude Code session with an openctl server for live streaming.

## Instructions

1. Get the current session ID from the `CLAUDE_SESSION_ID` environment variable
2. Run the openctl CLI to share the session:

```bash
openctl session share $CLAUDE_SESSION_ID
```

If the user specified a server URL as an argument to /share, include it:

```bash
openctl session share $CLAUDE_SESSION_ID --server <server-url>
```

3. If the command prompts about allowing a repository, ask the user if they want to allow it
4. Report the session URL to the user when complete

## Error Handling

- If `CLAUDE_SESSION_ID` is not set, inform the user this command must be run within a Claude Code session
- If the openctl CLI is not installed, instruct the user to install it with: `bun install -g openctl`
- If the command fails, show the error output to the user
