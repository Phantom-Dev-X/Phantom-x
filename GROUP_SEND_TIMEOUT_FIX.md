# 🛠️ Group Send "Timed Out" — Diagnosis & Fix

## The symptom (from real logs)
```
[GroupWarm] refreshed metadata for 120363...@g.us via web:web_...
[GroupSendRetry:web:...] timeout in 120363...@g.us: Timed Out
[GroupSendRetry:web:...] retry failed in 120363...@g.us: Timed Out
Message handler error: Timed Out
```
Sending to **individual chats works**, but sending to a **group** times out — even
on a tiny command like `.ping`. Note the sender format in the log:
`91861163204683@lid` → this is a **LID-addressed** group (WhatsApp's newer identity
format).

## Root cause
When sending to a group, Baileys must encrypt the message **for every participant**.
To do that it runs, per send:
1. **USync device query** — asks WhatsApp for each participant's device list
   (`getUSyncDevices` → `executeUSyncQuery`).
2. **`assertSessions`** — fetches a Signal session for any device it doesn't have.

Both go through `query()`, which is bounded by **`defaultQueryTimeoutMs`**. If WhatsApp
is slow to answer (busy link, big group, LID resolution), these queries hit the
timeout and the whole send throws **408 "Timed Out"** (documented upstream:
Baileys issue #1875). Retrying the *same* uncached path just times out again — exactly
what the logs show.

LID groups make it worse: without a persisted LID→JID map, identity resolution is
repeated every time, adding more slow lookups.

## The fix (applied in index.js)
Four mitigations, all aimed at **not re-running the slow per-participant queries**:

1. **`defaultQueryTimeoutMs: 120_000`** on both sockets — give slow queries headroom
   instead of aborting at the 60s default.

2. **Persistent `userDevicesCache` (NodeCache)** passed into `makeWASocket`.
   Caches each participant's device list so the USync device query is skipped on
   repeat sends:
   ```js
   const userDevicesCache = new NodeCache({ stdTTL: 300, useClones: false });
   makeWASocket({ /* ... */ userDevicesCache, msgRetryCounterCache });
   ```

3. **`useCachedGroupMetadata: true` on every group send** (in the sendMessage
   wrapper). Forces Baileys to use the warm group cache instead of re-querying the
   participant list:
   ```js
   if (isGroupJid) sendOptions = { ...sendOptions, useCachedGroupMetadata: true };
   ```

4. **Persist `lid-mapping.update`** into a `lidJidMap` (via `attachLidMappingHooks`)
   so LID groups resolve identities without fresh lookups each send.

Plus the existing protections that were already present:
- `cachedGroupMetadata` wired to the socket
- `warmAllGroups()` pre-warms the cache on connect
- `ensureGroupReady()` refreshes metadata right before a group send
- group-send wrapper now does **two** timeout retries (1.5s then 3s) with a refreshed
  cache, instead of one.

## If it STILL times out
- **Very large groups (200+):** WhatsApp can server-side throttle session/USync setup.
  That's a platform limit, not config. The cache fix reduces how often you hit it.
- **Slow host/network (e.g. free tier):** raise `defaultQueryTimeoutMs` further, or
  move to a faster host. You can also lower group send frequency.
- **Confirm the caches are active:** look for the absence of repeated
  `[GroupSendRetry] timeout` after the first successful send to a group (the device
  list should now be cached for 5 min).

## TL;DR
> Group sends time out because Baileys re-queries every participant's devices +
> sessions on each send, bounded by `defaultQueryTimeoutMs`. Fix = **cache the
> device list + group metadata + LID map, send with `useCachedGroupMetadata: true`,
> and raise the query timeout**, so those slow queries don't run (or don't abort)
> on every message.
