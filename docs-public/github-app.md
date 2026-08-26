# GitHub access on a hosted runner

A hosted Weaver runner should never carry a person's `gh auth login` session or
personal access token. Use a dedicated private GitHub App, install it only on
the repositories Weaver manages, and keep its App private key in Weaver's
executor-only store on the trusted controller host.

GitHub App credentials are a minting identity, not the credential used for an
operation. Weaver signs a ten-minute App JWT only when it needs one, then asks
GitHub for an installation token that expires after one hour. Repo operations
further narrow that token to the one repository named by the assignment.

## Create and install the App

Create a private GitHub App owned by the organization that owns the managed
repositories. It does not need a webhook or OAuth callback. Grant only these
repository permissions:

- Contents: write
- Pull requests: write
- Issues: write
- Checks: read
- Actions: read
- Commit statuses: read
- Workflows: write
- Metadata: read (GitHub adds this permission)

Install the App with **Only select repositories**, and select only the
repositories this Weaver fleet may manage. Contents write is what permits a
reviewed branch push; Workflows write is needed only because a legitimate code
change may touch `.github/workflows`. The installation selection is the hard
repository ceiling even when an approved action receives a write token.

Download one private key and record the App ID and installation ID. Register
them in executor-only scope; never put them in `.env`, workstream state, a
prompt, or an action secret:

```bash
printf '%s' '<app-id>' | weaver secret set WEAVER_GITHUB_APP_ID --executor
printf '%s' '<installation-id>' | weaver secret set WEAVER_GITHUB_APP_INSTALLATION_ID --executor
base64 < weaver-app.private-key.pem | tr -d '\n' \
  | weaver secret set WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64 --executor

weaver github-auth-check
```

`github-auth-check` proves the App can mint an installation token and read its
installation repository list. It prints no token, key, repository name, or API
body.

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
