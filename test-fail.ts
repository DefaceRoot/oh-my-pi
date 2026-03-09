async function foo() {
  let shouldLaunchLazygit = false;
  let closePrompt: (() => void) | null = null;
  try {
    const rl = { close: () => {} };
    closePrompt = () => rl.close();
    
    // Simulate rl.question throwing BEFORE we can answer
    throw new Error("prompt failed");
  } catch (error) {
    console.log("caught", error.message);
    return;
  } finally {
    closePrompt?.();
    if (!shouldLaunchLazygit) {
      console.log("restarting UI");
    }
  }
}

foo();
