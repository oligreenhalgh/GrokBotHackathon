# Roll Model — lease review

A local spreadsheet-style lease register with a source document behind each extracted field. The initial collection is **10 synthetic leases and 10 related documents, covering 765 PDF pages**. Astra prepared the initial 56-column register. New uploaded documents are extracted with the Claude Fable API.

## Run

Requires Node.js 22 or newer:

```bash
npm ci
npm start
```

Open **http://127.0.0.1:4173**. The server listens only on this computer. The initial register, PDF viewer, corrections and Excel export work without an API key. PDF.js is bundled locally and Excel export uses ExcelJS.

### Enable extraction for new uploads

Create a Python 3.10+ environment for PDF indexing:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env
```

On Windows use `.venv\Scripts\python` instead. Add your Anthropic API key to `.env`. The server reads `ANTHROPIC_API_KEY` and uses **claude-fable-5-2** with low reasoning effort and structured output. Restart after changing the key. Keys remain server-side; `.env` is ignored by Git. Uploading a document sends that document to Anthropic and uses API credits. The initial synthetic collection does not trigger API calls.

The server discovers the local Python environment automatically; alternatively set `LEASE_PYTHON`. DOCX uploads additionally require [LibreOffice](https://www.libreoffice.org/download/download-libreoffice/); set `LEASE_SOFFICE` if it is not on PATH. Scanned image-only PDFs must be OCRed first.

## Use

- Click a cell to see its PDF page and highlighted quote. **Open window** opens a separate viewer.
- Switch between key terms, all 56 columns and grouped views; search, filter and sort.
- Corrections retain the original extracted value and evidence. Reviews and changes are recorded locally.
- Export includes the full register and a source-evidence sheet. Unknown amounts remain blank.
- Add PDF or DOCX documents up to 20 MB. The document is saved and indexed before extraction starts. Progress and processing time appear under Documents.
- Completed lease extractions add a register row. Supporting documents are classified and their findings retained for review; they do not silently amend an existing lease.
- Failed extractions keep the source document. Retry explicitly from Documents. Identical file uploads reuse the existing document and do not trigger a duplicate API call.

## Dataset and interpretation

The source files are the 20 PDFs in the repository's `PDFs/` directory. They replace the earlier blank MCL collection. The original PDF bytes and SHA-256 hashes are retained. `SYN-01` through `SYN-10` link each lease to its related deposit deed, alterations licence or assignment licence.

These are **synthetic examples**, not a verified live portfolio or independently labelled ground truth. Filled terms coexist with unresolved drafting alternatives. Signing, occupation, assignment completion, rent-review outcomes and cash deposits currently held are not assumed merely from a dated document. Original rent figures remain in the notes where the current reserved rent cannot be confirmed. Review dates are assessed as of **12 November 2026**. These assessments are a saved baseline, not a continuously updated asset-management feed.

All 56 columns retain the labels and order from `Draft_Rent_Roll_Columns_v3.xlsx`. The register distinguishes extracted facts, derived interpretations, unknowns and fields needing review. A blank does not mean zero. No floor area or rent-per-square-foot figure is invented when measurement evidence is absent.

Every saved evidence quote is checked against its document and one-based PDF page. This validates the citation, not the legal interpretation or completeness of the extraction. Initial extraction was performed by Astra; Fable is used only for new uploads. The underlying synthetic documents retain their source MCL markings. PDF.js's license is in `public/vendor/pdfjs/LICENSE`.

## Local API

POST bodies use JSON. All endpoints are served by the loopback-only dashboard.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/workspace` | Columns, rows, document metadata, local state and provider status |
| `GET /api/documents/:id` | Full document with page text, word coordinates and extraction status |
| `POST /api/upload` | `{ "name": "lease.pdf", "base64": "..." }`; saves/indexes then starts background extraction |
| `POST /api/documents/:id/extract` | Explicit extraction retry for a retained document |
| `POST /api/import` | `{ "rows": [...] }`; validates and appends provider-neutral extracted rows |
| `POST /api/cells` | Review or correct a cell, retaining its original source evidence |
| `GET /api/export.xlsx` | Register plus source evidence in Excel format |

Poll workspace/document status until an upload is `extracted`, `supporting_extracted`, `extraction_failed`, `awaiting_configuration` or `needs_ocr`. No paid retries run automatically.

Imported rows follow `public/data/extraction.json`. Every row must include all 56 keys (`c01`–`c56`); unknown values use `null`. Evidence uses `{documentId,page,quote}` with exact source text. Allowed statuses: `extracted`, `placeholder`, `optional`, `not_found`, `derived`, `needs_review`, `not_applicable`. Fable results are validated into this same contract. A wrong page can be corrected only where its exact quote occurs on exactly one other page; unsupported claims are flagged rather than accepted as cited facts.

## Development

| File | Responsibility |
| --- | --- |
| `public/app.js`, `public/styles.css` | Register, document library, review workflow |
| `public/pdf-viewer.js`, `public/viewer.js` | PDF rendering and quote highlighting |
| `server.mjs` | Local API, storage and extraction jobs |
| `fable-extractor.mjs` | Fable request, structured results and source validation |
| `upload_document.py` | PDF indexing and optional DOCX conversion |
| `export.mjs` | Excel export |
| `public/data/columns.json` | Stable workbook specification |
| `public/data/document-index.json` | Initial PDF text and coordinates |
| `public/data/extraction.json` | Astra's initial register |

Run `npm run check` for syntax validation, `npm run validate:data` for all source hashes and evidence anchors, and `npm test` for the mocked provider/server checks (Python with pdfplumber required). No frontend bundler is required.

Runtime settings: `PORT` (default `4173`), `LEASE_STORAGE_DIR` (default `storage/`), `LEASE_PYTHON`, `LEASE_SOFFICE`, `ANTHROPIC_API_KEY`. Local reviews, uploads, imports and exports are stored under the ignored `storage/` directory. Back it up to preserve local work. The checked-in baseline is never overwritten by reviews or imports.

## Gmail connection

The new **Email** tab connects directly to Gmail with Google OAuth. It is separate from the legacy `email-ingest/` module; that module is not started or reused.

### One-time Google setup

1. In a [Google Cloud project](https://console.cloud.google.com/apis/library/gmail.googleapis.com), enable the **Gmail API**.
2. Configure [Google Auth platform](https://console.cloud.google.com/auth/branding) with app name **Roll Model**. For personal Gmail, choose **External**, keep **Testing**, and add your Gmail address as a test user under **Audience**.
3. Under **Data Access**, add `https://www.googleapis.com/auth/gmail.readonly`.
4. Under **Clients**, create a **Desktop app** OAuth client and download its JSON file.
5. In Roll Model → **Email**, choose that JSON file, then **Connect Gmail**. Complete sign-in in the system browser that opens. The local callback returns to `http://127.0.0.1:4173/api/email/callback`.

The client file and tokens stay in ignored `storage/gmail/`, with private file permissions. They are not served to the frontend or committed to Git. Google grants read-only mailbox access; this app implements no sending, deletion or modification of Gmail messages. Google's testing-mode authorizations expire after seven days, so reconnect when prompted. Organization policies may restrict access. [Google setup guide](https://developers.google.com/workspace/guides/configure-oauth-consent), [testing restrictions](https://support.google.com/cloud/answer/15549945).

### Choose documents from mail

After connecting, Roll Model lists messages from the last 90 days with PDF/DOCX attachments. It checks for new mail once a minute while the Email tab is open and also offers Refresh and pagination. Listing requests only message headers and attachment descriptors; it does not send messages or attachments to Fable.

Click **Add to register** on an attachment to download that specific file, save its email provenance, and run the normal Fable workflow. Full leases create register rows; supporting documents retain their findings for review. Identical files are deduplicated across uploads and email imports. Added documents remain available after Gmail is disconnected.

Gmail API routes: `GET /api/email/status`, `POST /api/email/config` (`{client: <Google JSON>}`), `POST /api/email/connect`, OAuth authorize/callback routes, `GET /api/email/messages`, `POST /api/email/import` (`{messageId,attachmentId,email,connectionRevision}`; use the account and revision shown by the latest status/list response), and `POST /api/email/disconnect`. Client configuration and tokens are never returned by these routes.

The integration has mocked OAuth, Gmail and import tests. A real mailbox can only be verified after its owner supplies their OAuth client and completes Google consent.
