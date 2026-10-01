# Ferry

Carry a folder of notes between two vaults as a single encrypted file.

No server, no accounts, nobody online at the same time. One side **packs** what
has changed; the file travels however you like — email, chat, a USB stick — and
the other side **unpacks** it into the same place in their vault.

It carries whatever is in the folder: markdown, canvases, images, PDFs,
Excalidraw drawings, HTML. Ferry does not interpret content.

---

## Why

Sync wants a server, or two devices awake at once, or an account each. Sometimes
you have none of those — a colleague behind a corporate firewall, a client who
will only accept an email attachment, a site office with no reliable link. Ferry
is for that: a parcel you can send by any means at all.

## How it works

**Share root.** One folder both vaults agree on, for example `Projects`. Paths
inside a parcel are relative to it, so a canvas that points at
`Projects/HTML/card.html` resolves the same on both sides. Agreed once, on the
first exchange.

**State.** Each side remembers what was last exchanged. That is what makes a
parcel a delta rather than the whole folder, and what makes a genuine conflict
detectable.

**Conflicts keep both.** If a file changed on both sides since the last
exchange, the incoming version lands beside yours as
`Note (conflict from alice 2026-10-01).md`. Nothing is ever silently
overwritten.

**Plugins come listed.** A parcel records which community plugins its content
needs — Excalidraw, Dataview, Tasks, Charts, Kanban, Templater are detected
automatically, and anything else can be declared. The other side is told what is
missing and where to get it. The files arrive either way.

## Safety

Nothing is written before a copy is taken.

- A **preview** before every apply: *12 new · 3 updated · 1 conflict · 1 to delete*, with Cancel.
- A **snapshot** of every file the apply would overwrite or remove.
- **Undo the last unpack** — one command.
- **Deletions need a tick**, every time, and deleted files go to the vault trash.
- **Retention** — snapshots and old parcels are pruned on command.

This protects you from a bad parcel. It is not a backup of your vault, and the
settings screen says so.

## Using it

Both sides install Ferry and agree on three things: the **share root**, a
**passphrase**, and what to call each other.

**Sending**

1. *Ferry: pack changes into a parcel* — or *pack everything*, the first time.
2. The parcel appears in `Ferry/outbox`. Send it however you like.

**Receiving**

1. Put the `.ferry` file in `Ferry/inbox`.
2. *Ferry: unpack a parcel* → choose it → read the preview → Apply.

*Ferry: status* says what would be sent without packing anything.

If a parcel never arrives, **resend the same file** rather than packing again —
the next parcel is measured from the state the first one created.

## Commands

| Command | What it does |
|---|---|
| Pack changes into a parcel | everything changed since the last exchange |
| Pack everything | the whole share root — first exchange, or to re-sync |
| Unpack a parcel | preview, then apply |
| Status: what would be sent | counts, without writing anything |
| Undo the last unpack | restores the snapshot |
| Clean up old snapshots and parcels | applies the retention setting |

## Parcel format

An encrypted zip: `FERRY\x01` magic, PBKDF2-SHA256 (310,000 iterations),
AES-GCM-256. Inside, a `manifest.json` and only the changed files. The full
specification is in [docs/00-spec.md](docs/00-spec.md).

## Building

```bash
npm install
npm run build          # typecheck + bundle to main.js
node tools/roundtrip.mjs   # proves the parcel format end to end
```

To try it, copy `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/ferry/` and enable it.

## What Ferry is not

Not continuous sync, not multi-party, not a merge tool, and not transport. It
makes a file. Sending it is your business.

MIT licensed.
