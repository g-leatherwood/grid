package main

import (
	"fmt"
	"io"
	"os"
	"strings"
)

// logo is "grid" drawn in spreadsheet cells.
const logo = `                                          ┌──┐
                                          │  │
                           ┌──┐           ├──┤
                           │  │           │  │
   ┌──┬──┬──┐  ┌──┐  ┌──┐  └──┘     ┌──┬──┼──┤
   │  │  │  │  │  │  │  │           │  │  │  │
┌──┼──┴──┼──┤  ├──┼──┼──┘  ┌──┐  ┌──┼──┴──┼──┤
│  │     │  │  │  │  │     │  │  │  │     │  │
├──┤     ├──┤  ├──┼──┘     ├──┤  ├──┤     ├──┤
│  │     │  │  │  │        │  │  │  │     │  │
└──┼──┬──┼──┤  ├──┤        ├──┤  └──┼──┬──┼──┤
   │  │  │  │  │  │        │  │     │  │  │  │
   └──┴──┼──┤  └──┘        └──┘     └──┴──┴──┘
         │  │
┌──┬──┬──┼──┘
│  │  │  │
└──┴──┴──┘`

// printBanner shows the logo, the file and the address when grid starts.
// The logo is blue when the output is a terminal, unless NO_COLOR is set.
func printBanner(w io.Writer, path, url string) {
	blue, reset := "", ""
	if f, ok := w.(*os.File); ok && os.Getenv("NO_COLOR") == "" {
		if info, err := f.Stat(); err == nil && info.Mode()&os.ModeCharDevice != 0 {
			blue, reset = "\x1b[34m", "\x1b[0m"
		}
	}
	fmt.Fprintln(w)
	for _, line := range strings.Split(logo, "\n") {
		fmt.Fprintf(w, "  %s%s%s\n", blue, line, reset)
	}
	fmt.Fprintf(w, "\n  %s\n  %s\n\n  Ctrl+C to quit\n\n", path, url)
}
