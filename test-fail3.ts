async function foo() {
  let shouldLaunchLazygit = false;
  let closePrompt: (() => void) | null = null;
  try {
    throw new Error("import readline failed");
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
