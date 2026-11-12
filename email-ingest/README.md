# Email ingest

Get a lease PDF from an email into local storage, logged and ready to parse.
Everything runs on one machine. No cloud account is needed.

```
email with PDF -> Grok Bot inbox -> routine -> POST /leases -> lease_inbox.py
                                                                 |-> storage/YYYY/MM/DD/<hash>-<name>.pdf
                                                                 |-> lease_inbox.sqlite  (status: received)
                                                                 |-> Folio dashboard     (document library)
```

## Into the dashboard

Each stored PDF is handed straight to the Folio dashboard in `../lease-review`, where it
appears in the document library as "Awaiting extraction". Folio must be running
(`npm start` in `lease-review`, with its Python environment set up as its README describes).

- If Folio is down, the lease is still stored. Send it on later with `python3 lease_inbox.py forward`.
- Each row records Folio's document id in `folio_id`, so nothing is sent twice.
- Folio takes files up to 20 MB. A larger PDF stays in the inbox with the reason in `error`.
- `FOLIO_URL` sets where Folio listens (default `http://127.0.0.1:4173`). Set it empty to switch the hand-off off.

## Run it

```bash
python3 lease_inbox.py serve
```

That starts the inbox on `http://127.0.0.1:8765`. Standard library only, nothing to install.

Send it a PDF:

```bash
curl --data-binary @lease.pdf -H "X-Filename: lease.pdf" -H "X-Sender: someone@example.com" http://127.0.0.1:8765/leases
```

Or skip the server and store a file straight from disk:

```bash
python3 lease_inbox.py store lease.pdf --sender someone@example.com --subject "Unit 4 lease"
```

## What comes back

One JSON object per file:

| `result` | Meaning | HTTP |
|---|---|---|
| `stored` | Saved and logged | 201 |
| `duplicate` | This exact PDF is already stored; nothing changed | 200 |
| `rejected` | Not a PDF, empty, or over 25 MB | 422 |

Optional request headers: `X-Filename`, `X-Sender`, `X-Subject`, `X-Message-Id`,
`X-Received-At`, `X-Source`. URL-encode values that contain spaces.

## For the parser

```bash
python3 lease_inbox.py list --status received
python3 lease_inbox.py mark 3 parsed
python3 lease_inbox.py mark 4 failed --error "no rent clause found"
```

Or over HTTP: `GET /leases?status=received`. Each row's `storage_path` is relative to `storage/`.

From Python:

```python
import lease_inbox
for doc in lease_inbox.list_documents("received"):
    path = f"{lease_inbox.STORAGE}/{doc['storage_path']}"
    ...
    lease_inbox.set_status(doc["id"], "parsed")
```

## Connecting Grok Bot

The Bot works on a cloud computer, so it cannot reach `127.0.0.1` on your laptop.
Give it a public address for the inbox with a tunnel, and protect it with a token:

```bash
LEASE_INBOX_TOKEN=<a long random string> python3 lease_inbox.py serve
```

```bash
cloudflared tunnel --url http://127.0.0.1:8765
```

Then follow `grokbot_routine.md`, using the tunnel's `https://...` address.
With a token set, every request except `/health` must send it as `X-Inbox-Token`.

## Notes

- `storage/` and `*.sqlite` are git-ignored. Lease PDFs never go into the repo.
- The server listens on `127.0.0.1` only.
- The Grok Bot mailbox takes up to 10 attachments a message, 10 MB each and 25 MB in total.
- Settings: `LEASE_INBOX_STORAGE`, `LEASE_INBOX_DB` and `LEASE_INBOX_TOKEN` override the defaults.
