#!/bin/bash
# Test script for repository access control commands
# Run from the project root directory

set -e

SERVER_URL="http://localhost:3456"
CLI="bun run cli/index.ts"

echo "=== Repository Access Control Tests ==="
echo ""

# Clean up any existing config for test server
echo "1. Testing repo list (should be empty or have previous entries)"
$CLI repo list --server $SERVER_URL
echo ""

# Test repo allow in current directory
echo "2. Testing repo allow (current directory)"
$CLI repo allow --server $SERVER_URL
echo ""

# Verify it was added
echo "3. Testing repo list (should show the allowed repo)"
$CLI repo list --server $SERVER_URL
echo ""

# Test repo deny
echo "4. Testing repo deny (current directory)"
$CLI repo deny --server $SERVER_URL
echo ""

# Verify it was removed
echo "5. Testing repo list (should be empty now)"
$CLI repo list --server $SERVER_URL
echo ""

# Test --all flag for list
echo "6. Testing repo list --all"
$CLI repo list --all
echo ""

# Re-allow for further tests
echo "7. Re-allowing repo for session tests"
$CLI repo allow --server $SERVER_URL
echo ""

echo "=== All repo access control tests passed ==="
