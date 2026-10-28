import { AuthMessageType } from "@hocuspocus/common";
import { IncomingMessage, MessageType } from "@hocuspocus/server";
import type { Hocuspocus } from "@hocuspocus/server";

import type { ReceiveGuard } from "./receive-guard";
import { CollaborationRejection } from "./types";
import type { CollaborationContext } from "./types";

export const AUTH_CONTROL_BYTES = 4 * 1024;
const DOCUMENT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type IngressClient = Pick<ReturnType<Hocuspocus<CollaborationContext>["handleConnection"]>, "handleMessage" | "handleClose">;

export function readIngressMessage(update: Uint8Array): {
  key: string; documentName: string; initialAuth: boolean; message: IncomingMessage;
} {
  const message = new IncomingMessage(update);
  const key = message.readVarString();
  const documentName = key.split("\0", 1)[0];
  return { key, documentName, initialAuth: message.readVarUint() === MessageType.Auth, message };
}

export function isIngressDocumentName(name: string): boolean {
  return DOCUMENT_NAME.test(name);
}

export function validateAuthControl(message: IncomingMessage, length: number): void {
  if (message.readVarUint() !== AuthMessageType.Token || message.readVarString() !== "cookie") {
    throw new CollaborationRejection("Authentication required");
  }
  if (message.decoder.pos < length) message.readVarString(); // Optional provider version.
  if (message.decoder.pos !== length) throw new CollaborationRejection("Invalid authentication frame");
}

export function installReceiveIngress(hocuspocus: Hocuspocus<CollaborationContext>, receive: ReceiveGuard): void {
  const handleConnection = hocuspocus.handleConnection.bind(hocuspocus);
  hocuspocus.handleConnection = (...parameters) => {
    const client = handleConnection(...parameters);
    // Server's crossws open handler calls this before installing its message listener.
    receive.watch(client, parameters[0], parameters[1]);
    return client;
  };
}
