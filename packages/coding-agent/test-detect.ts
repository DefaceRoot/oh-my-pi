export function detectLazygitInstallCommand(): { command: string; args: string[] } | null {
	if (process.platform === "win32") return null;
	const isRoot = process.getuid && process.getuid() === 0;

	if (Bun.which("brew")) return { command: "brew", args: ["install", "lazygit"] };

	const managers = [
		{ name: "apt", args: ["install", "-y", "lazygit"] },
		{ name: "dnf", args: ["install", "-y", "lazygit"] },
		{ name: "pacman", args: ["-S", "--noconfirm", "lazygit"] },
		{ name: "apk", args: ["add", "lazygit"] },
	];

	for (const manager of managers) {
		if (Bun.which(manager.name)) {
			if (isRoot) return { command: manager.name, args: manager.args };
			if (Bun.which("sudo")) return { command: "sudo", args: [manager.name, ...manager.args] };
			return null;
		}
	}
	return null;
}
