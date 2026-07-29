# missions console

The org, from a phone.

`report.html` was always a document — generated once, opened with `--open`, read
on the machine that made it. This is the same facts as a live surface: the board
refreshes itself, the chief transcript streams, and you can dispatch, steer and
merge from wherever you are.

It is a **client of the org, not a copy of it**. Every fact it renders comes from
`../dist` — the same readers the TUI and the report use — so there is exactly one
implementation of "what is a mission".

## Run it

```bash
cd web
npm run dev            # http://localhost:3200
```

Port 3200, not 3000, so it never argues with a dev server a mission is running.

The board and mission views work on their own. The **Chief** tab and every write
need the org daemon up on the same machine:

```bash
missions chat          # in any repo, on the host
```

## Pin the operator — do this before you expose it

Clerk answers *"is this a real GitHub account"*. It does not answer *"is this
you"*, and on a public tunnel those are very different questions: the Clerk
instance has public sign-up, so anyone who finds the URL can mint an account.

Until you pin it the console runs **UNPINNED** — reads work, every write is
refused, and a warning sits on every page.

```bash
# 1. sign in once at http://localhost:3200
# 2. find your id
clerk users list
# 3. put it in web/.env.local, then restart
MISSIONS_ALLOWED_USER_IDS=user_xxxxxxxxxxxxxxxx
```

Optionally close the door behind you:

```bash
clerk config patch --json '{"auth_access_control":{"sign_up_mode":"restricted"}}'
```

## Reach it from your phone

ngrok is already authed with a static domain:

```bash
npm run tunnel   # ngrok http 3200 --domain incomparably-tritheistic-tonya.ngrok-free.dev
```

That domain is currently also configured for your `backend` tunnel on port 3000,
and the free tier allows one static domain at a time — so run one or the other,
or claim a second domain. `cloudflared tunnel --url http://localhost:3200` works
too, with a URL that changes on every restart.

## The auth model

| Layer | Answers | Where |
|---|---|---|
| Clerk, GitHub only | is this a real account | `proxy.ts`, `app/sign-in` |
| `MISSIONS_ALLOWED_USER_IDS` | is this *your* account | `lib/guard.ts` |
| `mayMutate()` | may it spend money | every write path |

Password and email sign-in are disabled on the instance; GitHub is the only
enabled connection. Reads need a signed-in operator. **Writes additionally need
a pinned one** — being signed in is not enough to dispatch a mission that spends
real money.

## Two things worth knowing before editing this

**Never send `hello` to the daemon casually.** `src/daemon.ts` treats it as
`registerWorkspace(cwd)` + `session.setFocus(cwd)`, and focus is global — a web
client that said hello on connect would silently repoint whatever terminal you
had open. `attach()` in `lib/daemon.ts` is therefore read-only by construction,
and focus only moves through the explicit `setFocus()`.

**Writes are split deliberately.** `clear` is one boolean on one registry record,
so it runs directly against `updateActive`. `dispatch`, `merge` and `steer` are
multi-step and already exist as chief tools, complete with worktree reclaim,
branch deletion and conflict reporting — so they are sent to the chief as a
sentence rather than reimplemented here. Codenames (`IRONWING`) exist precisely
so that sentence is unambiguous. Two merge procedures would drift apart, which is
the failure mode `CONTRACTS.md` is about.

## What the mission view leads with

Not `6/6 assertions`. The headline is **behavioural** — how many assertions
actually ran the code — because `CONTRACTS.md` exists on the back of a mission
that reported 6/6 and CLEAN while none of the six executed the feature. The page
also raises a band when the strength classifier downgraded a declared
`behavioural` assertion to filesystem inspection, and when nothing behavioural
ran at all.
