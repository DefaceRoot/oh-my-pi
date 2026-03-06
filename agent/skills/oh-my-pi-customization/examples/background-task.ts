/**
 * Background task example — with pi.exec pitfall warning
 *
 * Shows how to run work after the handler returns.
 *
 * IMPORTANT: pi.exec() has broken stdout capture in background contexts.
 * Use Bun.spawn directly for commands that run after before_agent_start returns.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function backgroundExample(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		if (!event.prompt?.includes("/deploy")) return;

		// Start in background (no await) — handler returns immediately
		void runDeploy(pi, ctx);

		return {
			message: {
				customType: "deploy/pending",
				content: "Deployment started in background...",
				display: true,
			},
		};
	});
}

async function runDeploy(pi: ExtensionAPI, ctx: { ui: any }) {
	ctx.ui.setStatus("deploy", "deploying...");

	try {
		// WARNING: Do NOT use pi.exec here — stdout will be empty.
		// Use Bun.spawn instead:
		const proc = Bun.spawn(["bash", "-lc", "npm run build && npm run deploy"], {
			cwd: process.cwd(),
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env },
		});

		const stdout = await new Response(proc.stdout).text();
		const code = await proc.exited;

		ctx.ui.setStatus("deploy", undefined);

		if (code !== 0) {
			ctx.ui.notify("Deploy failed", "error");
			pi.sendMessage({
				customType: "deploy/error",
				content: `Deploy failed (code ${code})`,
				display: true,
			});
		} else {
			ctx.ui.notify("Deploy complete", "info");
			pi.sendMessage(
				{ customType: "deploy/done", content: `Deployed successfully.\n${stdout.slice(-200)}`, display: true },
				{ deliverAs: "steer" },
			);
		}
	} catch (err) {
		ctx.ui.setStatus("deploy", undefined);
		ctx.ui.notify(`Deploy error: ${err}`, "error");
	}
}
