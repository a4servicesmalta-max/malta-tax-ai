# Fetching real corpus fixtures (sensitive — never commit)

Fixtures live in `fixtures/` (gitignored). Source: Dropbox `/Tax Returns Consolidated`
(347 filed returns, 66 clients) and `/Clients/Current clients/<name>` audit files (ETBs).

Recommended sets:
- **Replay pairs (consecutive years):** MGW Investments Limited (TR 997823415 YA2021–YA2026),
  Gatt & elmer (TR 997761312 YA2017–YA2023).
- **Current template structure:** New Way Trading Ltd `TR 971913522 YA2025 (1).xlsx`.
- **ETBs:** search the same client folder's audit-year subfolders for `ETB*.xlsx` / `*trial balance*`.

How to fetch (Dropbox MCP cannot write binaries locally — use temporary links):
1. In a Claude session with the Dropbox connector: call `download_link` for each file id/path.
2. `curl -L -o "fixtures/<name>.xlsx" "<temporary link>"` (links are single-use, expire fast).

Layout expected by tests/replay:
fixtures/
  returns/<Client>/<original filename>.xlsx
  etb/<Client>/<year>.xlsx
  blank-template.xlsx        # current-year blank CfR template (from cfr.gov.mt or firm copy)
