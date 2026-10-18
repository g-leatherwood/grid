# Contributing to grid

Bug reports, ideas and pull requests are welcome. For anything bigger than a small fix, open an issue first so we can agree on the approach.

## Run it

```sh
go test ./...
go run . some.csv
```

## How the code is laid out

| File | What it does |
| --- | --- |
| `main.go` | Command-line flags, starting the server, opening the browser, Ctrl+C handling |
| `server.go` | The local HTTP API the page talks to, the per-run token and host checks, and the event stream that tells the page when grid quits |
| `doc.go` | Loading and saving CSV and xlsx files, and applying edits (set, insert, delete, sort) to them |
| `logo.go` | The logo printed in the terminal at startup. The README shows the same logo, and a test keeps the two identical |
| `web/` | The page: plain HTML, CSS and JavaScript with no build step |

The page keeps its own copy of the sheet, applies each edit right away, and sends it to the server as an op. The server applies the same op to the file in memory, sends back anything that changed as a side effect (such as recalculated formulas), and writes the file only when you save.

`web/` is embedded in the binary when it's built, so rebuild or rerun `go run` after changing it.

## Before sending a change

- `go vet ./...` and `go test ./...` pass. CI runs both on every push and pull request.
- If you change file handling in `doc.go`, add a test in `doc_test.go` that round-trips a file.
- If you change behavior someone would notice, update the README.

## Releasing

Maintainers publish a release by pushing a version tag. GitHub Actions then builds the downloads for every platform with [GoReleaser](https://goreleaser.com) and attaches them to a GitHub release.

1. Change the version in the bottom line of the logo in `README.md` to the new one. `go test ./...` checks the rest of the logo still matches what grid prints, and prints the correct logo if it doesn't.
2. Commit, then tag and push:

   ```sh
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

The release stops before building anything if the README logo doesn't show the version being released.

The archive names don't include the version, so the README's `releases/latest/download/...` links always point to the newest release.
