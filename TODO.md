# TODO

Minor issues noticed are logged here. Once resolved, remove them from the file.

---

## Figure out SSR

We should SSR pages if we have the data available. This would improve initial load time and SEO.

**Scope**: Significant architectural change. Would require:
- Server-side rendering of views with embedded data
- Hydration on client for interactivity
- Changes to routing approach

## Streaming

Support streaming instead of message by message for live chats.

**Note**: Live streaming via WebSocket is already implemented (message-by-message). This item may refer to token-by-token streaming for a typing effect, which would require:
- Daemon to emit partial messages
- API to support streaming content blocks
- Frontend to render incremental text

##
