# Folio — lease review

A local spreadsheet-style lease register with source-linked PDF evidence. This is the first working dashboard version: 56 workbook columns, 15 source documents, seven lease rows, 529 PDF pages and 386 evidence references.

## Run

Requires Node.js 22+.

```bash
npm ci
npm start
```

Open **http://127.0.0.1:4173**. No frontend build step or API key is needed.
The server binds to `127.0.0.1` only. Stop it with Control-C.

The prepared register, document viewer, corrections, review history, structured imports
and Excel export work with Node alone. PDF.js is bundled locally; Excel export uses ExcelJS.

### Enable new PDF uploads

Install Python 3.10+ and create a virtual environment inside this directory:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

On Windows, use `python -m venv .venv` and `.venv\Scripts\python -m pip install -r requirements.txt`.
The server finds this environment automatically. Alternatively set `LEASE_PYTHON` to your Python executable.

### Enable new DOCX uploads

Also install [LibreOffice](https://www.libreoffice.org/download/download-libreoffice/).
The helper looks for `soffice` or `libreoffice` on PATH and common macOS/Windows install locations.
Set `LEASE_SOFFICE` to the executable path if needed. Each conversion uses an isolated profile.

Existing included DOCX files have already been converted to PDFs, so LibreOffice is only
needed for **new DOCX uploads**. Scanned image-only PDFs need OCR before text evidence can be extracted.

## Use

- Click a cell to see its source document, page and highlighted quotation. Use **Open window** for a separate PDF viewer.
- Switch between key terms, all 56 columns and grouped views. Search, filter and sort the register.
- **Edit value** preserves the original extraction and evidence. **Restore extraction** removes a correction.
- **Mark reviewed** records a review decision. Activity records local changes.
- **Export workbook** includes all 56 fields plus source evidence and review details. Unknown amounts stay blank; zero remains numeric zero.
- **Add documents** indexes PDF/DOCX files up to 20 MB. New files stay **Awaiting extraction** until structured results are imported.

The initial extraction was prepared by Codex. This version does not call Grok or any model API.

## Dataset limitations

These are uncompleted Model Commercial Lease templates, not executed leases or an occupied
portfolio. Names, addresses, rents and dates often contain placeholders; optional clauses
have not been selected. Do not interpret blanks as zero or an optional clause as agreed.
The eight supporting templates are retained in the library and are **not** assumed to amend any of the seven leases.

The register retains the labels and order from `Draft_Rent_Roll_Columns_v3.xlsx`.
Source checks verify references against document text; they are not a measured extraction
accuracy score against independent human labels. PDF page numbers refer to the included
DOCX-to-PDF conversions.

The source documents' [original README](public/documents/originals/00-START-HERE.md),
source URLs and checksums are retained. MCL templates remain subject to the
[MCL conditions of use](https://www.modelcommerciallease.co.uk/conditions-of-use/).
PDF.js's license is in `public/vendor/pdfjs/LICENSE`.

## API and extraction contract

All requests are local. POST requests use `Content-Type: application/json`.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/workspace` | 56-column schema, rows, document metadata, local state and provider description |
| `GET /api/documents/:id` | Full document with page text and word coordinates |
| `POST /api/upload` | `{ "name": "lease.pdf", "base64": "..." }`; returns indexed document metadata and its ID |
| `POST /api/import` | `{ "rows": [...] }`; validates and appends extracted rows |
| `POST /api/cells` | `{ "rowId": "...", "columnId": "c35", "value": 100000, "note": "...", "reviewed": true }` |
| `GET /api/export.xlsx` | Current register plus evidence as an Excel workbook |

Imported rows use the structure in [`public/data/extraction.json`](public/data/extraction.json):

```json
{
  "id": "unique-lease-id",
  "documentId": "upload-id-returned-by-upload",
  "title": "Lease title",
  "category": "office",
  "cells": {
    "c35": {
      "value": 100000,
      "status": "extracted",
      "explanation": "Annual main rent stated in the lease.",
      "evidence": [
        { "documentId": "upload-id-returned-by-upload", "page": 10, "quote": "Exact source text" }
      ]
    }
  }
}
```

This snippet shows one field; **every imported row must include all of `c01` through `c56`**.
Use `null` for unknown values, with an explanation and an empty evidence array when no source supports the field.
Allowed statuses: `extracted`, `placeholder`, `optional`, `not_found`, `derived`, `needs_review`, `not_applicable`.
Row IDs must be unique. Sources must already exist; page numbers are one-based. Quotes must
match the specified page (whitespace is normalized). Word coordinates use PDF points from the top left.

Suggested property categories are `office`, `retail`, `logistics` and `food-and-drink`, matching
the UI filters. The dashboard accepts other category strings but the fixed category filter
would need extending for them.

A future provider should return this schema. Keep API keys on the server and outside Git.
The inbox module can upload its stored PDF, retain the returned document ID, then pass
provider results through this import contract. This bridge is not implemented in this version.

## Code map

| File | Responsibility |
| --- | --- |
| `public/app.js`, `public/styles.css` | Grid, document library, review workflow and local UI |
| `public/pdf-viewer.js`, `public/viewer.js` | PDF rendering, page navigation and quote highlighting |
| `server.mjs` | Local HTTP API, validation, storage and static assets |
| `upload_document.py` | PDF text/coordinate indexing and DOCX conversion |
| `export.mjs` | Excel workbook and source-evidence export |
| `public/data/columns.json` | Stable 56-field schema |
| `public/data/document-index.json` | Prepared page text and word coordinates |
| `public/data/extraction.json` | Prepared source extraction |

`npm run check` checks JavaScript syntax. No frontend bundler is required.

Runtime settings: `PORT` (default `4173`), `LEASE_STORAGE_DIR` (default `storage/`),
`LEASE_PYTHON`, `LEASE_SOFFICE`.
Review state, imports, uploads and temporary exports live under `storage/`, which is ignored.
Back up that directory to preserve local work. The checked-in baseline is never overwritten by edits.
