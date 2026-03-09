async function foo() {
  let shouldLaunchLazygit = false;
  let closePrompt: (() => void) | null = null;
  try {
    const rl = { close: () => {} };
    closePrompt = () => rl.close();
    
    // Simulate rl.question answering n
    const answer = "n";
    if (answer.trim().toLowerCase() !== "y" && answer.trim() !== "") {
      return;
    }
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
