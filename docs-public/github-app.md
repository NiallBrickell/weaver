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
- Workflows: write
- Metadata: read (GitHub adds this permission)

Existing and future repositories can then enter Workstreams without an App
settings change. Installation defines the fleet's maximum repository estate;
it never grants an individual run access across that estate. Every operation
still mints a token for the one exact owner/repository resolved from the
assignment checkout, and Weaver rejects the token unless GitHub confirms that
exact repository.

Contents write is what permits a reviewed branch push; Workflows write is
needed only because a legitimate code change may touch `.github/workflows`.

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

- Ordinary OpenHands workers receive neither the App private key nor an
  installation token. They work from the controller's mounted checkout and
  cannot push to GitHub.
- Hosted runners set `WEAVER_DETERMINISTIC_ACTIONS_ONLY=1`. A model process
  sharing the controller Unix identity could otherwise read the App key, so
  hosted repo egress must be an exact `exec_run` command. After approval and
  Pilot evaluation, only that engine subprocess gets a fresh write token.
- Preflight and deterministic readback get a separately minted read-only token
  with an explicit permission map. Readback cannot push even if its shell
  command is wrong. Write tokens also carry an explicit permission map rather
  than inheriting every permission granted to the App.
- Tokens are cached only by repository and permission scope, and never beyond
  five minutes before GitHub's expiry. A fresh action run lasts at most forty
  awake minutes; deterministic hosted commands are bounded to two minutes and
  readback mints independently afterward.
- Failure to mint never falls back to `GH_TOKEN`, `GITHUB_TOKEN`, a `gh` login,
  or another App. The action stays unexecuted.

The GCP launch preflight makes this deployment contract structural. An
action-capable host must pass `github-auth-check`, and launch is refused if the
service account has a GitHub CLI login, Git credential helper/store, SSH
private key, credential-bearing remote, GitHub MCP configuration, or a static
GitHub token in Weaver's secret files.

## Rotation and removal

Generate a new App private key, replace the executor-only base64 value, push
the executor secret store to the host, and restart the resident runner. Delete
the old key from the App only after the new key passes `github-auth-check`.
Uninstalling the App or removing a repository from its installation makes
future token mints or repo-scoped calls fail without changing durable
Workstream truth.
