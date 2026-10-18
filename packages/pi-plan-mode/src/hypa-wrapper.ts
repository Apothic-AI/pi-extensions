import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

/**
 * Admit the explicitly selected native runtime executable and the first Hypa
 * on PATH. Keep their lexical paths (including symlinks): these are the
 * spellings a rewriting hook puts in argv, not a basename permission.
 * This is ordinary trusted-program policy, not filesystem confinement.
 */
export async function resolveHypaExecutablePaths(
  cwd: string,
  searchPath: string | undefined = process.env.PATH,
  platform: NodeJS.Platform = process.platform,
  binaryOverride?: string,
): Promise<ReadonlySet<string>> {
  const paths = new Set<string>();
  if (
    !["aix", "android", "darwin", "freebsd", "linux", "netbsd", "openbsd", "sunos"].includes(platform) ||
    !isAbsolute(cwd)
  )
    return paths;
  // HYPA_BIN is the executable selected explicitly by the integration. Admit
  // its exact native POSIX spelling, not any similarly named path or launcher.
  const override = binaryOverride?.trim();
  if (override && isAbsolute(override) && basename(override) === "hypa") {
    try {
      if ((await stat(override)).isFile()) {
        await access(override, constants.X_OK);
        paths.add(override);
      }
    } catch {
      // A missing override grants no authority; PATH lookup stays independent.
    }
  }
  for (const directory of searchPath?.split(":") ?? []) {
    // Empty and relative PATH entries are relative to this session, not the
    // extension host's process cwd. Never invoke a shell or a launcher to look up Hypa.
    const candidate = resolve(cwd, directory, "hypa");
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      paths.add(candidate);
      break;
    } catch {
      // Missing, inaccessible, or non-executable entries do not win PATH lookup.
    }
  }
  return paths;
}
