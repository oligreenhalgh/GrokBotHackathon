# GrokBotHackathon

Local lease processing tools, split into independent modules so work can proceed in parallel.

| Module | Purpose | Local address |
| --- | --- | --- |
| [`lease-review/`](lease-review/README.md) | Folio spreadsheet dashboard, PDF evidence viewer, prepared extraction, reviews and Excel export | `http://127.0.0.1:4173` |
| [`email-ingest/`](email-ingest/README.md) | Existing PDF inbox and document receipt log | `http://127.0.0.1:8765` |

## Start the dashboard

Install Node.js 22 or newer, then:

```bash
git clone https://github.com/oligreenhalgh/GrokBotHackathon.git
cd GrokBotHackathon/lease-review
npm ci
npm start
```

Open **http://127.0.0.1:4173**. The included collection, register, evidence viewer and Excel export work without Python, an API key or Grok. See the [dashboard setup](lease-review/README.md) for optional PDF/DOCX upload dependencies.

## Work in parallel

Create a branch for your part, for example `git switch -c feature/email-import`.
Keep dashboard work in `lease-review/` and inbox work in `email-ingest/`.
The two modules currently run independently; no automatic inbox-to-dashboard bridge is enabled.

The intended integration is: receive a PDF in the inbox, send it to the dashboard's
`POST /api/upload`, extract its lease terms, then send validated rows to `POST /api/import`.
The [API and extraction contract](lease-review/README.md#api-and-extraction-contract)
lets an extraction provider be added without rewriting the grid or source viewer.

Local uploads, review changes, databases, `.env` files and dependencies are ignored by Git.
The repository includes only the prepared public MCL template collection and its extraction.
