# Ferry — specification

Ferry moves a folder of notes between two vaults **without a server**. One side
packs the changes into a single encrypted file; the other side unpacks it. The
file travels however you like — email, Teams, a USB stick, a messaging app.

It is not sync. Nothing happens automatically, nothing listens on a port, and
neither person needs to be online at the same time. That is the point: it works
where sync cannot, and it leaves you in control of exactly what leaves the vault.

---

## 1. The model

**Share root** — one folder both vaults agree on, for example `Projects`.
Paths inside a parcel are relative to it, so a canvas that references
`Projects/HTML/card.html` resolves the same on both sides. Set once, on the
first share, and then left alone.

**State** — each side remembers `path → hash` as of the last successful
exchange. It lives in the plugin folder, deliberately outside the share root, so
it never travels and never syncs.

**Parcel** — a delta against that state: what changed, what was added, what was
deleted. Not the whole folder.

**Conflict** — a file that changed on *both* sides since the last exchange.
Ferry never silently overwrites: it keeps the incoming version beside yours as
`Note (conflict from <peer> <date>).md` and lets a person decide.

Every file type is carried the same way: markdown, canvas, images, PDFs,
Excalidraw, HTML, anything in the folder. Ferry does not interpret content.

---

## 2. Parcel format

A `.ferry` file is an encrypted zip.

```
FERRY\x01              6-byte magic
salt                   16 bytes          PBKDF2
iv                     12 bytes          AES-GCM
iterations             4 bytes, big-endian
ciphertext             AES-GCM-256 over the zip below
```

The zip inside:

```
manifest.json
files/<path relative to share root>      only the changed ones
```

### manifest.json

```jsonc
{
  "format": 1,
  "plugin": "ferry",
  "version": "0.1.0",
  "shareRoot": "Projects",
  "peer": "preetesh",          // who packed it
  "createdAt": "2026-10-01T09:15:00.000Z",
  "baseState": "<hash>|null",  // the state this delta applies to; null = full parcel
  "resultState": "<hash>",     // the sender's state after packing
  "entries": [
    { "path": "HTML/card.html", "hash": "<sha256>", "size": 48213, "op": "change" }
  ],
  "deletions": ["Notes/old.md"],
  "requires": [
    { "id": "obsidian-excalidraw-plugin", "name": "Excalidraw", "reason": "3 drawings" }
  ]
}
```

`requires` is advisory. Files always land; without the plugin they simply render
plainly. The receiver is shown what is missing and where to get it.

---

## 3. Packing

1. Walk the share root, hashing every file (SHA-256), skipping the excludes.
2. Compare with the stored state:
   - in neither → *add*
   - hash differs → *change*
   - in state, no longer on disk → *deletion*
3. Detect required community plugins (§5).
4. Build the zip, encrypt it, write it to the outbox.
5. **Update the state.** The parcel is kept in the outbox, so if it never
   arrives, resend that same file rather than packing again.

`Ferry: pack everything` ignores the state and sends the whole share root — for
a first exchange, or to recover when the two sides have drifted.

---

## 4. Unpacking

1. Decrypt, unzip, read the manifest.
2. If `shareRoot` differs from this vault's setting, say so and stop. A parcel
   must land where its paths expect.
3. Classify every entry against the local file and the stored state:

   | Local file | vs state | Result |
   |---|---|---|
   | missing | — | **add** |
   | hash equals incoming | — | identical, skipped |
   | unchanged since last exchange | matches state | **safe overwrite** |
   | changed since last exchange | differs | **conflict** → keep both |

4. Deletions apply only when the local file is unchanged since the last
   exchange, and only when the person ticks the box. Anything else is reported
   and left alone.
5. Show the preview. Nothing has touched the vault yet.
6. On confirm: snapshot every file about to be written or removed, then apply.
7. Update the state to what the sender has, so the next parcel is a correct
   delta. A conflict copy is a new local file, so it travels back on the next
   parcel — both sides end up seeing the disagreement.

---

## 5. Required plugins

A parcel records which community plugins its content needs, so the other person
is not left with a note that renders as raw text.

Detected automatically from the content:

| Signal | Plugin |
|---|---|
| `.excalidraw.md`, or `excalidraw-plugin` in frontmatter | Excalidraw |
| ```` ```dataview ````, ```` ```dataviewjs ```` | Dataview |
| ```` ```tasks ```` | Tasks |
| ```` ```chart ```` | Charts |
| ```` ```kanban ````, `kanban-plugin` in frontmatter | Kanban |

Anything else is declared by hand in settings — a plugin that presents your
content, for example, cannot be inferred from the files alone.

`.canvas` needs no plugin; Canvas is part of Obsidian.

---

## 6. Safety

Everything that can lose work is covered by one rule: **nothing is written
before a copy is taken.**

1. **Preview first** — counts and a full list, with Cancel.
2. **Snapshot** — every file an apply would overwrite or remove is copied to
   `backups/<timestamp>/` first, with a `meta.json` recording what was created,
   overwritten or removed.
3. **Undo last unpack** — restores that snapshot, and removes files the apply
   created.
4. **Deletions need a tick**, every time.
5. **Deleted files go to the vault trash**, not to nothing.
6. **Retention** — snapshots and parcels older than the configured number of
   days are pruned on demand, so the folder does not grow without end.

Ferry's safety net covers Ferry's own mistakes. It is not a vault backup, and
the settings screen says so.

---

## 7. What Ferry is not

- Not continuous sync — use Self-hosted LiveSync or Syncthing for that.
- Not multi-party — two peers, one share root, in this version.
- Not a merge tool — markdown is not merged line by line, and a `.canvas` is a
  single JSON document that cannot be merged at all. Conflicts keep both files.
- Not transport — Ferry makes a file. Sending it is your business.
