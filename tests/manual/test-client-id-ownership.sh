#!/bin/bash
# Test script for client ID and session ownership
# Run from the project root directory

set -e

SERVER_URL="http://localhost:3456"
CLI="bun run cli/index.ts"
CLIENT_ID_PATH="$HOME/.archive/client-id"

echo "=== Client ID and Session Ownership Tests ==="
echo ""

# Test 1: Client ID generation
echo "1. Testing client ID generation"
if [ -f "$CLIENT_ID_PATH" ]; then
  echo "  Client ID already exists: $(cat $CLIENT_ID_PATH)"
else
  echo "  No client ID yet, will be created on first API call"
fi
echo ""

# Test 2: Create a session with client ID
echo "2. Creating a test session"
SESSION_DATA='[{"type":"user","content":"Hello"},{"type":"assistant","content":"Hi there!"}]'
RESPONSE=$(curl -s -X POST "$SERVER_URL/api/sessions" \
  -H "Content-Type: multipart/form-data" \
  -H "X-Archive-Client-ID: $(cat $CLIENT_ID_PATH 2>/dev/null || echo 'test-client-123')" \
  -F "title=Test Session for Ownership" \
  -F "description=Testing client ID ownership" \
  -F "session_data=$SESSION_DATA")
echo "  Response: $RESPONSE"
SESSION_ID=$(echo $RESPONSE | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "  Session ID: $SESSION_ID"
echo ""

# Test 3: List sessions
echo "3. Listing sessions"
$CLI session list --server $SERVER_URL
echo ""

# Test 4: List my sessions only
echo "4. Listing my sessions only (--mine flag)"
$CLI session list --mine --server $SERVER_URL
echo ""

# Test 5: List as JSON
echo "5. Listing sessions as JSON"
$CLI session list --json --limit 3 --server $SERVER_URL
echo ""

# Test 6: Try to delete our own session
if [ -n "$SESSION_ID" ]; then
  echo "6. Deleting our own session (should succeed)"
  $CLI session delete $SESSION_ID --force --server $SERVER_URL
  echo ""
else
  echo "6. Skipping delete test - no session ID"
  echo ""
fi

# Test 7: Create another session and try to delete with different client ID
echo "7. Testing ownership protection"
# Create session with one client ID
RESPONSE=$(curl -s -X POST "$SERVER_URL/api/sessions" \
  -H "Content-Type: multipart/form-data" \
  -H "X-Archive-Client-ID: other-client-456" \
  -F "title=Other Client Session" \
  -F "description=Created by a different client" \
  -F "session_data=$SESSION_DATA")
OTHER_SESSION_ID=$(echo $RESPONSE | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "  Created session with different client: $OTHER_SESSION_ID"

# Try to delete with our client ID (should fail with 403)
echo "  Attempting to delete other client's session (should fail with 403)..."
DELETE_RESPONSE=$($CLI session delete $OTHER_SESSION_ID --force --server $SERVER_URL 2>&1 || true)
echo "  Response: $DELETE_RESPONSE"
echo ""

# Cleanup: delete the other session with the correct client ID
echo "8. Cleanup: Deleting test session with correct client ID"
curl -s -X DELETE "$SERVER_URL/api/sessions/$OTHER_SESSION_ID" \
  -H "X-Archive-Client-ID: other-client-456" || true
echo "  Cleaned up"
echo ""

echo "=== All client ID and ownership tests completed ==="
