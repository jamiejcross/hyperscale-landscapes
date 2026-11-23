# Contributing

Thank you for helping. This project serves communities who are scrutinising
proposed data centres. Accuracy and care matter more than speed.

## Ground rules

- **No invented data.** Every site field needs a source URL and an access
  date. If you can't source it, leave it empty and add it to
  `data/sites/TODO.md`.
- **No personal data.** Record only corporate and planning information. Never
  record names, addresses or contact details of residents, objectors or
  officials.
- **Disclose exaggeration.** Any export path you add must carry the caption
  and attribution (see `provenance.py` and `exaggeration_note`).
- **British English** in code comments, the UI and the docs.

## Suggesting a site

Use the "Suggest a site" issue form and include links to the planning portal,
news reports or developer documents.

## Code

```bash
uv venv && uv pip install -e "pipeline[dev,uk]"
HYPERSCALE_OFFLINE=1 pytest pipeline/tests      # must pass with no network
```

The geometry code carries hard-won lessons (polygon winding, river buffers,
sliver filtering, export precision). Read PLAN.md §5 before changing
`geometry/` or `pipeline.py`, and keep the parity and geometry tests passing.
Keep each commit to one logical change, and never commit build outputs or any
file over 5 MB.
