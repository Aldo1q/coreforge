# coreforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Aldo1q/coreforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Aldo1q/coreforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, standard library
only — no dependencies, no install step, no git binary.

Entry for make.fun's "Build a GitHub-compatible git forge" bounty
(`github-core-clone-01`).

## What it does

One in-memory store backs four surfaces, so an object created over any of
them reads back identically over the others:

- **Git smart HTTP** — protocol v0 and v2 advertisements, `ls-refs` with
  ref-prefix filtering, fetch with incremental haves, shallow clones,
  absolute `deepen`, `deepen-relative`, `deepen-since`, and receive-pack
  pushes with fast-forward enforcement, per-ref `ng` reports and
  sideband-wrapped report-status. Packfiles are parsed and written
  in-process (OFS/REF deltas resolved on ingest; sent packs are always
  self-contained). Works end-to-end with the real `git` CLI.
- **REST v3** under `/api/v3` — repository creation, contents
  read/write/delete (including the first commit on an unborn repo),
  git refs, branches, commit history, labels, issues and comments, and
  pull requests with file diffs and squash/merge merges (conflicts answer
  405). Issues and pull requests share one number sequence per repo.
- **GraphQL** at `/api/graphql` — a small purpose-built engine (lexer,
  parser, executor) covering `viewer`, `repository`, `node(id:)`, the
  `__type` introspection probes, issue/pull-request connections with
  cursor pagination, and the `createIssue`, `closeIssue`,
  `createPullRequest`, `mergePullRequest` and `addComment` mutations,
  including operation batching and opaque stable global ids.
- **MCP** at `/mcp` — JSON-RPC 2.0 tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `get_issue`, `create_pull_request`,
  `list_pull_requests`, `merge_pull_request`) speaking both the
  2026-07-28 revision (`server/discover`) and the handshake era
  (`initialize`).

Authentication is a single bearer token (the process's
`MAKEFUN_SHOP_TOKEN`); the token owner is the forge's one user.

## Running

```
node /bot/main.ts        # or: npm start
```

The process listens on an ephemeral port, registers it with
`$MAKEFUN_ENV_URL/register`, polls `$MAKEFUN_ENV_URL/done`, and exits 0
when the environment says it is done.

## Layout

- `main.ts` — entrypoint: HTTP routing, auth, environment lifecycle
- `store.ts` — the store: repos, the git object model, trees, diffs, merges
- `gitproto.ts` — smart-HTTP protocol and packfiles
- `rest.ts` — REST v3
- `graphql.ts` — the GraphQL engine and schema
- `mcp.ts` — the MCP server
- `util.ts` — pkt-lines, hashing, global ids

MIT licensed.
