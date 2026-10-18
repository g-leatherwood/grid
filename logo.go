package main

import (
	"fmt"
	"io"
	"os"
	"strings"
)

// logo is "grid" drawn in spreadsheet cells.
const logo = `                              ┌──┐           ┌──┐
                              │  │           │  │
                              └──┘           ├──┤
                                             │  │
   ┌──┬──┬──┐  ┌──┐  ┌──┬──┐  ┌──┐     ┌──┬──┼──┤
   │  │  │  │  │  │  │  │  │  │  │     │  │  │  │
┌──┼──┴──┼──┤  ├──┼──┼──┴──┘  ├──┤  ┌──┼──┴──┼──┤
│  │     │  │  │  │  │        │  │  │  │     │  │
├──┤     ├──┤  ├──┼──┘        ├──┤  ├──┤     ├──┤
│  │     │  │  │  │           │  │  │  │     │  │
└──┼──┬──┼──┤  ├──┤           ├──┤  └──┼──┬──┼──┤
   │  │  │  │  │  │           │  │     │  │  │  │
   └──┴──┼──┤  └──┘           └──┘     └──┴──┴──┘
         │  │
┌──┬──┬──┼──┘
│  │  │  │
└──┴──┴──┘`

// printBanner shows the logo, the file and the address when grid starts.
// The logo is bold cyan (the same as a Starship prompt's directory) when the
// output is a terminal, unless NO_COLOR is set.
func printBanner(w io.Writer, path, url string) {
	color, reset := "", ""
	if f, ok := w.(*os.File); ok && os.Getenv("NO_COLOR") == "" {
		if info, err := f.Stat(); err == nil && info.Mode()&os.ModeCharDevice != 0 {
			color, reset = "\x1b[1;36m", "\x1b[0m"
		}
	}
	fmt.Fprintln(w)
	for _, line := range strings.Split(logo, "\n") {
		fmt.Fprintf(w, "  %s%s%s\n", color, line, reset)
	}
	fmt.Fprintf(w, "\n  %s\n  %s\n\n  Ctrl+C to quit\n\n", path, url)
}
