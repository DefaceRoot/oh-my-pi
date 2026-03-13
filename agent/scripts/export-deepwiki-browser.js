/**
 * DeepWiki Browser Export
 *
 * Usage:
 *   1. Open your DeepWiki page in the browser while logged in:
 *      https://app.devin.ai/org/defaceroot-tutamail-com/wiki/DefaceRoot/CISEN-Dashboard?branch=main
 *   2. Open browser DevTools (F12 → Console)
 *   3. Paste this entire script and press Enter
 *   4. It will extract all wiki pages and download them as a .zip or individual .md files
 */
(async function exportDeepWiki() {
  'use strict';

  const REPO = 'DefaceRoot/CISEN-Dashboard';

  // Collect all sidebar navigation links (wiki pages)
  const navLinks = document.querySelectorAll('nav a[href*="/wiki/"], aside a[href*="/wiki/"]');
  const pageUrls = new Set();

  navLinks.forEach(link => {
    const href = link.getAttribute('href');
    if (href && href.includes('/wiki/')) {
      const fullUrl = href.startsWith('http') ? href : window.location.origin + href;
      pageUrls.add(fullUrl);
    }
  });

  console.log(`Found ${pageUrls.size} wiki page links in sidebar.`);

  if (pageUrls.size === 0) {
    // Fallback: just grab the current page content
    console.log('No sidebar links found. Extracting current page content...');
    pageUrls.add(window.location.href);
  }

  // Extract content from the current page's main content area
  function extractPageContent() {
    // Try common content selectors used by wiki-style pages
    const selectors = [
      'article',
      'main',
      '[class*="wiki-content"]',
      '[class*="content"]',
      '[class*="markdown"]',
      '[role="main"]',
      '.prose',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 100) {
        return {
          html: el.innerHTML,
          text: el.innerText,
        };
      }
    }

    // Last resort: grab body
    return {
      html: document.body.innerHTML,
      text: document.body.innerText,
    };
  }

  // Simple HTML-to-Markdown converter for common elements
  function htmlToMarkdown(html) {
    const div = document.createElement('div');
    div.innerHTML = html;

    // Remove scripts, styles, nav elements
    div.querySelectorAll('script, style, nav, header, footer').forEach(el => el.remove());

    let md = '';

    function processNode(node, depth = 0) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const tag = node.tagName.toLowerCase();
      const children = Array.from(node.childNodes).map(n => processNode(n, depth + 1)).join('');

      switch (tag) {
        case 'h1': return `\n# ${children.trim()}\n\n`;
        case 'h2': return `\n## ${children.trim()}\n\n`;
        case 'h3': return `\n### ${children.trim()}\n\n`;
        case 'h4': return `\n#### ${children.trim()}\n\n`;
        case 'h5': return `\n##### ${children.trim()}\n\n`;
        case 'h6': return `\n###### ${children.trim()}\n\n`;
        case 'p': return `\n${children.trim()}\n\n`;
        case 'br': return '\n';
        case 'strong':
        case 'b': return `**${children.trim()}**`;
        case 'em':
        case 'i': return `*${children.trim()}*`;
        case 'code':
          if (node.parentElement && node.parentElement.tagName.toLowerCase() === 'pre') {
            return children;
          }
          return `\`${children.trim()}\``;
        case 'pre': {
          const lang = node.querySelector('code')?.className?.match(/language-(\w+)/)?.[1] || '';
          return `\n\`\`\`${lang}\n${children.trim()}\n\`\`\`\n\n`;
        }
        case 'a': {
          const href = node.getAttribute('href') || '';
          return `[${children.trim()}](${href})`;
        }
        case 'img': {
          const src = node.getAttribute('src') || '';
          const alt = node.getAttribute('alt') || '';
          return `![${alt}](${src})`;
        }
        case 'ul':
        case 'ol': return `\n${children}\n`;
        case 'li': {
          const prefix = node.parentElement?.tagName.toLowerCase() === 'ol' ? '1.' : '-';
          return `${prefix} ${children.trim()}\n`;
        }
        case 'blockquote': return `\n> ${children.trim().replace(/\n/g, '\n> ')}\n\n`;
        case 'table': return `\n${children}\n`;
        case 'thead':
        case 'tbody': return children;
        case 'tr': {
          const cells = Array.from(node.children).map(td => processNode(td, depth + 1).trim());
          return `| ${cells.join(' | ')} |\n`;
        }
        case 'th':
        case 'td': return children;
        case 'hr': return '\n---\n\n';
        case 'div':
        case 'section':
        case 'span':
        default: return children;
      }
    }

    md = processNode(div);

    // Clean up excessive whitespace
    md = md.replace(/\n{3,}/g, '\n\n').trim();

    return md;
  }

  // Extract current page
  const content = extractPageContent();
  const markdown = htmlToMarkdown(content.html);

  // Get page title
  const title = document.querySelector('h1')?.innerText
    || document.title.replace(/\s*\|.*$/, '')
    || 'wiki-export';

  const filename = title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 60) + '.md';

  // Download as file
  function downloadFile(name, text) {
    const blob = new Blob([text], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  downloadFile(filename, markdown);
  console.log(`Downloaded: ${filename} (${markdown.length} chars)`);

  // Also copy to clipboard
  try {
    await navigator.clipboard.writeText(markdown);
    console.log('Content also copied to clipboard.');
  } catch (e) {
    console.log('Could not copy to clipboard (permissions).');
  }

  console.log('\nTo export ALL pages:');
  console.log('  Navigate to each page in the sidebar and re-run this script,');
  console.log('  or use the MCP-based export script (scripts/export-deepwiki.sh)');
  console.log('  which can batch-download all pages at once.');
})();
