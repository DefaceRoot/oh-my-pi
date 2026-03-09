const fs = require('fs');
const path = 'packages/coding-agent/src/modes/controllers/input-controller.ts';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
`				} catch (error) {
					this.ctx.showWarning(
						\`Failed to install lazygit: \${error instanceof Error ? error.message : String(error)}\`,
					);
					return;
				} finally {
					closePrompt?.();
					if (!shouldLaunchLazygit) {
						this.ctx.ui.start();
						this.ctx.ui.requestRender();
					}
				}`,
`				} catch (error) {
					closePrompt?.();
					closePrompt = null;
					if (!shouldLaunchLazygit) {
						this.ctx.ui.start();
						this.ctx.ui.requestRender();
					}
					this.ctx.showWarning(
						\`Failed to install lazygit: \${error instanceof Error ? error.message : String(error)}\`,
					);
					return;
				} finally {
					closePrompt?.();
					if (!shouldLaunchLazygit) {
						this.ctx.ui.start();
						this.ctx.ui.requestRender();
					}
				}`
);

fs.writeFileSync(path, code);
