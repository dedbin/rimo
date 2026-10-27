import { MessageType, type HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { createDecoder, hasContent, readVarString, readVarUint, readVarUint8Array } from "lib0/decoding";
import { messageYjsUpdate } from "y-protocols/sync";

const configuredTransports = new WeakSet<HocuspocusProviderWebsocket>();

function isDocumentUpdate(message: unknown): boolean {
  if (!(message instanceof Uint8Array)) return false;
  try {
    const decoder = createDecoder(message);
    readVarString(decoder);
    if (readVarUint(decoder) !== MessageType.Sync || readVarUint(decoder) !== messageYjsUpdate) return false;
    readVarUint8Array(decoder);
    return !hasContent(decoder);
  } catch {
    return false;
  }
}

/** Reconcile offline document changes through the SDK's state-vector handshake. */
export function configureOfflineSync(transport: HocuspocusProviderWebsocket): void {
  if (configuredTransports.has(transport)) return;
  const send = transport.send;
  transport.send = function (this: HocuspocusProviderWebsocket, message: unknown): void {
    // Y.Doc retains these updates. Queuing them would replay the same content
    // before the reconnect handshake sends the missing document state again.
    // Always pass OPEN traffic, including edits made before onSynced fires.
    if (this.webSocket?.readyState !== 1 && isDocumentUpdate(message)) return;
    return send.call(this, message);
  };
  configuredTransports.add(transport);
}
