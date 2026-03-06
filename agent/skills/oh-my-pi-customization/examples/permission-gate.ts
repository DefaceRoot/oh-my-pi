import type { HookAPI } from "@oh-my-pi/pi-coding-agent/hooks";

/**
 * Permission Gate Hook
 * 
 * Prompts for confirmation before dangerous bash commands.
 */
export default function (pi: HookAPI) {
  const dangerous = [
    /\brm\s+(-rf?|--recursive)/i,
    /\bsudo\b/i,
    /\bchmod\s+777\b/i,
    />\s*\/dev\/sd[a-z]/i,
    /\bmkfs\b/i,
    /\bdd\s+if=/i,
  ];

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const cmd = event.input.command as string;
    const match = dangerous.find(p => p.test(cmd));
    
    if (match) {
      if (!ctx.hasUI) {
        return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
      }
      
      const ok = await ctx.ui.confirm(
        "⚠️ Dangerous Command",
        `Allow: ${cmd.slice(0, 100)}${cmd.length > 100 ? '...' : ''}`
      );
      
      if (!ok) {
        return { block: true, reason: "Blocked by user" };
      }
    }
  });
}
