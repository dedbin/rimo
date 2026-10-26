// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { assertFreshProject, assertFreshStorage } from "../scripts/backup-common.mjs";

function configuration() {
  return {
    volumes: {
      "postgres-data": { name: "fresh_postgres-data", driver: "local" },
      assets: { name: "fresh_assets", driver: "local" },
    },
    services: {
      db: { volumes: [{ type: "volume", source: "postgres-data", target: "/var/lib/postgresql" }] },
      app: { environment: { ASSET_STORAGE_PATH: "/app/data/assets" },
        volumes: [{ type: "volume", source: "assets", target: "/app/data/assets" }] },
    },
  };
}

describe("restore storage isolation", () => {
  it("accepts fresh local volumes and unrelated configuration mounts", () => {
    const config = configuration();
    config.services.app.volumes.push({ type: "bind", source: "./settings", target: "/app/settings" });
    expect(() => assertFreshStorage(config, "fresh")).not.toThrow();
    expect(config.services.app.volumes).toHaveLength(2);
  });

  it.each(["assets", "postgres-data"] as const)("rejects a fresh-looking %s volume backed by an existing host directory before Docker starts", async (name) => {
    const config = configuration();
    Object.assign(config.volumes[name], { driver_opts: { type: "none", o: "bind", device: "/existing-data" } });
    const run = vi.fn();
    await expect(assertFreshProject({ config, run }, "fresh")).rejects.toThrow("without driver options");
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["assets", "postgres-data"] as const)("rejects a non-local %s driver", (name) => {
    const config = configuration();
    config.volumes[name].driver = "nfs";
    expect(() => assertFreshStorage(config, "fresh")).toThrow("fresh local volumes");
  });

  it.each([
    ["app", "/app/data/assets/nested"], ["app", "/app/data"], ["app", "/"],
    ["app", "/app/data/assets"], ["app", "/app/data/assets/../assets/nested"],
    ["db", "/var/lib/postgresql/18/docker"], ["db", "/var/lib"],
  ] as const)("rejects an additional %s mount overlapping %s", (service, target) => {
    const config = configuration();
    config.services[service].volumes.push({ type: "bind", source: "/existing-data", target });
    expect(() => assertFreshStorage(config, "fresh")).toThrow("overlapping mounts");
  });

  it("rejects a duplicate data mount instead of treating it as the expected one", () => {
    const config = configuration();
    config.services.app.volumes.push({ ...config.services.app.volumes[0] });
    expect(() => assertFreshStorage(config, "fresh")).toThrow("one named project-scoped mount");
  });

  it.each(["app", "db"] as const)("rejects %s tmpfs and inherited mounts that hide the data destination", (service) => {
    const config = configuration();
    Object.assign(config.services[service], { tmpfs: ["/app/data"] });
    expect(() => assertFreshStorage(config, "fresh")).toThrow("inherited volumes or tmpfs");
    Object.assign(config.services[service], { tmpfs: [], volumes_from: ["existing-writer"] });
    expect(() => assertFreshStorage(config, "fresh")).toThrow("inherited volumes or tmpfs");
  });

  it("rejects a missing expected asset mount", () => {
    const config = configuration();
    config.services.app.volumes = [];
    expect(() => assertFreshStorage(config, "fresh")).toThrow("one named project-scoped mount");
  });

  it.each(["relative/assets", "/", "/app/data/../assets"])("rejects the ambiguous asset directory %s", (storage) => {
    const config = configuration();
    config.services.app.environment.ASSET_STORAGE_PATH = storage;
    expect(() => assertFreshStorage(config, "fresh")).toThrow("explicit absolute asset storage directory");
  });

  it("rejects external or unrelated named storage", () => {
    const config = configuration();
    Object.assign(config.volumes.assets, { external: true });
    expect(() => assertFreshStorage(config, "fresh")).toThrow("fresh local volumes");
    Object.assign(config.volumes.assets, { external: false, name: "production_assets" });
    expect(() => assertFreshStorage(config, "fresh")).toThrow("fresh local volumes");
  });

  it("rejects aliases that could share a data volume with another project or service", () => {
    const config = configuration();
    config.volumes.assets.name = "fresh_nested_assets";
    expect(() => assertFreshStorage(config, "fresh")).toThrow("fresh local volumes");
    config.volumes.assets.name = config.volumes["postgres-data"].name;
    expect(() => assertFreshStorage(config, "fresh")).toThrow("fresh local volumes");
  });

  it.each(["PGDATA", "POSTGRES_INITDB_WALDIR"])("rejects %s pointing outside the fresh database volume", async (key) => {
    const config = configuration();
    Object.assign(config.services.db, { environment: { [key]: "/existing-postgres" } });
    config.services.db.volumes.push({ type: "bind", source: "/existing-postgres", target: "/existing-postgres" });
    const run = vi.fn();
    await expect(assertFreshProject({ config, run }, "fresh")).rejects.toThrow("data and WAL directories inside");
    expect(run).not.toHaveBeenCalled();
  });

  it("accepts configured PostgreSQL data and WAL subdirectories on the fresh database volume", () => {
    const config = configuration();
    Object.assign(config.services.db, { environment: {
      PGDATA: "/var/lib/postgresql/18/docker", POSTGRES_INITDB_WALDIR: "/var/lib/postgresql/wal",
    } });
    expect(() => assertFreshStorage(config, "fresh")).not.toThrow();
  });

  it.each(["--waldir=/existing", "-X /existing"])("rejects initialization arguments that redirect the database WAL: %s", (args) => {
    const config = configuration();
    Object.assign(config.services.db, { environment: { POSTGRES_INITDB_ARGS: args } });
    expect(() => assertFreshStorage(config, "fresh")).toThrow("custom PostgreSQL initialization arguments");
  });
});
