# OpenComputer Changelog Agent

A scheduled OpenComputer agent that reviews one GitHub repository's last 48
hours of merged pull requests and default-branch commits, updates
`CHANGELOG.md`, and opens a pull request for human review.

[Create a repository from this template](https://github.com/new?template_name=opencomputer-example-changelog&template_owner=diggerhq),
then connect it to OpenComputer. The repository creation is one click; GitHub
and OpenComputer still require explicit repository access because the agent can
write a changelog branch.

## What it does

- runs every day at 09:00 America/Los_Angeles with a 48-hour evidence window;
- links every changelog claim to a merged pull request or commit;
- writes only the configured Markdown changelog file;
- opens a normal pull request from the exact commit it analyzed; and
- reuses retries and blocks a second automation PR while one remains open.

It does not check out or execute repository code, write directly to the default
branch, merge or approve pull requests, publish releases, or edit any other
file.

## Prerequisites

- Node.js 22 or newer
- an OpenComputer account
- a GitHub repository with a changelog (or permission to create one)
- a fine-grained GitHub token limited to that repository with:
  - **Contents:** read and write
  - **Pull requests:** read and write

## Set up Development

Install and link the project:

```bash
npm install
npx opencomputer login
npx opencomputer link
```

Create the initial Development deployment. OpenComputer currently requires an
active agent deployment before it accepts that agent's runtime variables or
managed secrets:

```bash
npm run deploy -- --alias development
```

Configure the only repository the tools can access. This is ordinary runtime
configuration, not a credential:

```bash
printf '%s\n' 'your-org/your-repository' | \
  npx opencomputer env set OPENCOMPUTER_REPOSITORY \
    --environment development --agent current
```

The default file is `CHANGELOG.md`. To use another repository-relative
Markdown path, configure it explicitly:

```bash
printf '%s\n' 'docs/CHANGELOG.md' | \
  npx opencomputer env set OPENCOMPUTER_CHANGELOG_PATH \
    --environment development --agent current
```

Store the GitHub token as a managed secret. The value is attached only to the
declared `https://api.github.com/repos/` connections:

```bash
npx opencomputer secrets set GITHUB_TOKEN \
  --environment development --agent current
```

Start the development watcher:

```bash
npm run dev
```

Development schedules do not recur automatically. In the OpenComputer
playground, open **Schedules** and use **Run now** for `daily-changelog`.

## Verify safely

First run the local checks:

```bash
npm test
npm run typecheck
```

Use a fixture repository with at least one merged, user-visible change in the
last 48 hours. A safe first run should:

1. create one `opencomputer/changelog-<base-sha>` branch;
2. modify only the configured changelog path;
3. create one pull request whose bullets link to GitHub evidence; and
4. leave the default branch and releases unchanged.

Run the same schedule again before merging. It should return the existing pull
request without another branch or commit. Also test an empty 48-hour window;
the agent should report that no update is needed and perform no write.

## Deploy to Production

Repeat the repository configuration and secret setup for Production, then
deploy explicitly:

```bash
printf '%s\n' 'your-org/your-repository' | \
  npx opencomputer env set OPENCOMPUTER_REPOSITORY \
    --environment production --agent current

npx opencomputer secrets set GITHUB_TOKEN \
  --environment production --agent current

npm run deploy -- --alias production
```

Production begins recurring runs at the next schedule occurrence. The schedule
is code-owned in
`opencomputer/agents/changelog/schedules/daily-changelog.ts`; edit and redeploy it to
change cadence, timezone, or lookback.

## Security model

Repository coordinates and the changelog path come from environment-scoped
runtime configuration, not prompts or schedule payloads. GitHub text is
untrusted evidence. The publisher rechecks the current default-branch SHA,
prepends one bounded H2 section mechanically, and fails closed if its
deterministic branch contains unexpected content.

Use a dedicated fine-grained token for this example and select only the target
repository. Never commit the token or place it in a runtime variable.
