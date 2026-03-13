#!/usr/bin/env python3
"""
Export DeepWiki content via the Devin MCP ask_question tool.

Since read_wiki_structure/read_wiki_contents return "not found" for private repos,
this uses ask_question which does work and has access to the full wiki context.

Usage:
    export DEVIN_API_KEY="your-key"
    python3 export-deepwiki-via-ask.py <owner/repo> <output-dir> [--pages-json <file>]

If --pages-json is not provided, the script first asks DeepWiki for the TOC,
writes it to <output-dir>/toc.json, then fetches each page.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

MCP_URL = "https://mcp.devin.ai/mcp"

API_KEY = os.environ.get("DEVIN_API_KEY")
if not API_KEY:
    print("ERROR: Set DEVIN_API_KEY environment variable", file=sys.stderr)
    sys.exit(1)


def mcp_ask(repo: str, question: str) -> str:
    """Call the ask_question MCP tool and return the text response."""
    payload = {
        "jsonrpc": "2.0",
        "id": "ask-1",
        "method": "tools/call",
        "params": {
            "name": "ask_question",
            "arguments": {
                "repoName": repo,
                "question": question,
            },
        },
    }

    result = subprocess.run(
        [
            "curl", "-sS", "-X", "POST", MCP_URL,
            "-H", "Content-Type: application/json",
            "-H", "Accept: application/json, text/event-stream",
            "-H", f"Authorization: Bearer {API_KEY}",
            "-d", json.dumps(payload),
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )

    for line in result.stdout.splitlines():
        if line.startswith("data: "):
            data = json.loads(line[6:])
            content = data.get("result", {}).get("content", [])
            if content:
                return content[0].get("text", "")
    return ""


def discover_toc(repo: str) -> list[dict]:
    """Ask DeepWiki for the full table of contents and parse it into a page list."""
    print("Discovering wiki table of contents...")
    question = (
        "List every page in this repository's wiki/documentation as a JSON array. "
        "For each page, include: "
        '{"path": "kebab-case/file-path", "title": "Page Title", "parent": "Parent Section or null"}. '
        "Use nested paths for pages under a section (e.g. 'system-architecture/overview'). "
        "Return ONLY the JSON array, no other text. Include every single page."
    )
    raw = mcp_ask(repo, question)

    # Extract JSON array from response (it may have markdown fencing)
    # Use bracket counting to find the correct array boundary
    start = raw.find('[')
    if start == -1:
        print(f"Could not parse TOC from response. Raw response:\n{raw[:1000]}", file=sys.stderr)
        sys.exit(1)

    depth = 0
    end = start
    for i in range(start, len(raw)):
        if raw[i] == '[':
            depth += 1
        elif raw[i] == ']':
            depth -= 1
            if depth == 0:
                end = i + 1
                break

    json_str = raw[start:end]

    try:
        pages = json.loads(json_str)
    except json.JSONDecodeError:
        # Try to fix common issues (trailing commas)
        cleaned = re.sub(r',\s*]', ']', json_str)
        cleaned = re.sub(r',\s*}', '}', cleaned)
        pages = json.loads(cleaned)

    print(f"  Found {len(pages)} pages")
    return pages


def fetch_page(repo: str, title: str, parent: str | None) -> str:
    """Fetch a single wiki page's content."""
    context = f" (under the '{parent}' section)" if parent else ""
    question = (
        f"Give me the complete, detailed documentation for the '{title}' "
        f"wiki page{context}. Include all sections, subsections, code examples, "
        f"file paths, configuration snippets, architecture details, and any "
        f"diagrams described in that page. Format the response as a well-structured "
        f"markdown document with proper headings. Be thorough and exhaustive - "
        f"include every detail from the wiki page."
    )
    return mcp_ask(repo, question)


def generate_index(pages: list[dict], repo: str, out_dir: Path):
    """Generate an index.md with links to all pages."""
    repo_name = repo.split("/")[-1]
    lines = [f"# {repo_name} Wiki\n\n", f"Exported from Devin DeepWiki for `{repo}`\n\n"]

    current_parent = None
    for page in pages:
        title = page["title"]
        path = page["path"]
        parent = page.get("parent")

        if parent and parent != current_parent:
            lines.append(f"\n## {parent}\n\n")
            current_parent = parent
        elif not parent and current_parent:
            current_parent = None
            lines.append("\n")

        prefix = "  " if parent else ""
        lines.append(f"{prefix}- [{title}]({path}.md)\n")

    (out_dir / "index.md").write_text("".join(lines), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Export DeepWiki via MCP ask_question")
    parser.add_argument("repo", help="GitHub repo in owner/repo format")
    parser.add_argument("output", help="Output directory for markdown files")
    parser.add_argument("--pages-json", help="Pre-built TOC JSON file (skip discovery)")
    parser.add_argument("--skip-existing", action="store_true", help="Skip pages that already exist on disk")
    args = parser.parse_args()

    repo = args.repo
    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Load or discover TOC
    if args.pages_json:
        pages = json.loads(Path(args.pages_json).read_text())
    else:
        pages = discover_toc(repo)
        toc_path = out_dir / "toc.json"
        toc_path.write_text(json.dumps(pages, indent=2), encoding="utf-8")
        print(f"  TOC saved to {toc_path}")

    total = len(pages)
    failed = []
    skipped = 0

    print(f"\nExporting {total} pages for {repo}")
    print(f"Output: {out_dir}/\n")

    for i, page in enumerate(pages):
        title = page["title"]
        path = page["path"]
        parent = page.get("parent")

        filepath = out_dir / f"{path}.md"
        filepath.parent.mkdir(parents=True, exist_ok=True)

        if args.skip_existing and filepath.exists() and filepath.stat().st_size > 100:
            print(f"[{i+1}/{total}] {title} — SKIP (exists)")
            skipped += 1
            continue

        context = f" (under {parent})" if parent else ""
        print(f"[{i+1}/{total}] {title}{context}...", end=" ", flush=True)

        try:
            content = fetch_page(repo, title, parent)
            if not content or len(content) < 50:
                print("EMPTY")
                failed.append((path, title, "empty response"))
                continue

            if not content.strip().startswith("# "):
                content = f"# {title}\n\n{content}"

            filepath.write_text(content + "\n", encoding="utf-8")
            print(f"OK ({len(content):,} chars)")

        except Exception as e:
            print(f"FAILED: {e}")
            failed.append((path, title, str(e)))

        if i < total - 1:
            time.sleep(1)

    # Generate index
    print("\nGenerating index...")
    generate_index(pages, repo, out_dir)

    exported = total - len(failed) - skipped
    print(f"\nDone! {exported} exported, {skipped} skipped, {len(failed)} failed — {out_dir}/")

    if failed:
        print(f"\nFailed pages ({len(failed)}):")
        for path, title, reason in failed:
            print(f"  - {title}: {reason}")


if __name__ == "__main__":
    main()
