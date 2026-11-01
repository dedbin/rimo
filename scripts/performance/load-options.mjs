import { fail, positiveInteger } from "./common.mjs";

/** Parse bounded load options before accessing credentials or a target service. */
export function loadOptions(values) {
  const options = {
    seconds: positiveInteger(values.seconds, "seconds", 14_400),
    rooms: positiveInteger(values.rooms, "rooms", 20),
    connections: positiveInteger(values.connections, "connections", 50),
    editors: positiveInteger(values.editors, "editors", 50),
    objects: positiveInteger(values.objects, "objects", 3_000),
    editHz: positiveInteger(values["edit-hz"], "edit-hz", 20),
    presenceHz: positiveInteger(values["presence-hz"], "presence-hz", 30),
    batchSize: positiveInteger(values["batch-size"], "batch-size", 500),
    batchEverySeconds: positiveInteger(values["batch-every-seconds"], "batch-every-seconds", 3_600),
    sampleSeconds: positiveInteger(values["sample-seconds"], "sample-seconds", 60),
    composeProject: values["compose-project"],
  };
  if (options.editors < options.rooms || options.editors > options.connections || options.connections > options.rooms * 10) {
    throw fail("Use at least one editor per room, editors <=connections and no more than10 connections per room");
  }
  return options;
}
