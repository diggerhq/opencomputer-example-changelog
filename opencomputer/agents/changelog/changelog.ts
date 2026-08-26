const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MARKER_PATTERN = /<!--\s*opencomputer-changelog:[^>]*-->/i;

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function repositoryName(value: unknown): string {
  const repository = nonEmptyString(value, "repository");
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error("repository must use owner/repository form");
  }
  return repository.toLowerCase();
}

export function configuredRepository(
  value = process.env.OPENCOMPUTER_REPOSITORY,
): string {
  if (!value) {
    throw new Error("OPENCOMPUTER_REPOSITORY is not configured");
  }
  return repositoryName(value);
}

export function changelogPath(
  value = process.env.OPENCOMPUTER_CHANGELOG_PATH ?? "CHANGELOG.md",
): string {
  const path = nonEmptyString(value, "changelog path").replace(/^\/+/, "");
  const segments = path.split("/");
  if (
    segments.some(
      (segment) =>
        !segment || segment === "." || segment === ".." || segment.includes("\\"),
    ) ||
    !/\.md$/i.test(path)
  ) {
    throw new Error("changelog path must be a repository-relative Markdown file");
  }
  return path;
}

export function encodedPath(path: string): string {
  return changelogPath(path).split("/").map(encodeURIComponent).join("/");
}

export function fullSha(value: unknown): string {
  const sha = nonEmptyString(value, "base SHA").toLowerCase();
  if (!SHA_PATTERN.test(sha)) {
    throw new Error("base SHA must be a full Git commit SHA");
  }
  return sha;
}

export function evidenceWindow(
  endValue: unknown,
  lookbackValue: unknown,
): { start: string; end: string; lookbackHours: number } {
  const endText = nonEmptyString(endValue, "window end");
  const end = new Date(endText);
  if (!Number.isFinite(end.getTime())) {
    throw new Error("window end must be an ISO-8601 timestamp");
  }
  const lookbackHours = Number(lookbackValue);
  if (!Number.isInteger(lookbackHours) || lookbackHours < 1 || lookbackHours > 72) {
    throw new Error("lookbackHours must be an integer from 1 to 72");
  }
  return {
    start: new Date(end.getTime() - lookbackHours * 60 * 60 * 1_000).toISOString(),
    end: end.toISOString(),
    lookbackHours,
  };
}

export function changelogMarker(baseSha: unknown): string {
  return `<!-- opencomputer-changelog:${fullSha(baseSha)} -->`;
}

export function branchName(baseSha: unknown): string {
  return `opencomputer/changelog-${fullSha(baseSha).slice(0, 12)}`;
}

export function validateEntry(value: unknown): string {
  const entry = nonEmptyString(value, "entry");
  if (!entry.startsWith("## ")) {
    throw new Error("entry must begin with an H2 Markdown heading");
  }
  if (entry.length > 15_000) {
    throw new Error("entry exceeds the 15,000 character limit");
  }
  if (MARKER_PATTERN.test(entry)) {
    throw new Error("entry must not contain OpenComputer idempotency markers");
  }
  return entry;
}

export function insertEntry(
  currentContent: string | undefined,
  entryValue: unknown,
  baseSha: unknown,
): { content: string; duplicate: boolean } {
  const entry = validateEntry(entryValue);
  const marker = changelogMarker(baseSha);
  const current = currentContent ?? "";
  if (current.includes(marker)) {
    return { content: current, duplicate: true };
  }
  const section = `${entry}\n\n${marker}`;
  if (!current.trim()) {
    return { content: `# Changelog\n\n${section}\n`, duplicate: false };
  }
  const heading = current.match(/^# Changelog\s*\r?\n/i);
  if (heading) {
    const rest = current.slice(heading[0].length).replace(/^\s*/, "");
    return {
      content: `${heading[0].trimEnd()}\n\n${section}\n\n${rest}`.trimEnd() + "\n",
      duplicate: false,
    };
  }
  return {
    content: `# Changelog\n\n${section}\n\n${current.trimStart()}`.trimEnd() + "\n",
    duplicate: false,
  };
}
