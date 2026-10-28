import net from "node:net";

globalThis.__compiledRuntimeNetwork = { connect: 0, listen: 0 };
net.Socket.prototype.connect = function () {
  globalThis.__compiledRuntimeNetwork.connect += 1;
  throw new Error("Network is forbidden in the native import smoke");
};
net.Server.prototype.listen = function () {
  globalThis.__compiledRuntimeNetwork.listen += 1;
  throw new Error("Listening is forbidden in the native import smoke");
};
