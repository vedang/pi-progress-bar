import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

function manifest() {
  return JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
}

describe("Pi package scaffold", () => {
  it("loads the declared entry as an extension factory", async () => {
    const entry = await import("../src/index");
    expect(typeof entry.default).toBe("function");
  });

  it("declares the TypeScript extension and ships only runtime source", () => {
    const pkg = manifest();
    expect(pkg.name).toBe("pi-progress-bar");
    expect(pkg.type).toBe("module");
    expect(pkg.main).toBe("./src/index.ts");
    expect(pkg.pi.extensions).toEqual([pkg.main]);
    expect(pkg.files).toEqual(["src"]);
    expect(existsSync(new URL(pkg.main, root))).toBe(true);
    expect(pkg.keywords).toContain("pi-package");
  });

  it("uses pi-exa's Bun and Make gate conventions", () => {
    const pkg = manifest();
    expect(pkg.packageManager).toBe("bun@1.3.14");
    expect(pkg.engines.node).toBe(">=22.19.0");
    expect(pkg.scripts).toMatchObject({
      format: "make format",
      check: "make check",
      test: "make test",
    });
    expect(existsSync(new URL("bun.lock", root))).toBe(true);
    expect(existsSync(new URL("package-lock.json", root))).toBe(false);
  });

  it("uses host Pi peers without Exa or installer side effects", () => {
    const pkg = manifest();
    expect(pkg.peerDependencies["@earendil-works/pi-coding-agent"]).toBe("*");
    expect(pkg.devDependencies["@earendil-works/pi-coding-agent"]).toMatch(
      /^\d+\.\d+\.\d+$/,
    );
    expect(pkg.dependencies ?? {}).not.toHaveProperty("exa-js");
    for (const name of ["preinstall", "install", "postinstall", "prepare"]) {
      expect(pkg.scripts).not.toHaveProperty(name);
    }
  });
});
