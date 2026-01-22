# Session Sharing Plan 7: Real-time Updates

Implementation plan for WebSocket events and real-time collaboration updates. Reference: [specs/session_sharing.md](../specs/session_sharing.md)

**Prereqs:** Plan 4 (UI), existing WebSocket infrastructure

## Overview

This plan adds real-time updates for collaborator changes, allowing all connected clients to see changes immediately without manual refresh.

## Tasks

### 7.1 Define collaborator event types

Add to existing WebSocket event types:

```typescript
// src/types/events.ts
export type CollaboratorEvent =
  | { type: "collaborator_added"; id: number; email: string; role: string }
  | { type: "collaborator_removed"; id: number; email: string }
  | { type: "collaborator_updated"; id: number; role: string }
  | { type: "visibility_changed"; visibility: "public" | "private" };

export type SessionEvent =
  | CollaboratorEvent
  // ... existing event types ...
```

### 7.2 Broadcast collaborator changes from API

Update collaborator API endpoints to broadcast events:

```typescript
// src/routes/api.ts
import { broadcastToSession } from '@/lib/websocket';

// POST /api/sessions/:id/collaborators
if (method === 'POST' && collaboratorsMatch) {
  // ... existing logic ...

  const collaborator = repo.addCollaborator(sessionId, email, role, auth.userId);

  // Broadcast to connected clients
  broadcastToSession(sessionId, {
    type: 'collaborator_added',
    id: collaborator.id,
    email: collaborator.email,
    role: collaborator.role,
  });

  return jsonResponse({ ... }, 201);
}

// PATCH /api/sessions/:id/collaborators/:id
if (method === 'PATCH' && collaboratorMatch) {
  // ... existing logic ...

  const updated = repo.updateCollaboratorRole(collaboratorId, role);

  // Broadcast role change
  broadcastToSession(sessionId, {
    type: 'collaborator_updated',
    id: updated.id,
    role: updated.role,
  });

  return jsonResponse({ ... });
}

// DELETE /api/sessions/:id/collaborators/:id
if (method === 'DELETE' && collaboratorMatch) {
  // ... existing logic ...

  // Broadcast removal
  broadcastToSession(sessionId, {
    type: 'collaborator_removed',
    id: collaboratorId,
    email: collaborator.email,
  });

  // Close WebSocket for removed collaborator
  closeConnectionsForUser(sessionId, collaborator.user_id, collaborator.email);

  return new Response(null, { status: 204 });
}

// PATCH /api/sessions/:id (visibility change)
if (body.visibility !== undefined) {
  // ... existing logic ...

  // Broadcast visibility change
  broadcastToSession(sessionId, {
    type: 'visibility_changed',
    visibility: body.visibility,
  });

  return jsonResponse(updated);
}
```

### 7.3 Add WebSocket broadcast helpers

Update `src/lib/websocket.ts`:

```typescript
import type { CollaboratorEvent } from '@/types/events';

// Map of session ID to connected WebSocket clients
const sessionConnections = new Map<string, Set<WebSocket>>();

// Map of WebSocket to user info (for targeted disconnection)
const connectionUserInfo = new Map<WebSocket, { userId?: string; email?: string }>();

/**
 * Register a WebSocket connection for a session.
 */
export function registerConnection(
  sessionId: string,
  ws: WebSocket,
  userInfo?: { userId?: string; email?: string }
): void {
  if (!sessionConnections.has(sessionId)) {
    sessionConnections.set(sessionId, new Set());
  }
  sessionConnections.get(sessionId)!.add(ws);

  if (userInfo) {
    connectionUserInfo.set(ws, userInfo);
  }

  ws.addEventListener('close', () => {
    sessionConnections.get(sessionId)?.delete(ws);
    connectionUserInfo.delete(ws);
  });
}

/**
 * Broadcast an event to all clients connected to a session.
 */
export function broadcastToSession(sessionId: string, event: CollaboratorEvent): void {
  const connections = sessionConnections.get(sessionId);
  if (!connections) return;

  const message = JSON.stringify(event);

  for (const ws of connections) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

/**
 * Close WebSocket connections for a specific user on a session.
 * Used when removing a collaborator to immediately revoke access.
 */
export function closeConnectionsForUser(
  sessionId: string,
  userId?: string | null,
  email?: string | null
): void {
  const connections = sessionConnections.get(sessionId);
  if (!connections) return;

  for (const ws of connections) {
    const userInfo = connectionUserInfo.get(ws);
    if (
      (userId && userInfo?.userId === userId) ||
      (email && userInfo?.email === email)
    ) {
      ws.close(4003, 'Access revoked');
    }
  }
}
```

### 7.4 Handle events in useCollaborators hook

Update the hook to handle real-time updates:

```typescript
// src/client/hooks/useCollaborators.ts
import { useWebSocket } from '@/hooks/useWebSocket';

export function useCollaborators(sessionId: string): UseCollaboratorsReturn {
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Connect to WebSocket for real-time updates
  const { lastMessage } = useWebSocket(`/ws/sessions/${sessionId}`);

  // Handle WebSocket events
  useEffect(() => {
    if (!lastMessage) return;

    try {
      const event = JSON.parse(lastMessage.data);

      switch (event.type) {
        case 'collaborator_added':
          setCollaborators(prev => {
            // Avoid duplicates
            if (prev.some(c => c.id === event.id)) return prev;
            return [...prev, {
              id: event.id,
              email: event.email,
              role: event.role,
              user_id: null,
              status: 'invited',
              created_at: new Date().toISOString(),
              accepted_at: null,
              name: null,
              image_url: null,
            }];
          });
          break;

        case 'collaborator_updated':
          setCollaborators(prev =>
            prev.map(c =>
              c.id === event.id ? { ...c, role: event.role } : c
            )
          );
          break;

        case 'collaborator_removed':
          setCollaborators(prev =>
            prev.filter(c => c.id !== event.id)
          );
          break;
      }
    } catch {
      // Ignore non-JSON messages
    }
  }, [lastMessage]);

  // ... rest of hook ...

  return {
    collaborators,
    loading,
    error,
    refresh,
    addCollaborator,
    updateRole,
    removeCollaborator,
  };
}
```

### 7.5 Handle visibility changes

Update the visibility hook:

```typescript
// src/client/hooks/useSessionVisibility.ts
import { useWebSocket } from '@/hooks/useWebSocket';

export function useSessionVisibility(session: Session): UseSessionVisibilityReturn {
  const [visibility, setVisibilityState] = useState(session.visibility);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Listen for real-time visibility changes
  const { lastMessage } = useWebSocket(`/ws/sessions/${session.id}`);

  useEffect(() => {
    if (!lastMessage) return;

    try {
      const event = JSON.parse(lastMessage.data);
      if (event.type === 'visibility_changed') {
        setVisibilityState(event.visibility);
      }
    } catch {
      // Ignore
    }
  }, [lastMessage]);

  // ... rest of hook ...
}
```

### 7.6 Handle access revocation

When a collaborator is removed, they should be redirected:

```typescript
// src/client/components/SessionViewer.tsx
import { useWebSocket } from '@/hooks/useWebSocket';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

export function SessionViewer({ session }: { session: Session }) {
  const navigate = useNavigate();
  const { lastMessage, connectionState } = useWebSocket(`/ws/sessions/${session.id}`);

  // Handle access revocation
  useEffect(() => {
    if (connectionState === 'closed') {
      // Check if it was an access revocation (code 4003)
      // If so, redirect to sessions list
      toast.error('Your access to this session has been revoked.');
      navigate('/sessions');
    }
  }, [connectionState, navigate]);

  // ... rest of component ...
}
```

### 7.7 Create useWebSocket hook

Create a reusable WebSocket hook:

```typescript
// src/client/hooks/useWebSocket.ts
import { useState, useEffect, useRef, useCallback } from 'react';

interface UseWebSocketOptions {
  reconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

interface UseWebSocketReturn {
  lastMessage: MessageEvent | null;
  sendMessage: (data: string) => void;
  connectionState: 'connecting' | 'open' | 'closing' | 'closed';
  reconnectAttempts: number;
}

export function useWebSocket(
  url: string,
  options: UseWebSocketOptions = {}
): UseWebSocketReturn {
  const {
    reconnect = true,
    reconnectInterval = 3000,
    maxReconnectAttempts = 5,
  } = options;

  const [lastMessage, setLastMessage] = useState<MessageEvent | null>(null);
  const [connectionState, setConnectionState] = useState<'connecting' | 'open' | 'closing' | 'closed'>('connecting');
  const [reconnectAttempts, setReconnectAttempts] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}${url}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnectionState('open');
      setReconnectAttempts(0);
    };

    ws.onmessage = (event) => {
      setLastMessage(event);
    };

    ws.onclose = (event) => {
      setConnectionState('closed');

      // Don't reconnect if it was an intentional close or access revocation
      if (event.code === 4003 || !reconnect) return;

      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectTimeoutRef.current = setTimeout(() => {
          setReconnectAttempts(prev => prev + 1);
          connect();
        }, reconnectInterval);
      }
    };

    ws.onerror = () => {
      setConnectionState('closed');
    };
  }, [url, reconnect, reconnectInterval, maxReconnectAttempts, reconnectAttempts]);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      wsRef.current?.close();
    };
  }, [connect]);

  const sendMessage = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  }, []);

  return {
    lastMessage,
    sendMessage,
    connectionState,
    reconnectAttempts,
  };
}
```

### 7.8 Add connection status indicator

Show connection status in the Share Modal:

```typescript
// src/client/components/ShareModal.tsx
function ConnectionIndicator({ state }: { state: 'connecting' | 'open' | 'closing' | 'closed' }) {
  if (state === 'open') {
    return (
      <div className="flex items-center gap-1 text-xs text-green-600">
        <div className="w-2 h-2 rounded-full bg-green-500" />
        Live
      </div>
    );
  }

  if (state === 'connecting') {
    return (
      <div className="flex items-center gap-1 text-xs text-amber-600">
        <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
        Connecting...
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      <div className="w-2 h-2 rounded-full bg-gray-400" />
      Offline
    </div>
  );
}
```

## Testing Checklist

### WebSocket Events
- [ ] `collaborator_added` event broadcast when collaborator added
- [ ] `collaborator_updated` event broadcast when role changed
- [ ] `collaborator_removed` event broadcast when collaborator removed
- [ ] `visibility_changed` event broadcast when visibility changes
- [ ] Events only sent to clients connected to that session

### Real-time Updates
- [ ] New collaborator appears in modal without refresh
- [ ] Role change reflected in modal without refresh
- [ ] Removed collaborator disappears without refresh
- [ ] Visibility change reflected without refresh

### Access Revocation
- [ ] WebSocket closed when collaborator removed
- [ ] User redirected to sessions list
- [ ] Toast notification shown

### Connection Handling
- [ ] Auto-reconnect on disconnect
- [ ] Connection indicator shows correct state
- [ ] No reconnect after intentional close
- [ ] No reconnect after access revocation (4003)

## Performance Considerations

- Only broadcast to clients connected to the specific session
- Use efficient message serialization (JSON)
- Implement connection pooling if needed
- Consider debouncing rapid changes

## Rollout

1. Add WebSocket event types
2. Update API endpoints to broadcast events
3. Update hooks to handle events
4. Add connection status indicator
5. Test with multiple connected clients
