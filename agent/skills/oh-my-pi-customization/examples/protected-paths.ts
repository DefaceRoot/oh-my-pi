import type { HookAPI } from "@oh-my-pi/pi-coding-agent/hooks";

/**
 * Protected Paths Hook
 * 
 * Blocks writes to sensitive files and directories.
 */
export default function (pi: HookAPI) {
  const protectedPaths = [
    ".env",
    ".env.local",
    ".env.production",
    ".git/",
    "node_modules/",
    "package-lock.json",
    "bun.lockb",
    "pnpm-lock.yaml",
    "yarn.lock",
  ];

  const protectedPatterns = [
    /\.pem$/,
    /\.key$/,
    /id_rsa/,
    /\.secret/,
  ];

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const path = event.input.path as string;
    
    // Check exact paths
    const blockedPath = protectedPaths.find(p => path.includes(p));
    if (blockedPath) {
      ctx.ui.notify(`Blocked write to protected path: ${blockedPath}`, "warning");
      return { block: true, reason: `Protected path: ${blockedPath}` };
    }

    // Check patterns
    const blockedPattern = protectedPatterns.find(p => p.test(path));
    if (blockedPattern) {
      ctx.ui.notify(`Blocked write to sensitive file: ${path}`, "warning");
      return { block: true, reason: `Sensitive file pattern: ${path}` };
    }
  });
}
