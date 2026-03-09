async function foo() {
  let shouldLaunchLazygit = false;
  try {
    const answer = "n";
    if (answer === "n") return;
  } catch (e) {
  } finally {
    console.log("finally");
  }
}
foo();
