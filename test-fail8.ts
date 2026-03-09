class Foo {
  constructor() {
    this.uiStarted = false;
  }
  showWarning(msg: string) {
    console.log("warning:", msg, "ui started:", this.uiStarted);
  }
  async test() {
    this.uiStarted = false;
    let shouldLaunch = false;
    try {
      throw new Error("fail");
    } catch (e) {
      this.showWarning(e.message);
      return;
    } finally {
      this.uiStarted = true;
      console.log("finally ui started");
    }
  }
}
new Foo().test();
