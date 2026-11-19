/** @file Match repository-relative paths against devflow's supported glob syntax. */

/**
 * Minimal glob → RegExp for project-relative POSIX paths.
 * `**` matches any number of path segments (including none), `*` anything except `/`, `?` one non-`/` char.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  const g = glob.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        const atSegmentEnd = g[i + 2] === "/";
        re += atSegmentEnd ? "(?:.*/)?" : ".*";
        i += atSegmentEnd ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`, process.platform === "win32" ? "i" : "");
}

/** Test a path against each permitted pattern until one matches. */
export function matchesAny(path: string, globs: readonly string[]): boolean {
  const p = path.replace(/\\/g, "/");
  return globs.some((g) => globToRegExp(g).test(p));
}
