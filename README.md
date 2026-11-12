# GrokBotHackathon — Role Model

Role Model is a local lease register with an Excel-style grid, PDF evidence highlighting, review history and Excel export. The initial dataset contains **10 synthetic leases and 10 related PDFs** from `PDFs/`, extracted by Astra against the 56-column rent-roll specification. New uploaded documents use the **Claude Fable API**.

## Start

Requires Node.js 22 or newer:

```bash
git clone https://github.com/oligreenhalgh/GrokBotHackathon.git
cd GrokBotHackathon/lease-review
npm ci
npm start
```

Open **http://127.0.0.1:4173**. The initial register and PDF viewer work without an API key. See [Role Model setup](lease-review/README.md) for PDF/DOCX upload dependencies and the server-side Anthropic key.

Work on a branch and keep dashboard changes in `lease-review/`. The **Email** tab uses a new read-only Gmail OAuth connection and lets you choose attachments to import. See the [Gmail setup](lease-review/README.md#gmail-connection). The legacy `email-ingest/` module remains inactive and is not reused.

Local API keys, uploads, review changes, databases and dependencies are ignored by Git. Synthetic source PDFs and Astra's prepared register are committed so another developer can run the same baseline.
