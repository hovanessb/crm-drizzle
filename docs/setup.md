# Setup and local development

Operational detail moved out of the rule docs. `api.md`, `agent.md` and
`environment.md` are what agents read before changing code; this is what a person
reads once.

## First run

```sh
cp .env.example .env        # fill DATABASE_URL, BETTER_AUTH_SECRET, ALLOWED_SIGN_IN
docker compose up -d        # Postgres, matching .env.example
bun run db:migrate && bun run db:seed
bun run dev                 # app :3000, api :3001, agent :2000
```

Drizzle from the repo root: `db:generate`, `db:migrate`, `db:check`, `db:push`,
`db:reset`, `db:seed`, `db:studio`, `db:deploy`.

`dev` depends on `^dev:prepare`, so every start applies pending migrations before a
single server boots. That is why the first run needs `db:migrate` only for the seed
that follows it. When `src/schema/schema.ts` has changes that no migration in
`packages/db/drizzle` covers, `dev:prepare` stops the whole run rather than
starting servers against a schema the database does not have — create the
migration with `db:migrate`, or `db:reset` when the divergence is an edited
migration that has already been applied.

A database that the Prisma releases migrated needs no manual step. `db:deploy`
adopts it when every Prisma migration is recorded, and refuses it otherwise.
`packages/db/README.md` says how.

## `bun run dev` in Docker, for an older Linux

`nestjs-trpc watch` runs a native binary that needs GLIBC 2.39 on x86-64. Ubuntu
22.04 and older have an older GLIBC, so the API's tRPC watcher fails there.
`docker/dev` runs the whole `bun run dev` in a container built on Docker's hardened
Bun image, `dhi.io/bun:1.4-debian13-dev` (Debian 13, GLIBC 2.41). The Dockerfile copies
Node 24, which eve needs, from the hardened `dhi.io/node:24-debian13-dev` image, and
adds the Docker CLI.

```sh
docker login dhi.io                                  # once: your Docker account
docker/dev/run.sh                                    # bun install, then bun run dev
docker/dev/run.sh bun run --filter=api trpc:generate # any other command
```

- **The container uses the host network.** `localhost` in `.env` reaches your local
  PostgreSQL, a `llama-server` and the other two servers, and the app is on
  `localhost:3000` as before. `eve dev` listens on `127.0.0.1` only, so published
  ports would not reach it. This needs Linux; Docker Desktop on macOS behaves
  differently.
- **The repo is mounted at the same path as on the host.** eve's Docker sandbox
  asks the host's Docker daemon to bind-mount a path inside the repo, and that path
  must exist on the host. `run.sh` mounts `/var/run/docker.sock` when it exists.
  Without it, `eve dev` falls back to its `just-bash` sandbox.
- **Only the `-dev` Debian tag works.** The runtime tags have no shell, and `bun run
  dev` starts its servers through `sh`. The Alpine tags use musl, and the tRPC
  binary is built only for GLIBC. The `-dev` tag is not hardened for production use,
  which does not matter for a dev container.
- **The container runs as your user.** `run.sh` builds it with your UID and GID, so
  `node_modules`, `.turbo` and `.next` on the host stay yours. The Bun cache is a
  named volume, `crm-dev_bun-cache`.
- **Start it with `run.sh`, not `docker compose`.** The compose file needs the
  values `run.sh` exports, and a plain `docker compose` stops with that message.
- **The Docker socket is root on the host.** A process in the container that uses it
  controls the host's Docker. `CRM_DEV_NO_DOCKER=1 docker/dev/run.sh` leaves the socket
  out, and the agent uses `just-bash` instead.

## Google Cloud

- **Enable the Gmail API and the Google Calendar API** on the project.
- **Set the consent screen to User type: Internal** if you are on Workspace.
  `gmail.readonly` is a *restricted* scope, so an External app needs OAuth
  verification plus an annual CASA assessment. Going External later means the full
  review — a decision, not a checkbox.

## The agent bridge

```sh
AGENT_URL="http://127.0.0.1:2000"   # 127.0.0.1, not localhost: eve dev is IPv4-only
AGENT_BRIDGE_SECRET="$(openssl rand -base64 32)"
```

| Agent tab error | Cause |
| --- | --- |
| `503` | `AGENT_BRIDGE_SECRET` unset in the app's process |
| `401` | The two processes hold different secrets, **or** `passThroughEnv` in `apps/app/turbo.json` / `apps/agent/turbo.json` is missing the pair (Turbo is strict-env) |
| `502` | Agent not running, or `AGENT_URL` wrong |

`localDev()` accepts any loopback request, so `curl 127.0.0.1` proves nothing about
the bridge — send `-H 'Host: agent.example.com'`. `GET /eve/v1/info` is the whole
inventory, including a `diagnostics` count that finds files eve silently ignored.

## Running the agent

The agent package's default `dev` command is interactive `eve dev`. The root
Turbo task marks it interactive, so select the agent pane and press Enter before
using the eve TUI. Run `turbo run dev:headless --filter=agent` when a terminal
cannot render the TUI; that uses `eve dev --no-ui`, and the Turbo pane is the
record because only interactive development writes `.eve/logs/` for `eve logs`.
Reach for the Turbo task rather than `bun run --filter=agent dev:headless`: the
package script alone skips `dev:prepare`, so the agent would start against
unmigrated tables.

`hooks/activity.ts` is the replacement narration, **to stderr** (the TUI hides
stdout), printing shape everywhere and argument contents outside production only. It
is **not the audit trail** — `hooks/audit.ts` writes `AgentEvent` regardless.

- A second `bun run dev` fails the whole turbo run.
- An orphaned agent holds the port: `lsof -nP -iTCP:2000 -sTCP:LISTEN`.

### Nothing is researching, and the queue only grows

**`eve dev` never fires schedules on their cron cadence**, and everything visible
still works — the row is written, the sheet says *Queued*, and `dispatch.ts` is never
called. The poke covers this **only when `AGENT_BRIDGE_SECRET` is set**; unset,
`poke()` returns silently and the queue looks exactly like a slow agent.

Tasks the API did not write (`schedule_recheck`) and anything queued while the agent
was down still need a manual run:

```sh
bun run --filter=agent dispatch    # exact production path, both lanes, real credits
```

Its printed `sessionIds` are research rows only, so a run that resolved forty logos
prints an empty list and was not idle. `eve start` and Vercel do run the schedule.

## `vercel env pull` writes `.env.local`, which wins

`.env.local` is the override the loader reads *last*, and `vercel env pull` writes
**production** credentials there by default. Pull once and every process silently
points at production — not as an error, but as `bun run dev` working perfectly against
the live database. On 2026-08-01 eleven migrations landed on Neon from a laptop.

1. **Pull somewhere inert**: `vercel env pull .env.vercel`.
2. **`packages/db/scripts/require-local-db.ts` guards `db:migrate`, `db:push`,
   `db:reset`, `db:seed`** and takes `ALLOW_REMOTE_DB=1`. `db:deploy` is unguarded on
   purpose. It reads the root files directly rather than `process.env`, because Bun
   auto-loads the working directory's `.env` while drizzle-kit only sees
   `loadRootEnv()`.

## Migrations run on the production deploy, and nowhere else

`apps/api/scripts/build-func.mjs` runs `bun scripts/migrate.ts` in `packages/db` during the crm-api
build, gated on `VERCEL_ENV === "production"`. The schema therefore moves when the
release pull request merges and `release` deploys — with the code that needs it,
and once rather than once per branch.

Preview deploys share the production database: `DATABASE_URL` is a single value
across production, preview and development. Until that changes, **a preview of a
branch that adds a migration runs against a database without those tables** — it
builds, and the pages that touch them fail. Test schema changes locally, where
`bun run dev` migrates for you. Before the gate existed the reverse was true and
worse: every preview applied its own migrations to the production database, so on
2026-08-07 the live schema ran six migrations ahead of the live code all day.

### Applied migrations are not proof the schema is right

The build follows the deploy with `scripts/check-drift.ts`, which fails when
`src/schema/schema.ts` has changes that no migration covers, and shouts in the build
log when it does. **It does not compare the live tables.** A row in
`drizzle.__drizzle_migrations` for every file says nothing about what the tables
actually look like.

They came apart once, under Prisma. A `prisma db push` shaped production from a laptop, the
migration rows were recorded as applied without their SQL ever running, and
`agentConversationAttachment` went live without its `position` column. Every deploy
reported nothing pending, for days, while `conversations.builderById` returned 500.
The tell is an object in the database that no migration defines — there was an
`agentConversationAttachment_submissionId_createdAt_idx` that appears in no
migration file, only in a `db push` of an older schema.

To see what the live database lacks, introspect it and read the result before
running anything:

```sh
cd packages/db
bunx drizzle-kit pull --dialect postgresql --url "…" --out /tmp/live
```

## Secrets hygiene

`.gitignore` ignores `.env` and `.env.*` with one negation for `.env.example`, so
`.env.bak` is ignored too. `.env.example` ships no secret — placeholders are empty
strings, asserted by `packages/env/test/root.spec.ts`. **Generate your own secret**;
never reuse one from an example, a tutorial, or another environment.

## Tests

```sh
bun run --filter=api test
bun run --filter=agent test    # integration specs need DATABASE_URL + real Postgres
```

### The test database rebuilds itself when it drifts

`bun run db:test` creates `crm_test` and applies the migrations to it. The database
name must end in `_test`; the suite deletes rows it expects to put back, so it
refuses anything else.

**Migrating only applies migrations that are missing. It never removes a
table, a column or a constraint the database has and the schema does not.** A
`crm_test` built on a branch that was later abandoned therefore keeps that branch's
objects forever, and `db:test` used to report `already exists` and move on. The
extra objects are invisible until one of them rejects a write, and then the failure
names a constraint that appears in no migration and in no schema — a stray
`trackedEvent_visitorId_fkey` once failed seven tracking specs this way, on every
branch, for as long as the database survived.

So `db:test` now checks the database it found and rebuilds it when either is true:

- **It holds a migration this branch does not have.** The database came from
  another branch. The name of the first one is printed.
- **It was migrated from different migration files.** A migration file changed
  after the database applied it.

A rebuild drops the database and re-runs every migration, and it says which of the
two reasons fired. Force one with `bun run db:test --reset`. Nothing else in the
repo may drop a database, and this may only because the `_test` suffix is checked
first.
