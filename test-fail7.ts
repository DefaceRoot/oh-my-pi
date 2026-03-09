const ui = {
  start: () => console.log("start"),
  requestRender: () => console.log("requestRender")
}

async function foo() {
  let shouldLaunchLazygit = false;
  let closePrompt: (() => void) | null = null;
  try {
    const rl = { close: () => {} };
    closePrompt = () => rl.close();
    const answer = "n";
    if (answer === "n") {
      return;
    }
    shouldLaunchLazygit = true;
  } catch (error) {
  } finally {
    closePrompt?.();
    if (!shouldLaunchLazygit) {
      ui.start();
      ui.requestRender();
    }
  }
}
foo();
