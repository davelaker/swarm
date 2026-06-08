// Singleton pause/resume/abort signals for the running loop.
// The loop polls these between task dispatches — not mid-task.
// Abort sets the flag and optionally kills the active subprocess;
// the loop exits cleanly at the next checkpoint.

let _paused  = false;
let _aborted = false;

export function pauseRun():    void { _paused  = true;  }
export function resumeRun():   void { _paused  = false; }
export function abortRun():    void { _aborted = true;  }
export function resetControl(): void { _paused = false; _aborted = false; }
export function isPaused():  boolean { return _paused;  }
export function isAborted(): boolean { return _aborted; }
