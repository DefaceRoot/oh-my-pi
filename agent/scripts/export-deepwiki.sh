#!/usr/bin/env bash
# export-deepwiki.sh — Download DeepWiki pages as local Markdown files
#
# Uses the authenticated Devin MCP server (mcp.devin.ai) to pull wiki content
# for private repositories.
#
# Usage:
#   export DEVIN_API_KEY="your-api-key-here"
#   ./scripts/export-deepwiki.sh [owner/repo] [output-dir]
#
# Defaults:
#   repo  = DefaceRoot/CISEN-Dashboard
#   dir   = docs/wiki
#
# To get a Devin API key:
#   1. Go to https://app.devin.ai → Settings → API Keys (or Service Users)
#   2. Create a key with read access
#   3. Export it: export DEVIN_API_KEY="cog_..."

set -euo pipefail

REPO="${1:-DefaceRoot/CISEN-Dashboard}"
OUT_DIR="${2:-docs/wiki}"
MCP_URL="https://mcp.devin.ai/mcp"

if [[ -z "${DEVIN_API_KEY:-}" ]]; then
  echo "ERROR: DEVIN_API_KEY is not set."
  echo ""
  echo "To get one:"
  echo "  1. Go to https://app.devin.ai → Settings → API Keys"
  echo "  2. Create a service user or personal API key"
  echo "  3. Run: export DEVIN_API_KEY=\"your-key-here\""
  exit 1
fi

mcp_call() {
  local tool_name="$1"
  local arguments="$2"
  local id="$3"

  curl -sS -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer $DEVIN_API_KEY" \
    -d "{
      \"jsonrpc\": \"2.0\",
      \"id\": \"$id\",
      \"method\": \"tools/call\",
      \"params\": {
        \"name\": \"$tool_name\",
        \"arguments\": $arguments
      }
    }" 2>/dev/null
}

echo "=== DeepWiki Export ==="
echo "Repository: $REPO"
echo "Output:     $OUT_DIR"
echo ""

# Step 1: Get wiki structure
echo "[1/3] Fetching wiki structure..."
raw_structure=$(mcp_call "read_wiki_structure" "{\"repoName\": \"$REPO\"}" "struct-1")

# Extract the JSON data from SSE format
structure=$(echo "$raw_structure" | grep '^data: ' | sed 's/^data: //')

if echo "$structure" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if 'error' in data:
    print('MCP Error:', data['error'].get('message', str(data['error'])), file=sys.stderr)
    sys.exit(1)
content = data.get('result', {}).get('content', [])
if content and 'Error' in content[0].get('text', ''):
    print(content[0]['text'], file=sys.stderr)
    sys.exit(1)
" 2>&1; then
  : # success
else
  echo "Failed to fetch wiki structure. Check your API key and repo name."
  exit 1
fi

echo "$structure" | python3 -c "
import sys, json
data = json.load(sys.stdin)
text = data['result']['content'][0]['text']
print(text)
" > /tmp/deepwiki-structure.txt

echo "  Structure saved to /tmp/deepwiki-structure.txt"
cat /tmp/deepwiki-structure.txt
echo ""

# Step 2: Get wiki contents
echo "[2/3] Fetching wiki contents..."
raw_contents=$(mcp_call "read_wiki_contents" "{\"repoName\": \"$REPO\"}" "content-1")

contents=$(echo "$raw_contents" | grep '^data: ' | sed 's/^data: //')

if ! echo "$contents" | python3 -c "import sys, json; json.load(sys.stdin)" 2>/dev/null; then
  echo "ERROR: Failed to parse wiki contents response."
  echo "Raw response (first 500 chars):"
  echo "$raw_contents" | head -c 500
  exit 1
fi

# Step 3: Save as markdown files
echo "[3/3] Saving markdown files..."
mkdir -p "$OUT_DIR"

echo "$contents" | python3 -c "
import sys, json, os, re

out_dir = '$OUT_DIR'
data = json.load(sys.stdin)

# Handle potential error
if 'error' in data:
    print(f'Error: {data[\"error\"]}', file=sys.stderr)
    sys.exit(1)

content = data.get('result', {}).get('content', [])
if not content:
    print('No content found in wiki.', file=sys.stderr)
    sys.exit(1)

text = content[0].get('text', '')

if not text.strip():
    print('Wiki content is empty.', file=sys.stderr)
    sys.exit(1)

# The wiki contents come as a single markdown document.
# Split by top-level headers (# Title) into separate files.
sections = re.split(r'^(?=# )', text, flags=re.MULTILINE)
sections = [s.strip() for s in sections if s.strip()]

if len(sections) <= 1:
    # Single document — save as-is
    filepath = os.path.join(out_dir, 'index.md')
    with open(filepath, 'w') as f:
        f.write(text)
    print(f'  Saved: {filepath}')
else:
    # Multiple sections — save each as a separate file
    for i, section in enumerate(sections):
        # Extract title from first line
        first_line = section.split('\n', 1)[0]
        title = re.sub(r'^#+\s*', '', first_line).strip()
        # Sanitize filename
        filename = re.sub(r'[^\w\s-]', '', title).strip().lower()
        filename = re.sub(r'[\s]+', '-', filename)
        if not filename:
            filename = f'section-{i}'
        filename = f'{i:02d}-{filename}.md'
        filepath = os.path.join(out_dir, filename)
        with open(filepath, 'w') as f:
            f.write(section + '\n')
        print(f'  Saved: {filepath}')

    # Also save the complete document
    filepath = os.path.join(out_dir, 'full-wiki.md')
    with open(filepath, 'w') as f:
        f.write(text)
    print(f'  Saved: {filepath} (complete)')

print()
print(f'Done! Wiki exported to {out_dir}/')
"

echo ""
echo "=== Export complete ==="
