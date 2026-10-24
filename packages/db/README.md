# `@crm/db`

PostgreSQL access for the monorepo: the Drizzle schema, the SQL migrations, and
one shared `db` instance on a `pg` pool.

## Usage

```ts
import { db, desc, user } from "@crm/db";

const users = await db.select().from(user).orderBy(desc(user.createdAt)).limit(10);
```

Tables, enums, row types (`User`, `NewUser`) and the Drizzle operators all come
from the same entrypoint. The relational API reads nested records:

```ts
const deal = await db.query.deal.findFirst({
	where: eq(dealTable.id, id),
	with: { company: true, contacts: { with: { contact: true } } },
});
```

## Setup

```bash
docker compose up -d       # Postgres matching the DATABASE_URL in .env.example
cp .env.example .env       # at the repo root
bun run db:deploy          # apply the migrations
```

`DATABASE_URL` comes from the **repo-root `.env`**, loaded by `@crm/env` — see
[`docs/environment.md`](../../docs/environment.md). `src/client.ts` imports
`@crm/env/load` before reading it, and `drizzle.config.ts` calls `loadRootEnv()`
so the CLI works without any app running.

## Scripts

| Script        | Purpose                                                              |
| ------------- | -------------------------------------------------------------------- |
| `dev:prepare` | Apply pending local migrations and reject a schema no migration covers |
| `db:generate` | Write a migration for the changes in `src/schema/schema.ts`          |
| `db:migrate`  | Generate and apply a migration (development)                         |
| `db:deploy`   | Apply pending migrations (CI / production)                           |
| `db:check`    | Fail when `src/schema/schema.ts` has changes that no migration covers |
| `db:push`     | Push the schema without a migration (prototyping only)               |
| `db:reset`    | Drop and recreate the database                                       |
| `db:seed`     | Run `scripts/seed.ts`                                                |
| `db:studio`   | Open Drizzle Studio                                                  |
| `db:test`     | Create or rebuild `crm_test`                                         |

Each is also exposed at the repo root (`bun run db:migrate`) and routed through
`turbo run`.

## Moving from the Prisma releases

The Drizzle history starts at `drizzle/0000_baseline.sql`, which creates the schema
the last Prisma migration left. `db:deploy` recognises a database that Prisma
migrated: when every migration in `drizzle/legacy-prisma-migrations.txt` is in
`_prisma_migrations`, it records the baseline as applied and runs only what comes
after it. It refuses a Prisma database that misses any of them, because the
baseline would then describe tables that do not exist. `_prisma_migrations` stays
in place; nothing reads it again.

## Notes

- **No generated client.** The schema is TypeScript; there is no `build` step.
- **`timestamp(3)` without a time zone, written and read as UTC.** `src/client.ts`
  sets `pg.defaults.parseInputDatesAsUTC`, and the schema fills `createdAt`-style
  defaults in the app, so a server with a non-UTC `TimeZone` stores the same
  instants Prisma stored.
- **`numeric` is `Decimal`** (decimal.js) and `bytea` is `Uint8Array`, through the
  custom types in `src/schema/columns.ts`.
- **Raw SQL goes through `queryRows`.** It returns timestamps as `Date`. Bind an
  array as one parameter with `sql.param(list)`; a bare `${list}` expands into a
  tuple.
- **`whereEq(column, value)` keeps Prisma's meaning**: `undefined` adds no filter,
  `null` is `IS NULL`.
- **JIT package.** `exports` point at TypeScript sources; the consumer compiles
  them. Non-bundler consumers need a TypeScript runtime — the NestJS API runs on
  Bun for exactly this reason.
- **Client components import `-shape` modules only** (`@crm/db/fields-shape`,
  `@crm/db/settings-shape`, `@crm/db/workspace-shape`). They hold constants and
  pure functions and reach no table.
- **Auth tables follow Better Auth.** `bun run auth:generate` writes the schema
  Better Auth expects to `drizzle/auth-schema.generated.ts`. Compare it with the
  `user`, `session`, `account`, `verification` and `rateLimit` tables in
  `src/schema/schema.ts` and carry the differences over by hand.
