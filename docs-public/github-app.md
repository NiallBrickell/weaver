# GitHub access on a hosted runner

A hosted Weaver runner should never carry a person's `gh auth login` session or
personal access token. Use a dedicated private GitHub App across the fleet's
intended repository estate, and keep its App private key in Weaver's
executor-only store on the trusted controller host.

GitHub App credentials are a minting identity, not the credential used for an
operation. Weaver signs a ten-minute App JWT only when it needs one, then asks
GitHub for an installation token that expires after one hour. Repo operations
further narrow that token to the one repository named by the assignment.

## Create and install the App

Run setup on the trusted local controller, where `gh auth status` identifies an
organization owner:

```bash
weaver github-app-setup your-organization
```

Open the printed loopback URL and confirm the GitHub screens. Choose **All
repositories** for an organization-wide fleet. GitHub returns the one-time App
private key, App ID, and installation ID directly to the loopback callback;
Weaver verifies them and writes them to its executor-only store. Do not copy,
download, or paste any credential. The local person's `gh` token is used only
to exchange the one-time manifest code on this controller and is never written
to Weaver state or sent to the hosted runner.

The command creates a private organization-owned App with no active webhook or
event subscriptions and exactly these repository permissions:

- Contents: write
- Pull requests: write
- Issues: write
- Checks: read
- Actions: read
- Commit statuses: read
- Metadata: read (GitHub adds this permission)

Existing and future repositories can then enter Workstreams without an App
settings change. Installation defines the fleet's maximum repository estate;
it never grants an individual run access across that estate. Every operation
still mints a token for the one exact owner/repository resolved from the
assignment checkout, and Weaver rejects the token unless GitHub confirms that
exact repository.

Contents write is what permits a reviewed branch push. There is deliberately
no Workflows permission, and no token Weaver mints ever asks for one. With it, a
pushed branch that adds a file under `.github/workflows` would run `on: push`
with the repository's Actions secrets before anyone reviewed or merged it.
Without it, GitHub refuses any fleet push that touches a workflow file; Weaver
records that as a known refusal with no effect and asks a person to push or
merge the change, and never retries it. An App created before this change may
still hold Workflows write on its installation; the tokens Weaver mints do not
request it, so the installation grant is unused, and you can remove it in the
App's settings.

A write token also does not decide *whether* a push or merge may happen. The
engine checks every repo egress against the paths it changes and the origin of
the workstream first; see [which code changes always need a person](./actions.md#which-code-changes-always-need-a-person).

The setup callback independently checks the returned organization,
all-repositories selection, permission map, App JWT, installation token, and
repository-list access before storing anything. `github-auth-check` can repeat
the installed identity probe later; neither command prints a token, key,
repository name, or API body.

Bootstrap each selected repository with the App identity rather than a personal
login:

```bash
weaver github-clone owner/repository /absolute/workspace/path
```

The command requests a read-only token for that exact repository, supplies it
to Git only through a temporary askpass child environment, and removes the
askpass file afterward. The checkout keeps a clean HTTPS origin: no credential
is written into its URL, Git configuration, credential store, or command line.

## Runtime boundary

- Ordinary workers — the OpenHands container, the containerized Claude
  worker, and the in-process executors — never receive the App private key.
  By default they receive no installation token either: they work from the
  controller's mounted checkout and cannot reach GitHub's API with the App's
  identity. One exception exists. When a work assignment asks for
  `github_read` (the coordinator sets it when the worker needs GitHub facts
  such as PR state, review threads, check runs, or issue lists) and the runner
  allows it, the controller mints a token for that one attempt through the
  same read path probes and readbacks use: the explicit read-only permission
  map, narrowed to the one repository of the assignment's checkout (its first
  working directory), expiring within an hour. The worker receives only
  `GH_TOKEN` and the process-local Git credential helper described below, as
  environment variables; the value never enters argv, a file, Git
  configuration, the workstream document, events, or artifacts, and it joins
  the worker's redaction set so an echo in output, a submission, or the tail
  is scrubbed before storage. Such a token can read that repository's
  metadata and contents but cannot push, merge, comment, or change anything:
  those remain exact engine-run actions. Actions cannot ask for `github_read`,
  because they already receive their own engine-minted tokens.
- `WEAVER_WORKER_GITHUB_READ=0` turns the exception off for a runner. A
  disabled runner, an unconfigured App, or any mint failure launches the work
  without a token and tells the worker in one line of its brief that GitHub
  API reads are unavailable, so it reports that instead of failing
  obscurely; a mint failure never fails the assignment by itself.
- A worker is never given Weaver's state or a credential store as a
  directory. Container executors mount worker directories read-write, so
  Weaver refuses any working or source directory that is, contains, or sits
  under `WEAVER_HOME` (which holds the executor-only secret store with the App
  key), `/etc/weaver`, the running Weaver checkout itself, the runner user's
  `~/.ssh`, `~/.config`, `~/.weaver`, `~/.claude` or `~/.codex`, the Docker
  socket, or `/proc`, as well as `/` and the home directory themselves.
  Symlinks are resolved first. The workspace
  root (`WEAVER_WORKSPACE_ROOT`) stays usable even when it lives inside
  `WEAVER_HOME`. The coordinator is refused when it records such an
  assignment, and the execution host refuses it again before launch — an
  older queued assignment fails with no attempt and wakes the coordinator to
  re-dispatch it against a checkout, worktree, or clone.
- Engine-run commands — an approved `exec_run`, its preflight and readback,
  and Weaver's own `git`/`gh` probes in a checkout — run with the runner's
  ordinary environment (`PATH`, `HOME`, Git and `gh` configuration) minus
  `WEAVER_STORE`, the `WEAVER_GITHUB_APP_*` identity, every executor-only
  secret name, and every model/provider credential. They then receive exactly
  the action's applicable secrets and the token minted for that action, so an
  approved command can push but can never write to the shared store directly.
- Host-side Git never obeys a checkout a worker could have written. Git
  configuration can run programs (`core.fsmonitor`, hooks, `filter.*`
  drivers, `diff.*.textconv`, a repository-local `credential.helper`,
  `include.path` pulling any of them in), and container workers mount their
  checkout read-write, so every Git (or `gh`) process Weaver starts in a
  checkout goes through one hardened runner (`src/safeGit.ts`). Before
  anything runs, it reads the checkout's Git configuration without executing
  it; an exec-capable key that the overrides below cannot switch off refuses
  the checkout (filter, diff and merge drivers, `include`/`includeIf`,
  credential helpers, aliases, a program-valued `core.fsmonitor`,
  `core.sshCommand`, pager and editor, `gpg.program`,
  `uploadpack`/`receivepack`, `ext::` URLs and `url.*.insteadOf`, among
  others). Weaver runs nothing there — not a deconfliction probe, not the
  nightly workspace collector (which keeps the directory and names the key),
  not an approved command, its preflight or its readback — and records a
  `checkout.git_refused` event naming the checkout and each key. An approved
  action in a refused checkout settles before its one-shot claim with zero
  attempts. The operator clears the finding by removing the key
  (`git config --unset …`); nothing in the fleet can waive it.
- Hooks are not a refusal. A repository's hooks — in `.git/hooks` or wherever
  its `core.hooksPath` points, as husky sets on every `yarn install` — never
  run on the host, because every Git process below carries
  `core.hooksPath=/dev/null`. A checkout that installs them keeps working.
- A repository-local Git LFS filter (`filter.lfs.*` in `.git/config`, which
  `git lfs install --local` writes) is refused like any other filter driver.
  The usual `git lfs install` writes the global configuration instead, which
  Weaver does not inspect.
- Every such Git process also runs with command-scope overrides
  (`GIT_CONFIG_COUNT`, Git's highest precedence) that turn off what one value
  can turn off: `core.fsmonitor=false`, `core.hooksPath=/dev/null`,
  `core.pager=cat`, an empty `diff.external`, `protocol.ext.allow=never`,
  `safe.bareRepository=explicit`. Weaver's own probes additionally ignore the
  system and global Git configuration and clear credential helpers, ssh and
  askpass overrides. An approved command keeps the operator's system and
  global configuration (commit identity, URL rewrites, LFS, credential
  helpers), which live outside every worker mount; the overrides are appended
  after the App's own `GIT_CONFIG_*` entries, so its process-local credential
  helper still authenticates `git push`.
- Container workers can still commit, but the Git control plane of each
  repository their read-write mounts expose — the common `config`, `hooks`,
  any `config.worktree`, a linked worktree's `.git` file and `commondir`
  pointer — is bind-mounted read-only over it. A worker Git command that
  writes configuration (`git config`, `git push -u`, `git remote add`) fails
  in the container. This raises the bar rather than drawing the line: a file
  that does not exist cannot be mounted, `.git` can be renamed away, and a
  repository a worker clones itself is its own from birth, which is why the
  host-side refusal above is the boundary.
- Hosted runners set `WEAVER_DETERMINISTIC_ACTIONS_ONLY=1`. A model process
  sharing the controller Unix identity could otherwise read the App key, so
  hosted repo egress must be an exact `exec_run` command. After approval and
  Pilot evaluation, only that engine subprocess gets a fresh write token.
- Preflight, deterministic GitHub reads, and readback get a separately minted
  read-only token with an explicit permission map. `gh` reads it from
  `GH_TOKEN`; Git gets a process-local, `github.com`-scoped credential helper
  that references that variable. The helper clears inherited credential
  helpers and never writes the token into argv, Git configuration, a
  credential store, or a temporary file. The installation token remains
  narrowed to one repository. The scope is derived, in order, from the
  action's explicit `exec.repository` field, then the repository its own
  `gh --repo`/`gh api repos/…`/clone-URL arguments name, and only then the
  checkout at `exec.cwd` — so an action that names its repository mints
  host-independently, without requiring a git checkout at the cwd.
- A cwd the claiming runner cannot see is placement information, not a
  durable action failure: the action stays queued with zero attempts and a
  single wake tells the coordinator to place it on a runner that can resolve
  the path (or to name the repository explicitly).
- A deterministic repo egress gets write scope only after approval and only
  immediately before its literal `gh pr create`/`gh pr merge`/`git push`
  command. Merely using `gh`, `git fetch`, or another Git remote read does not
  receive write scope. Readback cannot push even if its shell command is wrong.
- Tokens are cached only by repository and permission scope, and never beyond
  five minutes before GitHub's expiry. An action's preflight, execution, and
  readback additionally require at least fifteen minutes of remaining
  lifetime and mint a fresh token otherwise, so a token cannot expire during a
  deterministic command (bounded to two minutes) or a readback retrying
  through a transient GitHub failure.
- Only the installation token itself is scrubbed from captured action output.
  The Git plumbing beside it (`GIT_CONFIG_*`, such as the literal `true` that
  enables `useHttpPath`) is public configuration and is never redacted.
- Failure never falls back to a static `GH_TOKEN`, `GITHUB_TOKEN`, a `gh`
  login, or another App. A proven checkout, credential, or installation-scope
  configuration failure durably fails the action before its one-shot claim
  with zero execution attempts and wakes the coordinator once to repair the
  work. Transient network/provider failures are not rewritten as configuration
  truth and still escape through the runner's infrastructure path.

The GCP launch preflight makes this deployment contract structural. An
action-capable host must pass `github-auth-check`, and launch is refused if the
service account has a GitHub CLI login, Git credential helper/store, SSH
private key, credential-bearing remote, GitHub MCP configuration, or a static
GitHub token in Weaver's secret files.

## Commit identity

Every commit a worker makes is authored and committed as the installed App's
bot account (`<app-id>+<slug>[bot]@users.noreply.github.com`), because that is
the one identity GitHub can attribute to an account and Vercel can therefore
map to a team member. The runner resolves it once per worker
(`workerGitIdentityEnv`) and sets `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`,
`GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` in the worker's environment,
where they override any `user.*` a checkout or a model may have configured.
Each substrate must carry them across its own boundary: the in-process
executors inherit the subprocess environment, the OpenHands container gets
them as `--env` pairs, and the containerized local-sdk worker forwards exactly
those four names from the host environment (nothing else under `GIT_`, which
can execute commands or redirect credentials; the fixed credential-helper
entries of a `github_read` assignment arrive separately, as harness-selected
worker variables). A substrate that drops them leaves git with no identity
in an empty container HOME, and a model asked "who are you" by `git commit`
answers with an address it made up. `WEAVER_GIT_AUTHOR_NAME`/`_EMAIL` on the
host override the App identity for deployments that need a different
verified author.

## Rotation and removal

Generate a new App private key, replace the executor-only base64 value, push
the executor secret store to the host, and restart the resident runner. Delete
the old key from the App only after the new key passes `github-auth-check`.
Uninstalling the App or removing a repository from its installation makes
future token mints or repo-scoped calls fail without changing durable
Workstream truth.
