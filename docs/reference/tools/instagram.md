# Instagram analytics

These four tools, available over MCP and the CLI, read the Instagram analytics already saved by Cutroom. They work without an open editing project. Connect an account in **Settings → Instagram** and sync in the app first. Tools never connect, disconnect, sync, publish, or read credentials.

| Tool | Input | Result |
| --- | --- | --- |
| `instagram_accounts` | `{}` | Connection state, account, last successful sync time, error, and post coverage |
| `instagram_posts` | `sortBy` (default `publishedAt`), `limit` (1–25, default 25) | Cached posts ranked in descending order |
| `instagram_post_analytics` | `postId` from `instagram_posts` | One post's latest metrics and observations from previous syncs |
| `instagram_account_insights` | `{}` | Current follower count and saved follower observations |

`sortBy` accepts `publishedAt`, `views`, `likes`, `comments`, `saves`, or `shares`. Missing metrics sort last; ties use the publication date, then post ID. The post list omits observation history; request `instagram_post_analytics` for that detail. An unknown post ID returns a readable not-found error.

## CLI

```sh
cutroom instagram_accounts
cutroom instagram_posts --sort-by views --limit 10
cutroom instagram_post_analytics <postId>
cutroom instagram_account_insights
```

`instagram_posts --limit` also accepts `-l`. Every command prints the same JSON result as its MCP tool.

## Interpret the numbers accurately

- `dataSource: "local_cache"` means no network request occurs. Check `lastSyncedAt`, connection `status`, and `error` before describing the numbers as current.
- Post metrics are the latest **lifetime** values observed at `syncedAt`. They are not totals for a selected day or week. Average watch time, when available, is in milliseconds.
- `null` means Instagram did not provide the metric. Zero means an actual zero; never substitute one for the other.
- `historySource: "local_sync_observations"` means values saved when the app synced. There is no pre-connection backfill and no guarantee of daily observations. Do not label a change between two syncs as daily follower growth unless those timestamps support it.
- `coverage` describes the downloaded post page. When `hasMore` is true, rankings cover only those cached posts and may exclude the account's best older post.

The four tools advertise MCP `readOnlyHint: true`. Their output schemas include only public analytics fields; tokens are never sent to the editing agent.
