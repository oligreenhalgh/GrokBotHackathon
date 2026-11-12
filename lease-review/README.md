# Folio — lease review

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

The separate email module is **not connected or started by Folio**. This version uses manual document uploads only.
