// POSIX tests send real process signals. Windows has no catchable external
// SIGTERM, so this private IPC preload exercises the registered Node handlers.
if (typeof process.send === "function") {
  process.on("message", (message) => {
    if (message?.type === "network-test-signal" && ["SIGINT", "SIGTERM"].includes(message.signal)) {
      process.emit(message.signal);
    }
  });
}
