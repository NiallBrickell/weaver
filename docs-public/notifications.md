# Push notifications

When a job needs a person — a question, an approval, a blocker — Weaver shows
a "needs you" card in the browser workspace and in
[`GET /api/v1/needs`](./rest-api.md#get-apiv1needs). With push notifications
turned on, `weaver ui` also sends an Apple push to every registered iPhone,
iPad and Mac the moment a new card appears, so nobody has to keep the app
open to notice.

The browser workspace runs all the time (on [Railway](./railway.md), for
example), so that is where pushes are sent from. Nothing is sent from the
machine that runs the work.

## What gets pushed

- **One push per new card, per device, once.** The push is never repeated:
  not on the next check, not after a restart or redeploy, and not when two
  copies of the service run at once. Each card is recorded before anything
  is sent, so a card the service was in the middle of sending when it
  stopped is not sent again either; it is still waiting in the app.
- **A card whose wording changes counts as new.** Each card has a `version`,
  and a different version is a different card.
- **Cards that were already open when notifications were first turned on are
  not pushed,** so switching the feature on does not flood phones with the
  backlog.
- **The words are the API's.** The title is the job's title; the body is the
  card's headline and as much of its detail as fits in 180 characters.
- **Yes/no cards get buttons.** When a card has exactly two choices, one
  plainly yes (such as "Approve…" or "Go ahead…") and one plainly no (such as
  "Decline…" or "Stop…"), the push has category `NEED_APPROVE_DECLINE` and
  says which choice label is which, so the app can answer from the
  notification. Everything else has category `NEED` and opens the app.

The full payload is described in
[the REST API reference](./rest-api.md#push-notifications).

Weaver checks for new cards every 30 seconds, and sooner when a browser
workspace is open and sees the fleet change. It reads the same shared list
that serves `/api/v1/needs`, which re-reads a job only when that job has
changed, so pushing adds no noticeable load on a hosted database.

## Registering devices

The app registers itself with
[`POST /api/v1/devices`](./rest-api.md#post-apiv1devices) using the respond
token, sending the device token Apple gave it. Registering the same token
again is harmless and just records that the device was seen. When Apple says
a token is no longer valid (the app was deleted, or the token was for a
different app), Weaver removes that device. You can list devices with
`GET /api/v1/devices`, which never shows the device tokens, and remove one
with `DELETE /api/v1/devices/:id`.

## Setting it up

You need an Apple Developer account that owns the app's bundle identifier.

### 1. Create an APNs key

1. Sign in to [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/authkeys/list)
   and open **Keys**.
2. Click **+**, give the key a name (for example "Weaver push"), tick
   **Apple Push Notifications service (APNs)**, and choose **Configure** to
   select the environment. **Sandbox & Production** lets one key serve both
   development builds and TestFlight/App Store builds.
3. Click **Continue**, then **Register**, then **Download**. You get a file
   named `AuthKey_<KEYID>.p8`. Apple lets you download it **once**, so keep it
   somewhere safe.
4. Note the **Key ID** shown on the key's page (10 characters, also in the
   file name) and your **Team ID**, shown at the top right of the developer
   site and under **Membership details**.

One key works for every app in your team, and does not expire. If it leaks,
revoke it on the same page and create a new one.

### 2. Set the variables on the `ui` service

On Railway, open the project, select the **ui** service, go to
**Variables**, and add:

| Variable | Value |
| --- | --- |
| `WEAVER_APNS_KEY` | The entire contents of the `.p8` file, including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines. Pasting it across several lines is fine; so is one line with `\n` where the line breaks were. |
| `WEAVER_APNS_KEY_ID` | The Key ID from step 1. |
| `WEAVER_APNS_TEAM_ID` | Your Team ID. |
| `WEAVER_APNS_TOPIC` | The app's bundle identifier. Optional: defaults to `ai.erdo.team`. |

Or from a terminal with the Railway CLI linked to the project:

```sh
railway variables --service ui \
  --set "WEAVER_APNS_KEY=$(cat AuthKey_ABC123DEFG.p8)" \
  --set "WEAVER_APNS_KEY_ID=ABC123DEFG" \
  --set "WEAVER_APNS_TEAM_ID=1234567890"
```

Railway redeploys the service with the new values. The repository's
`.railway/railway.ts` declares all four as preserved, so their values live
only in Railway and are never written to source.

The app also needs the **Push Notifications** capability in Xcode, and it
must send its token with the right `environment`: `sandbox` for a build run
from Xcode, `production` for TestFlight and the App Store.

### 3. Check it is on

The `ui` service logs one line at startup:

```
[notify] push notifications enabled for ai.erdo.team (key ABC123DEFG)
```

If a value is missing or the key is not a valid `.p8` file, it says so
instead, and pushes stay off while everything else works as before:

```
[notify] push notifications disabled: WEAVER_APNS_TEAM_ID is not set
```

After that, each failed push is logged with the device's id (never its
token) and Apple's reason, such as `BadDeviceToken` or `TooManyRequests`.
Keys and tokens are removed from every log line.

To turn notifications off again, delete `WEAVER_APNS_KEY` from the service.
