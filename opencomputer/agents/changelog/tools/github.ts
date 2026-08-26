import {
  bearer,
  defineConnection,
  defineTool,
  useSecret,
} from "@opencomputer/agent";
import {
  branchName,
  changelogMarker,
  changelogPath,
  configuredRepository,
  encodedPath,
  evidenceWindow,
  fullSha,
  insertEntry,
  validateEntry,
} from "../changelog.js";

const githubRead = defineConnection({
  id: "github-changelog-read",
  origin: "https://api.github.com",
  methods: ["GET"],
  pathPrefix: "/repos/",
  headers: {
    Accept: "application/vnd.github+json",
    Authorization: bearer(useSecret("GITHUB_TOKEN")),
    "User-Agent": "opencomputer-example-changelog",
    "X-GitHub-Api-Version": "2022-11-28",
  },
});

const githubWrite = defineConnection({
  id: "github-changelog-write",
  origin: "https://api.github.com",
  methods: ["GET", "POST", "PUT"],
  pathPrefix: "/repos/",
  headers: {
    Accept: "application/vnd.github+json",
    Authorization: bearer(useSecret("GITHUB_TOKEN")),
    "User-Agent": "opencomputer-example-changelog",
    "X-GitHub-Api-Version": "2022-11-28",
  },
});

type Repository = {
  default_branch: string;
  html_url: string;
  full_name: string;
  owner: { login: string };
};

type Commit = {
  sha: string;
  html_url: string;
  author: { login: string } | null;
  commit: {
    message: string;
    author: { name: string; date: string } | null;
    committer: { name: string; date: string } | null;
  };
};

type PullRequest = {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: string;
  merged_at: string | null;
  updated_at: string;
  merge_commit_sha: string | null;
  user: { login: string };
  labels: Array<{ name: string }>;
  head: { ref: string };
};

type GitRef = { ref: string; object: { sha: string; type: string } };

type GitCompare = {
  status: string;
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  files?: Array<{ filename: string; status: string }>;
};

type ContentFile = {
  type: "file";
  path: string;
  sha: string;
  content: string;
  encoding: "base64";
  html_url: string | null;
};

function repositoryPath(): { fullName: string; owner: string; encoded: string } {
  const fullName = configuredRepository();
  const [owner, repo] = fullName.split("/");
  return {
    fullName,
    owner,
    encoded: `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  };
}

async function checked(
  connection: typeof githubRead | typeof githubWrite,
  path: string,
  init: RequestInit = {},
  allowedStatuses: number[] = [],
): Promise<Response> {
  const response = await connection.fetch(path, init);
  if (!response.ok && !allowedStatuses.includes(response.status)) {
    const detail = (await response.text()).slice(0, 2_000);
    throw new Error(`GitHub API ${response.status}: ${detail}`);
  }
  return response;
}

async function json<T>(
  connection: typeof githubRead | typeof githubWrite,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return (await checked(connection, path, init)).json() as Promise<T>;
}

function branchRefPath(repository: string, branch: string): string {
  const encodedBranch = branch.split("/").map(encodeURIComponent).join("/");
  return `/repos/${repository}/git/ref/heads/${encodedBranch}`;
}

async function readContent(
  connection: typeof githubRead | typeof githubWrite,
  repository: string,
  path: string,
  ref: string,
): Promise<{ content?: string; sha?: string; url?: string }> {
  const response = await checked(
    connection,
    `/repos/${repository}/contents/${encodedPath(path)}?ref=${encodeURIComponent(ref)}`,
    {},
    [404],
  );
  if (response.status === 404) return {};
  const file = (await response.json()) as ContentFile;
  if (file.type !== "file" || file.encoding !== "base64") {
    throw new Error("Configured changelog path is not a base64-encoded file");
  }
  const content = Buffer.from(file.content.replace(/\s/g, ""), "base64").toString(
    "utf8",
  );
  if (content.length > 200_000) {
    throw new Error("Configured changelog exceeds the 200,000 character limit");
  }
  return { content, sha: file.sha, ...(file.html_url ? { url: file.html_url } : {}) };
}

async function openAutomationPullRequests(
  repository: string,
): Promise<PullRequest[]> {
  const pulls = await json<PullRequest[]>(
    githubWrite,
    `/repos/${repository}/pulls?state=open&per_page=100&sort=updated&direction=desc`,
  );
  return pulls.filter(
    (pull) =>
      pull.head.ref.startsWith("opencomputer/changelog-") &&
      pull.body?.includes("<!-- opencomputer-changelog-agent -->") === true,
  );
}

export const collectRecentChanges = defineTool({
  name: "github_collect_recent_changes",
  description:
    "Collect bounded default-branch commits and merged pull requests from the configured repository for one changelog evidence window.",
  input: {
    type: "object",
    properties: {
      windowEnd: { type: "string", minLength: 1 },
      lookbackHours: { type: "integer", minimum: 1, maximum: 72 },
    },
    required: ["windowEnd", "lookbackHours"],
    additionalProperties: false,
  },
  async run({ input, signal }) {
    const target = repositoryPath();
    const window = evidenceWindow(input.windowEnd, input.lookbackHours);
    const repository = await json<Repository>(
      githubRead,
      `/repos/${target.encoded}`,
      { signal },
    );
    const ref = await json<GitRef>(
      githubRead,
      branchRefPath(target.encoded, repository.default_branch),
      { signal },
    );
    const baseSha = fullSha(ref.object.sha);

    const commits: Commit[] = [];
    let commitsTruncated = false;
    for (let page = 1; page <= 5; page += 1) {
      const batch = await json<Commit[]>(
        githubRead,
        `/repos/${target.encoded}/commits?sha=${encodeURIComponent(repository.default_branch)}&since=${encodeURIComponent(window.start)}&until=${encodeURIComponent(window.end)}&per_page=100&page=${page}`,
        { signal },
      );
      commits.push(...batch);
      if (batch.length < 100) break;
      if (page === 5) commitsTruncated = true;
    }

    const mergedPullRequests: PullRequest[] = [];
    let pullsTruncated = false;
    for (let page = 1; page <= 5; page += 1) {
      const batch = await json<PullRequest[]>(
        githubRead,
        `/repos/${target.encoded}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`,
        { signal },
      );
      for (const pull of batch) {
        if (
          pull.merged_at &&
          pull.merged_at >= window.start &&
          pull.merged_at <= window.end
        ) {
          mergedPullRequests.push(pull);
        }
      }
      const oldest = batch.at(-1)?.updated_at;
      if (batch.length < 100 || (oldest && oldest < window.start)) break;
      if (page === 5) pullsTruncated = true;
    }

    return {
      repository: repository.full_name,
      repositoryUrl: repository.html_url,
      defaultBranch: repository.default_branch,
      baseSha,
      window,
      truncated: commitsTruncated || pullsTruncated,
      commits: commits.map((commit) => ({
        sha: commit.sha,
        url: commit.html_url,
        message: commit.commit.message.slice(0, 4_000),
        author: commit.author?.login ?? commit.commit.author?.name ?? "unknown",
        committedAt:
          commit.commit.committer?.date ?? commit.commit.author?.date ?? null,
      })),
      mergedPullRequests: mergedPullRequests.map((pull) => ({
        number: pull.number,
        url: pull.html_url,
        title: pull.title,
        body: pull.body?.slice(0, 4_000) ?? null,
        author: pull.user.login,
        labels: pull.labels.map((label) => label.name),
        mergedAt: pull.merged_at,
        mergeCommitSha: pull.merge_commit_sha,
      })),
    };
  },
});

export const readChangelog = defineTool({
  name: "github_read_changelog",
  description:
    "Read only the configured changelog file at the exact analyzed Git commit.",
  input: {
    type: "object",
    properties: {
      ref: { type: "string", pattern: "^[0-9a-fA-F]{40}$" },
    },
    required: ["ref"],
    additionalProperties: false,
  },
  async run({ input }) {
    const target = repositoryPath();
    const ref = fullSha(input.ref);
    const path = changelogPath();
    const file = await readContent(githubRead, target.encoded, path, ref);
    return { path, ref, exists: file.content !== undefined, ...file };
  },
});

export const publishChangelogPullRequest = defineTool({
  name: "github_publish_changelog_pull_request",
  description:
    "Prepend one bounded section to the configured changelog on a deterministic branch and open one pull request, after rechecking the exact analyzed base SHA.",
  input: {
    type: "object",
    properties: {
      expectedBaseSha: { type: "string", pattern: "^[0-9a-fA-F]{40}$" },
      entry: { type: "string", minLength: 1, maxLength: 15_000 },
      title: { type: "string", minLength: 1, maxLength: 120 },
      body: { type: "string", minLength: 1, maxLength: 10_000 },
    },
    required: ["expectedBaseSha", "entry", "title", "body"],
    additionalProperties: false,
  },
  async run({ input, signal }) {
    const target = repositoryPath();
    const expectedBaseSha = fullSha(input.expectedBaseSha);
    const entry = validateEntry(input.entry);
    const title = String(input.title).trim();
    const body = String(input.body).trim();
    if (!title || title.length > 120) throw new Error("title must contain 1 to 120 characters");
    if (!body || body.length > 10_000) throw new Error("body must contain 1 to 10,000 characters");

    const existingAutomation = await openAutomationPullRequests(target.encoded);
    if (existingAutomation.length) {
      const existing = existingAutomation[0];
      return {
        status: "existing_open_pull_request",
        branch: existing.head.ref,
        path: changelogPath(),
        pullRequestNumber: existing.number,
        pullRequestUrl: existing.html_url,
        message: "Review or merge the existing changelog pull request before starting another.",
      };
    }

    const repository = await json<Repository>(
      githubWrite,
      `/repos/${target.encoded}`,
      { signal },
    );
    const defaultRef = await json<GitRef>(
      githubWrite,
      branchRefPath(target.encoded, repository.default_branch),
      { signal },
    );
    const currentBaseSha = fullSha(defaultRef.object.sha);
    if (currentBaseSha !== expectedBaseSha) {
      throw new Error(
        `Default branch changed from analyzed ${expectedBaseSha} to ${currentBaseSha}; collect fresh evidence`,
      );
    }

    const path = changelogPath();
    const baseFile = await readContent(
      githubWrite,
      target.encoded,
      path,
      expectedBaseSha,
    );
    const next = insertEntry(baseFile.content, entry, expectedBaseSha);
    if (next.duplicate) {
      return {
        status: "already_present",
        branch: null,
        path,
        pullRequestNumber: null,
        pullRequestUrl: null,
        message: "The changelog already contains the marker for this analyzed base.",
      };
    }

    const branch = branchName(expectedBaseSha);
    const refPath = branchRefPath(target.encoded, branch);
    const createRef = await checked(
      githubWrite,
      `/repos/${target.encoded}/git/refs`,
      {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: expectedBaseSha }),
      },
      [422],
    );

    let branchContainsEntry = false;
    if (createRef.status === 422) {
      const branchRef = await json<GitRef>(githubWrite, refPath, { signal });
      if (branchRef.object.sha !== expectedBaseSha) {
        const branchFile = await readContent(
          githubWrite,
          target.encoded,
          path,
          branch,
        );
        const comparison = await json<GitCompare>(
          githubWrite,
          `/repos/${target.encoded}/compare/${expectedBaseSha}...${encodeURIComponent(branch)}`,
          { signal },
        );
        const changedFiles = comparison.files ?? [];
        branchContainsEntry =
          branchFile.content?.includes(changelogMarker(expectedBaseSha)) === true &&
          comparison.status === "ahead" &&
          comparison.ahead_by === 1 &&
          comparison.behind_by === 0 &&
          comparison.total_commits === 1 &&
          changedFiles.length === 1 &&
          changedFiles[0].filename === path &&
          ["added", "modified"].includes(changedFiles[0].status);
        if (!branchContainsEntry) {
          throw new Error(
            `Deterministic branch ${branch} is occupied by unexpected content; review it manually`,
          );
        }
      }
    }

    if (!branchContainsEntry) {
      await json(
        githubWrite,
        `/repos/${target.encoded}/contents/${encodedPath(path)}`,
        {
          method: "PUT",
          signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: `docs: update changelog through ${expectedBaseSha.slice(0, 12)}`,
            content: Buffer.from(next.content, "utf8").toString("base64"),
            branch,
            ...(baseFile.sha ? { sha: baseFile.sha } : {}),
          }),
        },
      );
    }

    const pullBody = `${body}\n\n<!-- opencomputer-changelog-agent -->\n${changelogMarker(expectedBaseSha)}`;
    const createPull = await checked(
      githubWrite,
      `/repos/${target.encoded}/pulls`,
      {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          body: pullBody,
          head: branch,
          base: repository.default_branch,
        }),
      },
      [403, 422],
    );
    if (createPull.status === 403) {
      const detail = (await createPull.text()).slice(0, 2_000);
      throw new Error(
        `GitHub API 403 while creating the pull request. Branch ${branch} already contains the changelog-only commit and is safe to retry after granting Pull requests: write. ${detail}`,
      );
    }
    if (createPull.status === 422) {
      const existing = await json<PullRequest[]>(
        githubWrite,
        `/repos/${target.encoded}/pulls?state=open&head=${encodeURIComponent(`${target.owner}:${branch}`)}&per_page=10`,
        { signal },
      );
      if (!existing.length) {
        const detail = (await createPull.text()).slice(0, 2_000);
        throw new Error(`GitHub could not create or recover the pull request: ${detail}`);
      }
      return {
        status: "existing_pull_request",
        branch,
        path,
        pullRequestNumber: existing[0].number,
        pullRequestUrl: existing[0].html_url,
        message: "Recovered the existing pull request for the deterministic branch.",
      };
    }
    const pull = (await createPull.json()) as PullRequest;
    return {
      status: "created",
      branch,
      path,
      pullRequestNumber: pull.number,
      pullRequestUrl: pull.html_url,
      message: "Created a changelog pull request for human review.",
    };
  },
});
