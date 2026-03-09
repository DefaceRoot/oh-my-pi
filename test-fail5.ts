async function foo() {
  let shouldLaunchLazygit = false;
  let closePrompt: (() => void) | null = null;
  try {
    throw new Error("import readline/promises failed");
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
